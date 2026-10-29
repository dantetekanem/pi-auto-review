import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestBytes } from './experiments-contract.ts';
import { approveTrustedReplay, describeReplay, runTrustedReplay, type ReplayRequest } from './experiments-replay.ts';
import { approveRestricted, describeRestricted, type RestrictedRequest } from './experiments-restricted-contract.ts';
import { runRestrictedNode } from './experiments-node.ts';
import { canonicalSha256 } from './experiments-oracle.ts';
import { readRestrictedAttempt } from './experiments-comparison.ts';
import { validatePreparedFamily, runPreparedFamily, type PreparedFamily } from './experiments-family.ts';
import { ExperimentReservations, experimentKey } from './experiments-reservations.ts';
import { runWorkerBatch } from './experiments-workers.ts';

type Bootstrap = { path?: string; sha256?: string };
type PlanIdentity = { expiresAt: string; target: string; checkout: string; base: string; head: string };
type ApprovedPlan = PlanIdentity & (
  | { schemaVersion: 1; checks: { id: string; maxAttempts: number; request: Omit<ReplayRequest, 'runId'> }[] }
  | { schemaVersion: 2; scope: 'worker-only'; familySha256: string; family?: PreparedFamily; workers?: number;
      budget: { maxAttempts: number; maxWallMs: number; maxOutputBytes: number };
      checks: { id: string; maxAttempts: number; request: Omit<RestrictedRequest, 'runId'> }[] }
);
type BoundCheck = { request: ReplayRequest | RestrictedRequest; grant: unknown; remaining: number };
type ReceiptReference = { checkId: string; path: string; sha256: string };
const artifactDirectory = (root: string, sessionId: string, runId: string) =>
  join(existsSync(root) ? realpathSync(root) : root, sessionId, `${runId}.experiments`);

function assertIdentity(sessionId: string, runId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    throw new Error('Invalid experiment review identity.');
  }
}

function boundedRead(path: string, maxBytes: number) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.size > maxBytes) throw new Error('Unsupported experiment artifact.');
  const bytes = readFileSync(path);
  if (bytes.length > maxBytes) throw new Error('Experiment artifact grew past its limit.');
  return bytes;
}

