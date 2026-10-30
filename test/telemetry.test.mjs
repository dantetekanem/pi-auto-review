import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const piRoot = process.env.PI_PACKAGE_ROOT
  || resolve(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), '../..');
const require = createRequire(join(piRoot, 'package.json'));
const { createJiti } = require('jiti');
const host = createJiti(join(piRoot, 'package.json'));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  typebox: fileURLToPath(host.esmResolve('typebox')),
} });
const { buildReviewTelemetry, summarizeReviewTelemetry } = await jiti.import('../src/telemetry-report.ts');
const { registerTelemetry } = await jiti.import('../src/telemetry.ts');

const runId = '00000000-0000-4000-8000-000000000001';
const usage = total => ({ input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 125, cost: { total } });
const assistant = (id, model, cost, extra = {}) => ({
  id, type: 'message', timestamp: '2026-10-30T00:00:00Z',
  message: { role: 'assistant', provider: 'test', model, usage: usage(cost), timestamp: 1000, durationMs: 200, ...extra },
});
const input = overrides => ({
  sessionId: 'owner', runId, coordinatorSessionId: 'coordinator',
  startedAt: 1000, completedAt: 5000, capturedAt: 6000,
  entries: [], children: [], rootAvailable: true, ...overrides,
});
const child = (id, entries, overrides = {}) => ({
  rootSessionId: 'coordinator', teamName: 'team', lifecycleRunId: id,
  childSessionId: `session-${id}`, phase: 'final', outcome: 'completed', costUsd: 0.3,
  telemetry: { schemaVersion: 1, agentName: id, role: 'read', startedAt: 2000, completedAt: 4000, entries },
  ...overrides,
});

test('combines own and child usage by observed model, with explicit auxiliary attribution and wall time', () => {
  const report = buildReviewTelemetry(input({
    entries: [
      assistant('root-a', 'alpha', 0.2, { content: ['PRIVATE_SOURCE'], reasoning: 'PRIVATE_REASONING' }),
      { id: 'warm', type: 'usage', kind: 'cache_warm', provider: 'test', model: 'beta', usage: usage(0.05), note: 'PRIVATE_NOTE' },
      { id: 'compact', type: 'compaction', usage: usage(0.1), summary: 'PRIVATE_SUMMARY' },
      { id: 'tool', type: 'message', message: { role: 'toolResult', usage: usage(0.02), content: ['PRIVATE_RESULT'], nestedCalls: [{ usage: usage(99) }] } },
      { id: 'subtotal', type: 'custom', customType: 'pi-extended-teams-cost-v1', data: { costUsd: 99 } },
    ],
    children: [child('worker', [assistant('worker-b', 'beta', 0.3)])],
  }));

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.durationMs, 4000);
  assert.equal(report.agents[1].durationMs, 2000);
  assert.equal(report.cost.knownUsd, 0.67);
  assert.equal(report.cost.totalUsd, 0.67);
  assert.equal(report.cost.source, 'pi-recorded-estimate');
  assert.equal(report.cost.billedUsd, null);
  assert.equal(report.models.find(model => model.model === 'beta').cost.knownUsd, 0.35);
  assert.equal(report.unattributed.cost.knownUsd, 0.12);
  assert.equal(report.unattributed.cost.totalUsd, 0.12);
  assert.equal(report.coverage.modelsComplete, false);
  assert.equal(report.coverage.allProviderCalls, 'unknown');
  assert.equal(report.recordedResponses, 2);
  assert.ok(!JSON.stringify(report).includes('PRIVATE_'));
});

test('retains known subtotals while missing, pending, legacy and excluded usage stays explicit', () => {
  const report = buildReviewTelemetry(input({
    entries: [assistant('a', 'alpha', 0.2), assistant('b', 'beta', undefined, { usage: { output: 3 }, stopReason: 'error' })],
    children: [
      child('pending', [], { phase: 'pending', telemetry: undefined, costUsd: undefined }),
      child('legacy', [], { telemetry: undefined, costUsd: 0.3 }),
      child('moved', [], { phase: 'excluded', telemetry: undefined, costUsd: undefined }),
    ],
  }));
  assert.equal(report.cost.knownUsd, 0.5);
  assert.equal(report.cost.totalUsd, null);
  assert.equal(report.settled, false);
  assert.equal(report.tokens.cacheRead, null);
  assert.equal(report.agents.find(agent => agent.name === 'legacy').tokens.input, null);
  assert.equal(report.agents.find(agent => agent.name === 'legacy').cost.totalUsd, 0.3);
  assert.equal(report.agents.find(agent => agent.name === 'moved').cost.totalUsd, null);
  assert.ok(report.coverage.gaps.includes('unsettled-agents'));
  assert.ok(report.coverage.gaps.includes('legacy-child-usage'));
  assert.ok(report.coverage.gaps.includes('excluded-agent-usage'));
});

