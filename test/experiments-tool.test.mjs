import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareNodeExperiment, prepareOracle, syntheticAttempt, finding, baseRevision, headRevision } from './experiments-helpers.mjs';
import { readRestrictedAttempt, comparisonContext } from '../src/experiments-comparison.ts';
import { generateFindingFamily, enumerateFamilyInputs } from '../src/experiments-family.ts';
import { canonicalSha256 } from '../src/experiments-oracle.ts';
import { memberOrderIdentity, prepareMemberOrderPair } from '../src/experiments-metamorphic.ts';
import { reductionIdentity } from '../src/experiments-reduce.ts';

const require = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url);
const { registerExperiments, readExecutionReceipts } = await jiti.import('../src/experiments-tool.ts');
const { registerReview } = await jiti.import('../src/index.ts');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const executableHash = hash(readFileSync(process.execPath));
const runId = '11111111-1111-4111-8111-111111111111';

function fixture(t, planChanges = {}, artifactRoot) {
  const root = artifactRoot ?? mkdtempSync(join(tmpdir(), 'autoreview-tool-'));
  if (artifactRoot) mkdirSync(root);
  else t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = join(root, 'reviews');
  const script = join(root, 'check.mjs');
  const source = "console.log('RUNTIME pinned-node\\nPASS value ok\\nRESULT 1 cases, 0 failures');";
  writeFileSync(script, source);
  const plan = {
    schemaVersion: 1,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    target: 'https://github.com/rails/rails/pull/59383', checkout: root,
    base: 'a'.repeat(40), head: 'b'.repeat(40),
    checks: [{
      id: 'head', maxAttempts: 2,
      request: {
        profile: 'trusted-program', revision: 'b'.repeat(40), executable: process.execPath,
        script: 'check.mjs', args: [], cwd: root, environment: {},
        files: [{ path: script, sha256: hash(source), copyAs: 'check.mjs' }, { path: process.execPath, sha256: executableHash }],
        headers: ['RUNTIME pinned-node'], cases: [{ id: 'value' }],
        limits: { timeoutMs: 2000, maxOutputBytes: 4096 },
      },
    }],
    ...planChanges,
  };
  const planPath = join(root, 'approved-plan.json');
  const encoded = JSON.stringify(plan);
  writeFileSync(planPath, encoded, { mode: 0o600 });
  const bootstrap = { path: planPath, sha256: hash(encoded) };
  const reviewPath = join(storage, 'owner', `${runId}.review.json`);
  mkdirSync(join(storage, 'owner'), { recursive: true });
  const review = { sessionId: 'owner', runId, status: 'prepared', preflight: { target: plan.target, checkout: root, base: plan.base, head: plan.head } };
  writeFileSync(reviewPath, JSON.stringify(review));
  review.preflight.checkout = plan.checkout;
  writeFileSync(reviewPath, JSON.stringify(review));
  const ctx = { cwd: plan.checkout, hasUI: true, sessionManager: { getSessionId: () => 'owner' } };
  function load(config = bootstrap) {
    const tools = new Map();
    const events = new Map();
    registerExperiments({ registerTool: tool => tools.set(tool.name, tool), on: (name, handler) => events.set(name, handler) }, storage, config);
    events.get('session_start')({}, ctx);
    const tool = tools.get('agentic_code_review_execute_experiment');
    const invoke = (input = {}, context = ctx, signal) => tool.execute('call', { sessionId: 'owner', runId, ...input }, signal, undefined, context);
    return { tool, invoke };
  }
  return { root, storage, plan, bootstrap, planPath, reviewPath, review, ctx, load, script };
}

