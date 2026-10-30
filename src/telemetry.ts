import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { buildReviewTelemetry, object, receiptIdentity, summarizeReviewTelemetry, type ReviewTelemetry } from './telemetry-report.ts';

const BOUNDARY = 'pi-auto-review-telemetry-v1';
const CHILD_COST = 'pi-extended-teams-cost-v1';
const isIdentity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
type Context = Pick<ExtensionContext, 'sessionManager'>;
type Binding = {
  sessionId: string;
  runId: string;
  coordinatorSessionId: string;
  startedAt: number;
  completedAt: number | null;
  startEntryId: string;
  endEntryId?: string;
  last?: ReviewTelemetry;
};
const keyOf = (sessionId: string, runId: string) => JSON.stringify([sessionId, runId]);
const recordedTime = (value: unknown) => {
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : null;
};

export function registerTelemetry(pi: ExtensionAPI, root: string, now = Date.now) {
  const bindings = new Map<string, Binding>();
  let context: Context | undefined;
  let unsubscribe: (() => void) | undefined;

  const reviewPath = (sessionId: string, runId: string) => {
    if (!isIdentity(sessionId) || !isIdentity(runId)) throw new Error('Invalid telemetry identity.');
    const directory = join(root, sessionId);
    const path = join(directory, `${runId}.review.json`);
    if (!lstatSync(root).isDirectory() || !lstatSync(directory).isDirectory() || !lstatSync(path).isFile()) {
      throw new Error('Review telemetry requires regular review artifacts.');
    }
    return path;
  };
  const readReview = (sessionId: string, runId: string) => {
    const review = object(JSON.parse(readFileSync(reviewPath(sessionId, runId), 'utf8')));
    if (review.sessionId !== sessionId || review.runId !== runId) throw new Error('Review telemetry identity mismatch.');
    return review;
  };
  const entriesFor = (ctx: Context): Record<string, unknown>[] => ctx.sessionManager.getEntries().map(object);
  const snapshot = (ctx: Context, binding: Binding) => {
    const entries = entriesFor(ctx);
    const start = entries.findIndex(entry => entry.id === binding.startEntryId);
    const end = binding.endEntryId ? entries.findIndex(entry => entry.id === binding.endEntryId) : entries.length;
    const available = start >= 0 && end > start;
    const own = available ? entries.slice(start + 1, end) : [];
    const admitted = new Set(own
      .filter(entry => entry.type === 'custom' && entry.customType === CHILD_COST)
      .map(entry => object(entry.data))
      .filter(receipt => receipt.phase === 'pending')
      .flatMap(receipt => {
        const id = receiptIdentity(receipt);
        return id ? [id] : [];
      }));
    const isAdmitted = (receipt: unknown) => {
      const id = receiptIdentity(receipt);
      return id !== null && admitted.has(id);
    };
    const receipts = entries.filter(entry => entry.type === 'custom' && entry.customType === CHILD_COST)
      .map(entry => object(entry.data)).filter(receipt => receipt.rootSessionId === binding.coordinatorSessionId);
    // A helper may settle after completion; follow its recorded parent, not the whole-session subtotal.
    let expanded = true;
    while (expanded) {
      expanded = false;
      const parents = new Set(receipts.filter(isAdmitted).map(receipt => receipt.lifecycleRunId));
      for (const receipt of receipts) {
        const id = receiptIdentity(receipt);
        if (id && !admitted.has(id) && parents.has(object(receipt.telemetry).parentLifecycleRunId)) {
          admitted.add(id);
          expanded = true;
        }
      }
    }
    return buildReviewTelemetry({
      ...binding,
      capturedAt: now(),
      entries: own,
      children: receipts.filter(isAdmitted),
      rootAvailable: available,
    });
  };
  const emit = (report: ReviewTelemetry) => {
    try { pi.events?.emit('pi-auto-review:telemetry', report); }
    catch { /* An observer cannot interrupt a review or native child settlement. */ }
  };
  const publish = (ctx: Context, binding: Binding) => {
    const report = snapshot(ctx, binding);
    const signature = (value: ReviewTelemetry) => JSON.stringify({ ...value, capturedAt: undefined });
    if (binding.last && signature(binding.last) === signature(report)) return binding.last;
    const review = readReview(binding.sessionId, binding.runId);
    if (binding.completedAt !== null || review.status !== 'complete') {
      const path = reviewPath(binding.sessionId, binding.runId);
      const temp = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ ...review, telemetry: report })}\n`, { flag: 'wx', mode: 0o600 });
      renameSync(temp, path);
    }
    binding.last = report;
    emit(report);
    return report;
  };
  const refresh = () => {
    if (!context) return;
    for (const binding of bindings.values()) {
      if (binding.coordinatorSessionId !== context.sessionManager.getSessionId()) continue;
      try {
        publish(context, binding);
      } catch {
        // Export can retry; measurement must not stop a review or cleanup.
      }
    }
  };
  const listen = () => {
    unsubscribe?.();
    unsubscribe = pi.events?.on('pi-extended-teams:cost-changed', refresh);
  };
  const recover = (ctx: Context) => {
    context = ctx;
    bindings.clear();
    for (const entry of entriesFor(ctx)) {
      if (entry.type !== 'custom' || entry.customType !== BOUNDARY || typeof entry.id !== 'string') continue;
      const data = object(entry.data);
      if (!isIdentity(data.sessionId) || !isIdentity(data.runId) || typeof data.startedAt !== 'number') continue;
      const key = keyOf(data.sessionId, data.runId);
      if (data.phase === 'start') {
        bindings.set(key, {
          sessionId: data.sessionId,
          runId: data.runId,
          startedAt: data.startedAt,
          completedAt: null,
          coordinatorSessionId: ctx.sessionManager.getSessionId(),
          startEntryId: entry.id,
        });
      }
      const binding = bindings.get(key);
      if (data.phase === 'end' && binding && binding.completedAt === null && typeof data.completedAt === 'number') {
        binding.endEntryId = entry.id;
        binding.completedAt = data.completedAt;
      }
    }
    listen();
  };
  const appendBoundary = (ctx: Context, data: Record<string, unknown>) => {
    pi.appendEntry(BOUNDARY, data);
    const entry = entriesFor(ctx).at(-1);
    if (entry?.customType !== BOUNDARY || typeof entry.id !== 'string') throw new Error('Telemetry boundary was not journaled.');
    return entry.id;
  };
  const start = (ctx: Context, sessionId: string, runId: string) => {
    if (context?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) recover(ctx);
    const key = keyOf(sessionId, runId);
    if (bindings.has(key)) return;
    const review = readReview(sessionId, runId);
    if (!['prepared', 'running'].includes(String(review.status))) return;
    const createdAt = Date.parse(String(review.createdAt));
    const startedAt = Number.isFinite(createdAt) ? createdAt : now();
    const startEntryId = appendBoundary(ctx, { sessionId, runId, phase: 'start', startedAt });
    bindings.set(key, {
      sessionId,
      runId,
      coordinatorSessionId: ctx.sessionManager.getSessionId(),
      startedAt,
      completedAt: null,
      startEntryId,
    });
  };
  const finish = (ctx: Context | undefined, sessionId: string, runId: string): ReviewTelemetry => {
    if (ctx && context?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) recover(ctx);
    const binding = bindings.get(keyOf(sessionId, runId));
    if (!binding || !ctx) {
      const review = readReview(sessionId, runId);
      return buildReviewTelemetry({
        sessionId,
        runId,
        coordinatorSessionId: null,
        startedAt: recordedTime(review.createdAt),
        completedAt: now(),
        capturedAt: now(),
        entries: [],
        children: [],
        rootAvailable: false,
      });
    }
    if (binding.completedAt === null) {
      const completedAt = now();
      binding.endEntryId = appendBoundary(ctx, { sessionId, runId, phase: 'end', startedAt: binding.startedAt, completedAt });
      binding.completedAt = completedAt;
    }
    const report = snapshot(ctx, binding);
    binding.last = report;
    emit(report);
    return report;
  };

  pi.on('before_agent_start', (event, ctx) => {
    const match = /^(?:Read the complete|Resume the) auto-review mission at (.+\.mission\.md)(?: and execute it now\.|\. Finish every required item)/s.exec(event.prompt);
    if (!match) return;
    const parts = relative(resolve(root), resolve(match[1])).split(/[\\/]/);
    if (parts.length !== 2 || !parts[1].endsWith('.mission.md')) return;
    try { start(ctx, parts[0], parts[1].slice(0, -'.mission.md'.length)); }
    catch { /* Completion will report unavailable coordinator coverage. */ }
  });
  pi.on('session_start', (_event, ctx) => {
    recover(ctx);
    refresh();
  });
  pi.on('agent_end', () => refresh());
  pi.on('session_shutdown', () => {
    refresh();
    unsubscribe?.();
    unsubscribe = undefined;
    context = undefined;
    bindings.clear();
  });
  listen();

  pi.registerTool({
    name: 'agentic_code_review_export_telemetry',
    label: 'Export review telemetry',
    description: 'Return portable JSON usage, cost estimates, elapsed time and observed models for one review, one session, or all retained reviews. Includes distinct-review averages and unknown coverage. No upload or execution limits.',
    parameters: Type.Object({
      sessionId: Type.Optional(Type.String({ maxLength: 128 })),
      runId: Type.Optional(Type.String({ maxLength: 128 })),
    }),
    async execute(_id, { sessionId, runId }, signal) {
      signal?.throwIfAborted();
      if (runId && !sessionId) throw new Error('runId requires sessionId.');
      if ((sessionId !== undefined && !isIdentity(sessionId)) || (runId !== undefined && !isIdentity(runId))) throw new Error('Invalid telemetry identity.');
      refresh();
      const reviews: ReviewTelemetry[] = [];
      let unavailableReviews = 0;
      let sessions: string[] = [];
      if (sessionId) sessions = [sessionId];
      else if (existsSync(root)) {
        sessions = readdirSync(root, { withFileTypes: true })
          .filter(entry => entry.isDirectory() && isIdentity(entry.name))
          .map(entry => entry.name);
      }
      for (const session of sessions) {
        const directory = join(root, session);
        if (!lstatSync(directory).isDirectory()) throw new Error('Invalid telemetry directory.');
        const runs = runId ? [runId] : readdirSync(directory).filter(name => name.endsWith('.review.json')).map(name => name.slice(0, -'.review.json'.length));
        for (const run of runs) {
          try {
            const review = readReview(session, run);
            const live = bindings.get(keyOf(session, run))?.last;
            const saved = object(review.telemetry);
            const report = live ?? (saved.schemaVersion === 1 && saved.sessionId === session && saved.runId === run ? saved as ReviewTelemetry : undefined);
            if (report) reviews.push(report);
            else unavailableReviews++;
          } catch (error) {
            if (runId) throw error;
            unavailableReviews++;
          }
        }
      }
      const details = {
        schemaVersion: 1,
        exportedAt: now(),
        reviews,
        summary: summarizeReviewTelemetry(reviews),
        unavailableReviews,
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(details) }],
        details,
      };
    },
  });
  return { start, finish };
}