test('keeps unmeasured spawned agents unknown instead of treating configured models as observed usage', () => {
  const report = buildReviewTelemetry(input({ entries: [{
    id: 'spawn', type: 'message', message: { role: 'toolResult', toolName: 'spawn_agent', details: {
      agentId: 'external@team', role: 'read', harness: 'external', model: 'configured-not-observed',
    } },
  }] }));
  assert.equal(report.cost.totalUsd, null);
  assert.equal(report.agents.find(agent => agent.name === 'external').cost.totalUsd, null);
  assert.ok(report.coverage.gaps.includes('unmeasured-spawned-agent'));
  assert.ok(!JSON.stringify(report.models).includes('configured-not-observed'));
});

test('deduplicates terminal child receipts and raw entries without merging different lifecycle runs', () => {
  const worker = child('worker', [assistant('a', 'alpha', 0.3), assistant('a', 'alpha', 0.3)]);
  const descendant = child('helper', [assistant('b', 'beta', 0.4)]);
  descendant.telemetry.parentLifecycleRunId = 'worker';
  const report = buildReviewTelemetry(input({ children: [
    { ...worker, phase: 'pending', telemetry: undefined }, worker, worker,
    { ...worker, lifecycleRunId: 'duplicate-session' }, descendant,
  ] }));
  assert.equal(report.agents.length, 3);
  assert.equal(report.cost.totalUsd, 0.7);
  assert.equal(report.recordedResponses, 2);
});

test('marks an unavailable root unknown and averages distinct reviews with explicit sample counts', () => {
  const first = buildReviewTelemetry(input({ entries: [assistant('a', 'alpha', 0.2)] }));
  const later = buildReviewTelemetry(input({ entries: [assistant('a', 'alpha', 0.4)], capturedAt: 7000 }));
  const second = buildReviewTelemetry(input({ runId: '00000000-0000-4000-8000-000000000002', entries: [assistant('b', 'beta', 0.6)] }));
  const summary = summarizeReviewTelemetry([first, later, second, first]);
  assert.equal(summary.reviewCount, 2);
  assert.equal(summary.cost.totalUsd, 1);
  assert.equal(summary.averageCostPerReviewUsd, 0.5);
  assert.equal(summary.averageDurationMs, 4000);
  assert.equal(summary.costSampleCount, 2);

  const unknown = buildReviewTelemetry(input({ runId: '00000000-0000-4000-8000-000000000003', rootAvailable: false }));
  assert.equal(unknown.cost.totalUsd, null);
  const partial = summarizeReviewTelemetry([later, unknown]);
  assert.equal(partial.averageCostPerReviewUsd, null);
  assert.equal(partial.averageKnownReviewCostUsd, 0.4);
  assert.equal(partial.costSampleCount, 1);
  assert.equal(partial.incompleteCostReviews, 1);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'portable-review-telemetry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'owner');
  mkdirSync(directory);
  const path = join(directory, `${runId}.review.json`);
  const mission = join(directory, `${runId}.mission.md`);
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, sessionId: 'owner', runId, createdAt: new Date(1000).toISOString(), status: 'prepared' }));
  writeFileSync(mission, 'PRIVATE_MISSION');
  const handlers = new Map();
  const listeners = new Map();
  const tools = new Map();
  const entries = [assistant('before', 'old-model', 40)];
  const emitted = [];
  const ctx = { sessionManager: { getSessionId: () => 'coordinator', getEntries: () => entries } };
  let now = 2000;
  const pi = {
    on(name, fn) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    appendEntry(customType, data) {
      entries.push({ id: `entry-${entries.length}`, type: 'custom', customType, data });
    },
    events: {
      on(name, fn) {
        listeners.set(name, [...(listeners.get(name) ?? []), fn]);
        return () => listeners.set(name, listeners.get(name).filter(listener => listener !== fn));
      },
      emit(name, value) {
        emitted.push({ name, value });
        for (const fn of listeners.get(name) ?? []) fn(value);
      },
    },
  };
  const controller = registerTelemetry(pi, root, () => now);
  return {
    root, path, mission, pi, ctx, controller, entries, tools, emitted,
    time(value) { now = value; },
    async event(name, event = {}) {
      for (const fn of handlers.get(name) ?? []) await fn({ type: name, ...event }, ctx);
    },
    export(params = {}) {
      return tools.get('agentic_code_review_export_telemetry').execute('export', params, undefined, undefined, ctx);
    },
  };
}