function loadPlan(bootstrap: Bootstrap): ApprovedPlan | undefined {
  if (!bootstrap.path && !bootstrap.sha256) return undefined;
  if (!bootstrap.path || !isAbsolute(bootstrap.path) || !/^[a-f0-9]{64}$/.test(bootstrap.sha256 ?? '')) {
    throw new Error('Invalid host-approved replay plan configuration.');
  }
  const bytes = boundedRead(bootstrap.path, 1048576);
  if (digestBytes(bytes) !== bootstrap.sha256) throw new Error('Host replay plan identity changed.');
  const plan: ApprovedPlan = JSON.parse(bytes.toString('utf8'));
  if (![1, 2].includes(plan?.schemaVersion) || typeof plan.target !== 'string' || !plan.target || plan.target.length > 4000
    || typeof plan.checkout !== 'string' || !isAbsolute(plan.checkout)
    || !/^[a-f0-9]{40,64}$/.test(plan.base) || !/^[a-f0-9]{40,64}$/.test(plan.head)
    || typeof plan.expiresAt !== 'string' || !Number.isFinite(Date.parse(plan.expiresAt))
    || !Array.isArray(plan.checks) || plan.checks.length < 1 || plan.checks.length > (plan.schemaVersion === 2 ? 128 : 6)) {
    throw new Error('Invalid host-approved replay plan.');
  }
  if (plan.schemaVersion === 2 && (plan.scope !== 'worker-only' || !/^[a-f0-9]{64}$/.test(plan.familySha256)
    || !plan.budget || Object.entries({ maxAttempts: 64, maxWallMs: 600000, maxOutputBytes: 16777216 }).some(([key, cap]) => {
      const value = plan.budget[key as keyof typeof plan.budget];
      return !Number.isSafeInteger(value) || value < 1 || value > cap;
    }))) throw new Error('Unsupported restricted plan scope or budget. Ordinary Pi sessions are not sandboxed.');
  if ('workers' in plan && (plan.schemaVersion !== 2 || !Number.isInteger(plan.workers)
    || ![1, 2].includes(plan.workers ?? 0) || (plan.family && plan.workers !== 1))) {
    throw new Error('Only restricted check batches support one or two host-selected workers.');
  }
  const ids = new Set<string>();
  let totalAttempts = 0;
  for (const check of plan.checks) {
    if (!/^[\w-]{1,80}$/.test(check.id) || ids.has(check.id)
      || !Number.isSafeInteger(check.maxAttempts) || check.maxAttempts < 1 || check.maxAttempts > (plan.schemaVersion === 2 ? 64 : 10)) {
      throw new Error('Invalid approved replay check.');
    }
    ids.add(check.id);
    totalAttempts += check.maxAttempts;
    if (check.request.profile === 'trusted-program' && plan.schemaVersion === 1) {
      describeReplay({ ...check.request, runId: 'bootstrap' });
      if (![plan.base, plan.head].includes(check.request.revision) || resolve(check.request.cwd) !== resolve(plan.checkout)) {
        throw new Error('Approved check does not match the review.');
      }
    } else if (check.request.profile === 'docker-node-v1' && plan.schemaVersion === 2) {
      describeRestricted({ ...check.request, runId: 'bootstrap' });
      if (![plan.base, plan.head].includes(check.request.source.revision) || resolve(check.request.source.repository) !== resolve(plan.checkout)) {
        throw new Error('Restricted check does not match the review.');
      }
    } else throw new Error('Unsupported check profile for this host plan.');
  }
  if (plan.schemaVersion === 2 && plan.family) {
    if (plan.familySha256 !== canonicalSha256(plan.family)) throw new Error('Prepared family identity does not match the plan.');
    validatePreparedFamily(plan.family, new Map(plan.checks.map(check => [check.id, { ...check.request, runId: 'bootstrap' }])));
  }
  if (plan.schemaVersion === 1 && totalAttempts > 10) throw new Error('Approved replay plan exceeds ten attempts.');
  return plan;
}