test('registered tool lists pinned checks, executes one, and saves machine-linked receipts for fresh replay', async t => {
  const f = fixture(t);
  const { tool, invoke } = f.load();
  assert.equal(tool.executionMode, 'sequential');
  const listed = await invoke();
  assert.deepEqual(listed.details.checks.map(check => check.id), ['head']);
  const first = await invoke({ checkId: 'head' });
  await assert.rejects(invoke({ checkId: 'head' }), /explicit replay/i);
  const second = await invoke({ checkId: 'head', replayOf: first.details.receipt.attemptId });
  assert.equal(first.details.receipt.observation, 'passed');
  assert.notEqual(first.details.receipt.attemptId, second.details.receipt.attemptId);
  const receipts = readExecutionReceipts(f.storage, 'owner', runId);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].checkId, 'head');
  assert.equal(receipts[0].sha256, hash(readFileSync(receipts[0].path)));
  await assert.rejects(invoke({ checkId: 'head', replayOf: second.details.receipt.attemptId }), /exhausted/);
  await assert.rejects(f.load().invoke({ checkId: 'head' }), /consumed/);

  const nodes = [{ id: 'observed', kind: 'evidence', identities: [{ kind: 'source', key: 'request', sha256: first.details.receipt.requestDigest }] },
    { id: 'support', kind: 'support', dependsOn: ['observed'] }, { id: 'claim', kind: 'claim', supports: ['support'] }];
  writeFileSync(join(f.storage, 'owner', `${runId}.map.jsonl`), nodes.map(node => JSON.stringify({ id: node.id, runId, state: 'observed' })).join('\n'));
  writeFileSync(f.reviewPath, JSON.stringify({ ...f.review, status: 'complete', completedAt: '2026-10-27T00:00:00Z',
    evidenceGraph: { schemaVersion: 1, runId, nodes, incompatibilities: [] },
    evidenceContext: { identities: nodes[0].identities, scopes: [] },
    machineClaims: [{ claimId: 'claim', kind: 'execution', requestDigest: first.details.receipt.requestDigest, receipts: [receipts[0].sha256] }] }));
  const completionTools = new Map();
  registerReview({ registerTool: tool => completionTools.set(tool.name, tool), registerCommand() {}, on() {} }, f.storage);
  const complete = signal => completionTools.get('agentic_code_review_complete').execute('complete',
    { sessionId: 'owner', runId, summary: 'Observed passing target.' }, signal);
  const pending = complete();
  writeFileSync(f.reviewPath, JSON.stringify({ ...JSON.parse(readFileSync(f.reviewPath, 'utf8')), problem: 'Updated during receipt verification.' }));
  await assert.rejects(pending, /changed/i);
  assert.equal(JSON.parse(readFileSync(f.reviewPath, 'utf8')).problem, 'Updated during receipt verification.');

  const cancellation = new AbortController();
  const cancelled = complete(cancellation.signal);
  cancellation.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(existsSync(join(f.storage, 'owner', `${runId}.complete.json`)), false);
  await complete();
  assert.equal(JSON.parse(readFileSync(f.reviewPath, 'utf8')).machineAssessment[0].status, 'observed-pass');
  assert.equal(readExecutionReceipts(f.storage, 'owner', runId).length, 2);
  const receiptPath = receipts[0].path;
  writeFileSync(receiptPath, '{}');
  assert.throws(() => readExecutionReceipts(f.storage, 'owner', runId), /receipt/i);
});

test('rejects missing, forged, wrong-session and wrong-review authority without starting a program', async t => {
  const f = fixture(t);
  assert.equal((await f.load({}).invoke()).details.available, false);
  await assert.rejects(f.load({}).invoke({ checkId: 'head', approved: true }), /argument|plan/i);
  await assert.rejects(f.load({}).invoke({ checkId: 'head' }), /plan/i);
  const { invoke } = f.load();
  await assert.rejects(invoke({ replayOf: 'missing' }), /replay/i);
  await assert.rejects(invoke({ checkId: 'head', approvedBy: 'user' }), /argument/);
  await assert.rejects(invoke({ checkId: 'head' }, { ...f.ctx, hasUI: false }), /owner|UI/);
  await assert.rejects(invoke({ checkId: 'head' }, { ...f.ctx, sessionManager: { getSessionId: () => 'worker' } }), /owner/);
  await assert.rejects(invoke({ checkId: '../shell' }), /check/i);
  writeFileSync(f.reviewPath, JSON.stringify({ ...f.review, preflight: { ...f.review.preflight, head: 'c'.repeat(40) } }));
  await assert.rejects(invoke({ checkId: 'head' }), /review/);
  assert.equal(existsSync(f.planPath + '.claimed'), false);
  assert.equal(readExecutionReceipts(f.storage, 'owner', runId).length, 0);
});

test('host snapshot ignores later plan edits, but file drift cannot execute', async t => {
  const f = fixture(t);
  const { invoke } = f.load();
  writeFileSync(f.planPath, JSON.stringify({ ...f.plan, checks: [] }));
  assert.equal((await invoke()).details.checks.length, 1);
  writeFileSync(f.script, 'process.exit(0);');
  await assert.rejects(invoke({ checkId: 'head' }), /identity/);
  assert.equal(readExecutionReceipts(f.storage, 'owner', runId).length, 0);
  await assert.rejects(f.load().invoke({ checkId: 'head' }), /identity|plan/);
});