test('binds before the mission, exports content-free JSON and updates the same review after child settlement', async t => {
  const f = fixture(t);
  await f.event('before_agent_start', { prompt: `Read the complete auto-review mission at ${f.mission} and execute it now.` });
  f.entries.push(assistant('a', 'alpha', 0.2));
  f.entries.push({ id: 'admit', type: 'custom', customType: 'pi-extended-teams-cost-v1', data: {
    rootSessionId: 'coordinator', teamName: 'team', lifecycleRunId: 'worker', phase: 'pending',
  } });
  f.time(5000);
  const report = f.controller.finish(f.ctx, 'owner', runId);
  const review = JSON.parse(readFileSync(f.path, 'utf8'));
  writeFileSync(f.path, JSON.stringify({ ...review, status: 'complete', telemetry: report }));
  assert.equal(report.cost.totalUsd, null);
  assert.equal(report.cost.knownUsd, 0.2);
  assert.equal(report.durationMs, 4000);
  f.entries.push(assistant('after', 'presentation-model', 70));
  f.entries.push({ id: 'settle', type: 'custom', customType: 'pi-extended-teams-cost-v1', data: child('worker', [assistant('b', 'beta', 0.3)]) });
  f.time(6000);
  f.pi.events.emit('pi-extended-teams:cost-changed');

  const exported = await f.export({ sessionId: 'owner', runId });
  assert.equal(exported.details.reviews[0].cost.totalUsd, 0.5);
  assert.equal(exported.details.summary.averageCostPerReviewUsd, 0.5);
  assert.equal(JSON.parse(exported.content[0].text).reviews[0].cost.totalUsd, 0.5);
  assert.equal(exported.details.reviews[0].models.some(model => /old|presentation/.test(model.model)), false);
  assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).telemetry.cost.totalUsd, 0.5);
  const published = f.emitted.filter(event => event.name === 'pi-auto-review:telemetry');
  assert.equal(published.at(-1).value.runId, runId);
  assert.ok(!JSON.stringify(published).includes('PRIVATE_'));
});

test('saves unfinished usage without treating a shutdown or reload as review completion', async t => {
  const f = fixture(t);
  f.controller.start(f.ctx, 'owner', runId);
  f.entries.push(assistant('partial', 'alpha', 0.25));
  await f.event('agent_end');
  await f.event('session_shutdown');
  const saved = JSON.parse(readFileSync(f.path, 'utf8')).telemetry;
  assert.equal(saved.cost.knownUsd, 0.25);
  assert.equal(saved.cost.totalUsd, null);
  assert.equal(saved.completedAt, null);
  const exported = await f.export();
  assert.equal(exported.details.summary.incompleteCostReviews, 1);
});

test('selects admissions inside the review and late descendants, not unrelated session children', async t => {
  const f = fixture(t);
  const receipt = (id, data) => ({ id, type: 'custom', customType: 'pi-extended-teams-cost-v1', data });
  f.entries.push(receipt('older', child('older', [], { phase: 'pending', telemetry: undefined })));
  f.controller.start(f.ctx, 'owner', runId);
  f.entries.push(receipt('admitted', child('worker', [], { phase: 'pending', telemetry: undefined })));
  f.entries.push(receipt('older-final', child('older', [assistant('o', 'old', 50)])));
  f.time(5000);
  f.controller.finish(f.ctx, 'owner', runId);
  f.entries.push(receipt('unrelated', child('other', [assistant('other', 'unrelated', 90)])));
  f.entries.push(receipt('worker-final', child('worker', [assistant('a', 'alpha', 0.2)])));
  const helper = child('helper', [assistant('b', 'beta', 0.3)]);
  helper.telemetry.parentLifecycleRunId = 'worker';
  f.entries.push(receipt('helper-final', helper));
  f.pi.events.emit('pi-extended-teams:cost-changed');
  const report = (await f.export()).details.reviews[0];
  assert.equal(report.cost.totalUsd, 0.5);
  assert.deepEqual(report.agents.map(agent => agent.name), ['coordinator', 'worker', 'helper']);
});

test('recovers review boundaries from the native journal and rejects escaping exports', async t => {
  const f = fixture(t);
  f.controller.start(f.ctx, 'owner', runId);
  f.entries.push(assistant('a', 'alpha', 0.2));
  f.time(5000);
  const first = f.controller.finish(f.ctx, 'owner', runId);
  writeFileSync(f.path, JSON.stringify({ schemaVersion: 1, sessionId: 'owner', runId, status: 'complete', telemetry: first }));
  await f.event('session_shutdown');
  f.entries.push(assistant('unrelated', 'another', 99));
  await f.event('session_start');
  const result = await f.export();
  assert.equal(result.details.reviews.length, 1);
  assert.equal(result.details.reviews[0].cost.totalUsd, 0.2);
  await assert.rejects(f.export({ sessionId: '../escape', runId }), /identity/i);
  await assert.rejects(f.export({ runId }), /sessionId/i);
});