/** Completion links only receipts recorded by this runner, never agent-supplied paths. */
export function readExecutionReceipts(root: string, sessionId: string, runId: string): ReceiptReference[] {
  assertIdentity(sessionId, runId);
  const directory = artifactDirectory(root, sessionId, runId);
  const index = join(directory, 'index.jsonl');
  if (!existsSync(index)) return [];
  const lines = boundedRead(index, 65536).toString('utf8').trim().split('\n');
  if (lines.length > 65) throw new Error('Too many execution receipts.');
  return lines.map(line => {
    const entry = JSON.parse(line);
    if (!/^[\w-]{1,80}$/.test(entry.checkId) || !/^(?:replay|restricted|family|batch)-[A-Za-z0-9]{6}\/receipt\.json$/.test(entry.path)
      || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid execution receipt reference.');
    const path = join(directory, entry.path);
    const bytes = boundedRead(path, 1048576);
    if (digestBytes(bytes) !== entry.sha256 || JSON.parse(bytes.toString('utf8')).runId !== runId) {
      throw new Error('Execution receipt identity changed.');
    }
    return { checkId: entry.checkId, path, sha256: entry.sha256 };
  });
}

/** Host launch configuration authorizes prepared checks, never the whole Pi session. */
export function registerExperiments(
  pi: ExtensionAPI,
  root: string,
  bootstrap: Bootstrap = { path: process.env.PI_AUTO_REVIEW_REPLAY_PLAN, sha256: process.env.PI_AUTO_REVIEW_REPLAY_SHA256 },
): (ctx: ExtensionContext, sessionId: string, runId: string) => string[] {
  // Capture once, before model turns. Tool arguments cannot replace this snapshot.
  bootstrap = { ...bootstrap };
  let plan: ApprovedPlan | undefined;
  let problem: string | undefined;
  try {
    plan = loadPlan(bootstrap);
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  let owner: string | undefined;
  let boundReview: string | undefined;
  const grants = new Map<string, BoundCheck>();
  const reservations = new ExperimentReservations();
  const lastAttempts = new Map<string, string>();
  const activeSlots = new Set<number>();
  let familyActive = false;
  let familyConsumed = false;
  let batchActive = false;
  let batchConsumed = false;
  pi.on('session_start', (_event, ctx) => {
    if (!owner && ctx.hasUI) owner = ctx.sessionManager.getSessionId();
  });

  function assertReview(ctx: ExtensionContext, sessionId: string, runId: string, approved: ApprovedPlan) {
    if (!ctx.hasUI || !owner || ctx.sessionManager.getSessionId() !== owner) {
      throw new Error('Only the original UI owner session can execute approved checks.');
    }
    if (Date.now() >= Date.parse(approved.expiresAt)) throw new Error('Host replay plan expired.');
    const review = JSON.parse(boundedRead(join(root, sessionId, `${runId}.review.json`), 1048576).toString('utf8'));
    if (review.sessionId !== sessionId || review.runId !== runId || !['prepared', 'running'].includes(review.status)
      || review.preflight?.target !== approved.target || review.preflight?.base !== approved.base
      || review.preflight?.head !== approved.head || review.preflight?.checkout !== approved.checkout
      || resolve(ctx.cwd) !== resolve(approved.checkout)) throw new Error('Host plan does not match this active review.');
    if (boundReview && boundReview !== `${sessionId}/${runId}`) throw new Error('Host plan is bound to another review run.');
  }

  pi.registerTool({
    name: 'agentic_code_review_execute_experiment',
    label: 'Execute approved review experiment',
    description: readFileSync(fileURLToPath(new URL('../prompts/execute-experiment.md', import.meta.url)), 'utf8').trim(),
    executionMode: 'sequential',
    parameters: Type.Object({
      sessionId: Type.String({ maxLength: 128 }),
      runId: Type.String(),
      checkId: Type.Optional(Type.String({ maxLength: 80, description: 'Host-prepared check ID. Omit all selectors to list availability.' })),
      checkIds: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { minItems: 1, maxItems: 64,
        description: 'One finite batch of distinct host-approved restricted checks. Worker count comes only from the host plan.' })),
      familyId: Type.Optional(Type.String({ maxLength: 80, description: 'Run one host-prepared finite family, including its controls, without per-trial model turns.' })),
      replayOf: Type.Optional(Type.String({ maxLength: 36, description: 'For a deliberate fresh check replay, name its latest settled attempt ID. Consumes the existing budget.' })),
    }, { additionalProperties: false }),
    async execute(_id, input, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (Object.keys(input).some(key => !['sessionId', 'runId', 'checkId', 'checkIds', 'familyId', 'replayOf'].includes(key))) throw new Error('Unexpected execution argument.');
      const { sessionId, runId, checkId, checkIds, familyId, replayOf } = input;
      if ([checkId, checkIds, familyId].filter(value => value !== undefined).length > 1) throw new Error('Use only one execution selector.');
      if (replayOf !== undefined && (checkId === undefined || !/^[0-9a-f-]{36}$/.test(replayOf))) throw new Error('A replay needs a check ID and prior attempt ID.');
      if (familyActive || batchActive) throw new Error('A prepared family or batch is already active.');
      assertIdentity(sessionId, runId);
      if (!plan) {
        const reason = problem ?? 'No host-approved replay plan is configured.';
        if (checkId !== undefined || checkIds !== undefined || familyId !== undefined) throw new Error(reason);
        return { content: [{ type: 'text' as const, text: reason }], details: { available: false, reason } };
      }
      assertReview(ctx, sessionId, runId, plan);
      if (checkId === undefined && checkIds === undefined && familyId === undefined) {
        const checks = plan.checks.map(check => ({ id: check.id,
          revision: check.request.profile === 'docker-node-v1' ? check.request.source.revision : check.request.revision,
          maxAttempts: check.maxAttempts }));
        const details = { available: true, profile: plan.schemaVersion === 2 ? 'docker-node-v1' : 'trusted-program',
          scope: plan.schemaVersion === 2 ? 'worker-only' : 'trusted-host', sandboxed: false, checks,
          workers: plan.schemaVersion === 2 ? plan.workers ?? 1 : 1,
          families: plan.schemaVersion === 2 && plan.family ? [{ id: plan.family.id, seed: plan.family.spec.seed, trials: plan.family.spec.trials }] : [] };
        return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
      }
      if (checkId !== undefined && !plan.checks.some(check => check.id === checkId)) throw new Error('Unknown approved check ID.');
      if (familyId !== undefined && (plan.schemaVersion !== 2 || plan.family?.id !== familyId)) throw new Error('Unknown prepared family ID.');
      if (familyId !== undefined && familyConsumed) throw new Error('Prepared family was already consumed.');
      let batchCheckIds: string[] | undefined;
      if (checkIds !== undefined) {
        if (plan.schemaVersion !== 2 || plan.family) throw new Error('Batches require a restricted check plan without a family.');
        if (batchConsumed) throw new Error('Prepared batch was already consumed.');
        if (activeSlots.size) throw new Error('A restricted worker resource is already active.');
        if (!Array.isArray(checkIds) || !checkIds.length || checkIds.length > 64
          || new Set(checkIds).size !== checkIds.length) throw new Error('Invalid or duplicate batch check IDs.');
        const requestKeys = checkIds.map(id => {
          const check = plan.checks.find(item => item.id === id);
          if (!check) throw new Error('Unknown approved batch check ID.');
          return experimentKey({ ...check.request, runId }, plan.familySha256);
        });
        if (new Set(requestKeys).size !== requestKeys.length) throw new Error('Duplicate canonical inputs in batch.');
        batchCheckIds = [...checkIds];
      }
      if (!boundReview) {
        // Exclusive, durable consumption prevents reloads or another process refreshing budgets.
        try {
          const reservation = { owner, sessionId, runId, sha256: bootstrap.sha256 };
          writeFileSync(`${bootstrap.path}.claimed`, JSON.stringify(reservation), { flag: 'wx', mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Host replay plan was already consumed.');
          throw error;
        }
        boundReview = `${sessionId}/${runId}`;
        const approvedBy = `host-plan:${bootstrap.sha256}:owner:${owner}`;
        if (plan.schemaVersion === 2) {
          const requests = plan.checks.map(check => describeRestricted({ ...check.request, runId }).request);
          const grant = approveRestricted(requests, { ...plan.budget, approvedBy, familySha256: plan.familySha256,
            maxConcurrency: plan.workers ?? 1, expiresAt: Date.parse(plan.expiresAt) });
          plan.checks.forEach((check, index) => grants.set(check.id, { request: requests[index], grant, remaining: check.maxAttempts }));
        } else {
          for (const check of plan.checks) {
            const request = describeReplay({ ...check.request, runId }).request;
            const grant = approveTrustedReplay(request, { approvedBy, maxAttempts: check.maxAttempts });
            grants.set(check.id, { request, grant, remaining: check.maxAttempts });
          }
        }
      }
      const directory = artifactDirectory(root, sessionId, runId);
      const expiresAt = Date.parse(plan.expiresAt);
      const oracleIdentity = plan.schemaVersion === 2 ? plan.familySha256 : canonicalSha256(plan);
      const recordReference = (id: string, path: string, reservation?: { experimentKey: string; replayOf?: string }) => {
        const reference = { checkId: id, path: relative(directory, path), sha256: digestBytes(readFileSync(path)), ...reservation };
        try {
          appendFileSync(join(directory, 'index.jsonl'), JSON.stringify(reference) + '\n', { mode: 0o600 });
        } catch (error) {
          throw new Error(`Execution finished at ${path}, but its index could not be saved: ${String(error)}. Do not retry automatically.`);
        }
        return { path, sha256: reference.sha256 };
      };
      const workers = plan.schemaVersion === 2 ? plan.workers ?? 1 : 1;
      const executeCheck = async (id: string, slot = 0, executionSignal = signal) => {
        executionSignal?.throwIfAborted();
        const approved = grants.get(id);
        if (!approved) throw new Error('Approved check grant is unavailable.');
        if (approved.remaining === 0) throw new Error('Approved check attempts exhausted.');
        if (activeSlots.has(slot)) throw new Error('Restricted worker resource is already leased.');
        const key = experimentKey(approved.request, oracleIdentity, batchCheckIds && workers > 1 ? 'parallel-2-v1' : 'serial-v1');
        // A prepared family deliberately repeats checks for stability and fresh replay.
        const predecessor = familyId === undefined ? replayOf : lastAttempts.get(key);
        const reservation = reservations.reserve(key, expiresAt, predecessor);
        approved.remaining--;

        const execute = async () => {
          if (approved.request.profile === 'trusted-program') {
            return runTrustedReplay(approved.request, approved.grant, directory, { signal: executionSignal });
          }
          activeSlots.add(slot);
          try {
            const guard = `${bootstrap.path}.active${batchCheckIds && workers > 1 ? `-${slot}` : ''}`;
            const result = await runRestrictedNode(approved.request, approved.grant, directory, guard, executionSignal);
            return result.receipt;
          } finally {
            activeSlots.delete(slot);
          }
        };
        try {
          const receipt = await execute();
          const reference = recordReference(id, receipt.paths.receipt, { experimentKey: key, ...(predecessor ? { replayOf: predecessor } : {}) });
          reservations.settle(reservation, { attemptId: receipt.attemptId,
            cleanupConfirmed: receipt.cleanup === 'container-removed' || receipt.cleanup === 'workspace-removed' });
          lastAttempts.set(key, receipt.attemptId);
          return { receipt, reference };
        } catch (error) {
          reservations.fence(reservation);
          throw error;
        }
      };
      let details;
      if (batchCheckIds) {
        batchConsumed = true;
        batchActive = true;
        try {
          const result = await runWorkerBatch(batchCheckIds, workers, async (id, slot, workerSignal) => {
            const { receipt, reference } = await executeCheck(id, slot, workerSignal);
            return { attemptId: receipt.attemptId, status: receipt.status, cleanup: receipt.cleanup, reference };
          }, signal);
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          const receiptPath = join(mkdtempSync(join(directory, 'batch-')), 'receipt.json');
          const receipt = {
            ...result,
            schemaVersion: 1,
            profile: 'experiment-batch-v1',
            sessionId,
            runId,
            checkIds: batchCheckIds,
            planSha256: bootstrap.sha256,
            paths: { receipt: receiptPath },
            requirementTruthEstablished: false,
            formalProof: false,
          };
          writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          const reference = recordReference('batch', receiptPath);
          details = { receipt, receiptSha256: reference.sha256 };
        } finally {
          batchActive = false;
        }
      } else if (familyId !== undefined && plan.schemaVersion === 2 && plan.family) {
        familyConsumed = true;
        familyActive = true;
        try {
          const requests = new Map([...grants].map(([id, check]) => [id, check.request as RestrictedRequest]));
          const result = await runPreparedFamily(plan.family, requests, async id => {
            const result = await executeCheck(id);
            return readRestrictedAttempt(result.reference);
          }, signal);
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          const receiptPath = join(mkdtempSync(join(directory, 'family-')), 'receipt.json');
          const receipt = {
            ...result,
            schemaVersion: 1,
            profile: 'experiment-family-v1',
            sessionId,
            runId,
            familyId,
            familySha256: plan.familySha256,
            paths: { receipt: receiptPath },
          };
          writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          const reference = recordReference(familyId, receiptPath);
          details = { familyId, receipt, receiptSha256: reference.sha256 };
        } finally {
          familyActive = false;
        }
      } else {
        const result = await executeCheck(checkId!);
        details = { checkId, receipt: result.receipt, receiptSha256: result.reference.sha256 };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
    },
  });
  return (ctx, sessionId, runId) => {
    if (plan?.schemaVersion !== 2 || !plan.family || familyConsumed || familyActive || batchActive || activeSlots.size
      || (!boundReview && existsSync(`${bootstrap.path}.claimed`))) return [];
    try {
      assertIdentity(sessionId, runId);
      assertReview(ctx, sessionId, runId, plan);
      return [plan.family.id];
    } catch { return []; }
  };
}