test('denies expired plans and binds the bootstrap to only one review run', async t => {
  const expired = fixture(t, { expiresAt: '2000-01-01T00:00:00Z' });
  await assert.rejects(expired.load().invoke({ checkId: 'head' }), /expired/);
  const f = fixture(t);
  const { invoke } = f.load();
  await invoke({ checkId: 'head' });
  const other = '22222222-2222-4222-8222-222222222222';
  writeFileSync(join(f.storage, 'owner', `${other}.review.json`), JSON.stringify({ ...f.review, runId: other }));
  await assert.rejects(invoke({ runId: other, checkId: 'head' }), /bound/);
});

test('restricted checks use the same invocation gate and preserve indexed container receipts', { skip: !process.env.PI_AUTO_REVIEW_DOCKER_TEST_BACKEND }, async t => {
  const node = await prepareNodeExperiment(t);
  const withoutRun = variant => { const { runId: _run, ...request } = node.request(variant); return request; };
  const plan = {
    schemaVersion: 2, scope: 'worker-only', checkout: node.template.source.repository,
    base: baseRevision, head: headRevision, familySha256: hash('restricted-tool-acceptance'),
    budget: { maxAttempts: 2, maxWallMs: 30000, maxOutputBytes: 131072 },
    checks: [{ id: 'head', maxAttempts: 2, request: withoutRun('head') }, { id: 'mutant', maxAttempts: 1, request: withoutRun('mutant') }],
  };
  const f = fixture(t, plan);
  const { invoke } = f.load();
  const listed = (await invoke()).details;
  assert.equal(listed.profile, 'docker-node-v1');
  assert.equal(listed.scope, 'worker-only');
  await assert.rejects(invoke({ checkId: 'head' }, { ...f.ctx, hasUI: false }), /owner|UI/);
  await assert.rejects(invoke({ checkId: 'head', command: 'anything' }), /argument/);
  const first = await invoke({ checkId: 'head' });
  assert.equal(first.details.receipt.observation, 'passed');
  assert.equal(first.details.receipt.sandboxed, true);
  const nestedCall = async () => invoke({ checkId: 'mutant' });
  const second = await nestedCall();
  assert.equal(second.details.receipt.observation, 'target_failure');
  assert.equal(second.details.receipt.cleanup, 'container-removed');
  const receipts = readExecutionReceipts(f.storage, 'owner', runId);
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every(item => item.path.includes('/restricted-') && item.sha256 === hash(readFileSync(item.path))));
  await assert.rejects(invoke({ checkId: 'head', replayOf: first.details.receipt.attemptId }), /budget|exhausted/);
  await assert.rejects(f.load().invoke({ checkId: 'head' }), /consumed/);
  const unsupported = fixture(t, { ...plan, scope: 'whole-session' });
  assert.equal((await unsupported.load().invoke()).details.available, false);
  await assert.rejects(unsupported.load().invoke({ checkId: 'head' }), /scope|restricted/);
});

test('one registered family invocation calibrates then runs seeded real trials within the same budget', { skip: !process.env.PI_AUTO_REVIEW_DOCKER_TEST_BACKEND }, async t => {
  const node = await prepareNodeExperiment(t);
  const spec = { version: 'optional-findings-v1', seed: 17, trials: 3, inputClass: 'optional-findings',
    domain: { atoms: [finding('nit'), finding('fix', false)], minItems: 0 } };
  const withoutRun = (variant, input) => { const { runId: _run, ...request } = node.request(variant, input); return request; };
  const checks = ['head', 'mutant', 'setup'].map(id => ({ id, maxAttempts: 1, request: withoutRun(id) }));
  enumerateFamilyInputs(spec).forEach((input, index) => checks.push({ id: `trial-${index}`, maxAttempts: 4, request: withoutRun('mutant', input) }));
  enumerateFamilyInputs(spec).forEach((input, index) => {
    if (JSON.parse(input).items.length) checks.push({ id: `pair-${index}`, maxAttempts: 1, request: withoutRun('mutant', prepareMemberOrderPair(input).right) });
  });
  const family = { id: 'optional-findings', spec, binding: prepareOracle(),
    generatorSha256: generateFindingFamily(spec).generatorSha256, templateCheckId: 'trial-3',
    metamorphic: { sha256: memberOrderIdentity() }, reduction: { sha256: reductionIdentity(), maxEvaluations: 12 },
    controls: { pass: 'head', failure: 'mutant', infrastructure: 'setup' } };
  const f = fixture(t, { schemaVersion: 2, scope: 'worker-only', checkout: node.template.source.repository,
    base: baseRevision, head: headRevision, familySha256: canonicalSha256(family),
    budget: { maxAttempts: 15, maxWallMs: 60000, maxOutputBytes: 1048576 }, family, checks });
  const { invoke } = f.load();
  assert.equal((await invoke()).details.families[0].id, family.id);
  await assert.rejects(invoke({ checkId: 'head', familyId: family.id }), /one|selector/);
  const result = await invoke({ familyId: family.id });
  assert.equal(result.details.receipt.status, 'completed', result.details.receipt.reason);
  assert.equal(result.details.receipt.family.calibration.status, 'calibrated');
  assert.equal(result.details.receipt.family.generated, 3);
  assert.equal(result.details.receipt.family.executed, 3);
  assert.equal(result.details.receipt.family.kind, 'sensitivity-control');
  assert.equal(result.details.receipt.metamorphic.status, 'observed-equivalent');
  assert.equal(result.details.receipt.reduction.oneMinimal, true);
  assert.equal(result.details.receipt.reduction.reducedItems, 1);
  assert.equal(result.details.receipt.reduction.replay.predicate, 'FAIL');
  const receipts = readExecutionReceipts(f.storage, 'owner', runId);
  assert.equal(receipts.length, 16);
  await assert.rejects(invoke({ familyId: family.id }), /consumed/);
  const latestEmpty = JSON.parse(readFileSync(receipts.filter(item => item.checkId === 'trial-0').at(-1).path, 'utf8'));
  await assert.rejects(invoke({ checkId: 'trial-0', replayOf: latestEmpty.attemptId }), /budget|exhausted/);
});

function offlineBatchPlan(workers = 2) {
  const { runId: _run, ...request } = syntheticAttempt().request;
  request.adapterSha256 = '0'.repeat(64);
  return {
    schemaVersion: 2, scope: 'worker-only', workers, checkout: request.source.repository,
    base: baseRevision, head: headRevision, familySha256: hash('batch-offline'),
    budget: { maxAttempts: 3, maxWallMs: 30000, maxOutputBytes: 131072 },
    checks: [
      { id: 'first', maxAttempts: 1, request },
      { id: 'second', maxAttempts: 1, request: { ...request, input: '{"items":[]}' } },
    ],
  };
}

test('bounded batch rejects duplicate inputs and unapproved concurrency before claiming authority', async t => {
  for (const workers of [0, 3, '2', [2]]) {
    const f = fixture(t, offlineBatchPlan(workers));
    assert.equal((await f.load().invoke()).details.available, false);
    assert.equal(existsSync(f.planPath + '.claimed'), false);
  }
  const f = fixture(t, offlineBatchPlan());
  const { invoke } = f.load();
  assert.equal((await invoke()).details.workers, 2);
  for (const input of [
    { checkIds: ['first', 'first'] }, { checkIds: [] }, { checkIds: ['unknown'] },
    { checkIds: ['first'], checkId: 'second' }, { checkIds: ['first'], workers: 2 },
    { checkIds: ['first'], replayOf: runId },
  ]) await assert.rejects(invoke(input));
  const duplicate = offlineBatchPlan();
  duplicate.checks[1].request = duplicate.checks[0].request;
  const sameInputs = fixture(t, duplicate);
  await assert.rejects(sameInputs.load().invoke({ checkIds: ['first', 'second'] }), /duplicate/i);
  assert.equal(existsSync(sameInputs.planPath + '.claimed'), false);
  assert.equal(existsSync(f.planPath + '.claimed'), false);
  await assert.rejects(fixture(t).load().invoke({ checkIds: ['head'] }), /restricted|batch/i);
});

test('a batch cannot enter while a single restricted check owns a worker resource', async t => {
  const plan = offlineBatchPlan();
  plan.checks[0].request.adapterSha256 = syntheticAttempt().request.adapterSha256;
  const f = fixture(t, plan);
  const { invoke } = f.load();
  const pending = assert.rejects(invoke({ checkId: 'first' }), /cleanup|fenced/);
  try {
    await assert.rejects(invoke({ checkIds: ['second'] }), /active|leased/);
  } finally {
    await pending;
  }
});

test('failed batch drains to one durable inconclusive receipt and cannot be consumed again', async t => {
  const f = fixture(t, offlineBatchPlan());
  const { invoke } = f.load();
  const result = await invoke({ checkIds: ['first', 'second'] });
  assert.equal(result.details.receipt.profile, 'experiment-batch-v1');
  assert.equal(result.details.receipt.status, 'inconclusive');
  assert.equal(result.details.receipt.workers, 2);
  assert.ok(result.details.receipt.outcomes.some(item => /adapter identity/i.test(item.reason)));
  const receipts = readExecutionReceipts(f.storage, 'owner', runId);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].sha256, result.details.receiptSha256);
  await assert.rejects(invoke({ checkIds: ['first', 'second'] }), /consumed/);
  await assert.rejects(f.load().invoke({ checkIds: ['first', 'second'] }), /consumed/);
});

test('bounded serial and parallel batches retain compatible real observations and private resources', { skip: !process.env.PI_AUTO_REVIEW_DOCKER_TEST_BACKEND }, async t => {
  const saved = process.env.PI_AUTO_REVIEW_WORKER_ARTIFACTS;
  if (saved) {
    mkdirSync(saved);
    mkdirSync(join(saved, 'inputs'));
  }
  const node = await prepareNodeExperiment(t, saved ? join(saved, 'inputs') : undefined);
  const withoutRun = variant => {
    const { runId: _run, ...request } = node.request(variant);
    return request;
  };
  const runs = [];
  for (const workers of [1, 2]) {
    const f = fixture(t, {
      schemaVersion: 2, scope: 'worker-only', workers, checkout: node.template.source.repository,
      base: baseRevision, head: headRevision, familySha256: hash('batch-real-compatibility'),
      budget: { maxAttempts: 2, maxWallMs: 30000, maxOutputBytes: 131072 },
      checks: ['head', 'mutant'].map(id => ({ id, maxAttempts: 1, request: withoutRun(id) })),
    }, saved ? join(saved, `${workers}-worker`) : undefined);
    const { invoke } = f.load();
    const result = await invoke({ checkIds: ['head', 'mutant'] });
    assert.equal(result.details.receipt.status, 'completed', JSON.stringify(result.details.receipt.outcomes));
    assert.equal(result.details.receipt.peakWorkers, workers);
    const references = readExecutionReceipts(f.storage, 'owner', runId);
    assert.equal(references.length, 3);
    const attempts = await Promise.all(['head', 'mutant'].map(id => readRestrictedAttempt(references.find(item => item.checkId === id))));
    assert.deepEqual(attempts.map(attempt => attempt.predicate), ['PASS', 'FAIL']);
    const receipts = references.filter(item => item.checkId !== 'batch').map(item => JSON.parse(readFileSync(item.path, 'utf8')));
    assert.ok(receipts.every(receipt => receipt.cleanup === 'container-removed'));
    assert.equal(new Set(receipts.map(receipt => receipt.containerName)).size, 2);
    assert.equal(new Set(receipts.map(receipt => receipt.configuration.Mounts.find(mount => mount.Destination === '/bundle').Source)).size, 2);
    runs.push({ workers, summary: result.details, attempts });
  }
  assert.deepEqual(runs[0].attempts.map(item => item.normalized), runs[1].attempts.map(item => item.normalized));
  assert.deepEqual(runs[0].attempts.map(item => comparisonContext(item.request)), runs[1].attempts.map(item => comparisonContext(item.request)));
  assert.equal(new Set(runs.flatMap(run => run.attempts.map(item => item.attemptId))).size, 4);
  if (saved) writeFileSync(join(saved, 'summary.json'), JSON.stringify({ runs, attempts: 4, modelCalls: 0 }, null, 2) + '\n');
});

test('cancellation consumes no authority and simultaneous duplicate checks reserve once', async t => {
  const f = fixture(t);
  const { invoke } = f.load();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(invoke({ checkId: 'head' }, f.ctx, controller.signal), { name: 'AbortError' });
  assert.equal(existsSync(f.planPath + '.claimed'), false);
  const results = await Promise.allSettled([invoke({ checkId: 'head' }), invoke({ checkId: 'head' }), invoke({ checkId: 'head' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => /active|fenced/.test(result.reason.message)));
  assert.equal(readExecutionReceipts(f.storage, 'owner', runId).length, 1);
});
