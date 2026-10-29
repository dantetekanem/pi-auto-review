import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { registerReview } from '../src/index.ts';
import { registerExperiments } from '../src/experiments-tool.ts';
import { registerAdaptive } from '../src/adaptive-tool.ts';
import { canonicalSha256 } from '../src/experiments-oracle.ts';
import { enumerateFamilyInputs, generateFindingFamily } from '../src/experiments-family.ts';
import { syntheticAttempt, finding, prepareOracle, baseRevision, headRevision } from './experiments-helpers.mjs';

const sessionId = 'adaptive-parent';
const runId = '11111111-1111-4111-8111-111111111111';
const budget = { total: 3, collect: 2, search: 1, family: 1 };
const question = { criterionId: 'criterion-1', scope: 'src/handler.ts', question: 'Which callback handles restoration?', material: true };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pack = {
  nodes: [],
  edges: [],
  skippedAnchors: [],
  coverage: { unresolved: 0, frontier: ['unexpanded dependency'], truncatedBy: 'max_nodes' },
};

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'adaptive-tool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, sessionId);
  await mkdir(directory);
  const reviewPath = join(directory, `${runId}.review.json`);
  const review = {
    schemaVersion: 1,
    sessionId,
    runId,
    status: 'prepared',
    preflight: { target: 'fixture', base: 'a'.repeat(40), head: 'b'.repeat(40), checkout: root },
  };
  await writeFile(reviewPath, JSON.stringify(review));
  await writeFile(join(directory, `${runId}.map.jsonl`), JSON.stringify({ id: question.criterionId,
    kind: 'requirement', runId, statement: 'Restore only one completion' }) + '\n');
  const tools = new Map();
  const pi = { registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, on() {} };
  registerReview(pi, root);
  const tool = tools.get('agentic_code_review_next_action');
  assert.ok(tool, 'Adaptive reconciliation must be registered through the real extension entry point.');
  const ctx = { cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'coordinator' } };
  const call = (input, signal, context = ctx) => tool.execute('fixture-call', { sessionId, runId, ...input }, signal, undefined, context);
  const save = async (name, details, kind = 'scan') => {
    const path = `${runId}.${name}.json`;
    const bytes = JSON.stringify(details);
    await writeFile(join(directory, path), bytes);
    return { kind, path, sha256: digest(bytes) };
  };
  const source = await save('initial-scan', pack);
  const status = (await call({ operation: 'status' })).details;
  const event = { id: 'scan-1', contextId: status.contextId, question, source };
  const state = async () => JSON.parse(await readFile(join(directory, `${runId}.adaptive.json`), 'utf8'));
  return { root, directory, reviewPath, review, call, ctx, save, event, state, pi };
}

test('registered reconciliation consumes a saved scan and reserves only one sequential recommendation', async t => {
  const f = await setup(t);
  await assert.rejects(f.state(), { code: 'ENOENT' });
  const observed = (await f.call({ operation: 'observe', budget, event: f.event })).details;
  assert.equal(observed.disposition, 'accepted');
  assert.deepEqual(observed.facts[0].gaps, ['frontier', 'partial-coverage']);
  const actions = [{ factId: observed.facts[0].id, kind: 'collect', target: 'src/handler.ts:10' }];
  const results = await Promise.all([f.call({ operation: 'select', actions }), f.call({ operation: 'select', actions })]);
  assert.deepEqual(results.map(result => result.details.selection.kind).sort(), ['action', 'wait-unknown']);
  assert.equal((await f.state()).budget.total, 2);
  const first = results.find(result => result.details.selection.kind === 'action').details.selection;
  const source = await f.save('collected', { ...pack, coverage: { ...pack.coverage, frontier: [], truncatedBy: 'none' } }, 'collect');
  const event = { ...f.event, id: 'collect-1', source, actionKey: first.key };
  await f.call({ operation: 'observe', event });
  const duplicate = (await f.call({ operation: 'observe', event })).details;
  assert.equal(duplicate.disposition, 'duplicate');
  assert.equal((await f.state()).budget.total, 2);
  assert.equal((await f.state()).pending, null);
  assert.equal((await f.call({ operation: 'select', actions })).details.selection.kind, 'stop-unknown');
});

test('late or stale observations cannot overwrite fresh facts and context changes do not refresh budgets', async t => {
  const f = await setup(t);
  const observed = (await f.call({ operation: 'observe', budget, event: f.event })).details;
  const actions = [{ factId: observed.facts[0].id, kind: 'collect', target: 'src/handler.ts:10' }];
  const selected = (await f.call({ operation: 'select', actions })).details.selection;
  const source = await f.save('result', pack, 'collect');
  const result = { ...f.event, id: 'result-1', source, actionKey: selected.key };
  await f.call({ operation: 'observe', event: result });
  assert.equal((await f.call({ operation: 'observe', event: { ...result, id: 'late-1' } })).details.disposition, 'late');
  await writeFile(f.reviewPath, JSON.stringify({ ...f.review, evidenceContext: { identities: [{ kind: 'source', key: 'handler', sha256: 'd'.repeat(64) }], scopes: [] } }));
  const stale = (await f.call({ operation: 'observe', event: { ...f.event, id: 'stale-1' } })).details;
  assert.equal(stale.disposition, 'stale');
  assert.notEqual(stale.contextId, observed.contextId);
  assert.equal(stale.facts[0].source.sha256, source.sha256);
  assert.equal(stale.facts[0].contextId, observed.contextId);
  assert.equal((await f.call({ operation: 'select', actions })).details.selection.kind, 'stop-unknown');
  await assert.rejects(f.call({ operation: 'observe', budget: { ...budget, total: 4 }, event: { ...f.event, id: 'reset' } }), /budget/i);
  assert.equal((await f.state()).budget.total, 2);
});

test('results bind to the selected question, kind and context, and cannot replace a newer observation', async t => {
  const f = await setup(t);
  const observed = (await f.call({ operation: 'observe', budget, event: f.event })).details;
  const selected = (await f.call({ operation: 'select', actions: [
    { factId: observed.facts[0].id, kind: 'collect', target: 'src/handler.ts:10' },
  ] })).details.selection;
  const source = await f.save('collected', pack, 'collect');
  const result = { ...f.event, id: 'result-1', source, actionKey: selected.key };
  await assert.rejects(f.call({ operation: 'observe', event: { ...result, source: f.event.source } }));
  await assert.rejects(f.call({ operation: 'observe', event: { ...result, question: { ...question, question: 'Unrelated question?' } } }));
  await assert.rejects(f.call({ operation: 'observe', event: { ...result, contextId: 'c'.repeat(64) } }));
  const newer = await f.save('newer', { ...pack, coverage: { ...pack.coverage, frontier: ['new evidence'], truncatedBy: 'budget' } });
  await f.call({ operation: 'observe', event: { ...f.event, id: 'newer', source: newer } });
  const late = (await f.call({ operation: 'observe', event: result })).details;
  assert.equal(late.disposition, 'late');
  assert.equal(late.facts[0].source.sha256, newer.sha256);
  assert.equal((await f.state()).pending, null);
});

test('conflicting events, foreign criteria, changed bytes and outside paths reject without changing the journal', async t => {
  const f = await setup(t);
  await f.call({ operation: 'observe', budget, event: f.event });
  const before = await f.state();
  const badEvents = [
    { ...f.event, question: { ...question, question: 'Different meaning' } },
    { ...f.event, id: 'foreign', question: { ...question, criterionId: 'missing' } },
    { ...f.event, id: 'drift', source: { ...f.event.source, sha256: 'e'.repeat(64) } },
    { ...f.event, id: 'outside', source: { ...f.event.source, path: '../private.json' } },
    { ...f.event, id: 'unindexed', source: { kind: 'execution', sha256: 'f'.repeat(64) } },
  ];
  for (const event of badEvents) await assert.rejects(f.call({ operation: 'observe', event }));
  const link = `${runId}.symlink.json`;
  await symlink(f.reviewPath, join(f.directory, link));
  await assert.rejects(f.call({ operation: 'observe', event: { ...f.event, id: 'symlink', source: { ...f.event.source, path: link } } }));
  assert.deepEqual(await f.state(), before);
});

test('family recommendations read the existing host gate without reserving or executing a workload', async t => {
  const f = await setup(t);
  const spec = { version: 'optional-findings-v1', seed: 17, trials: 1, inputClass: 'optional-findings',
    domain: { atoms: [finding()], minItems: 0 } };
  const template = syntheticAttempt().request;
  const request = (variant, input = template.input) => {
    const { runId: _run, ...rest } = template;
    return { ...rest, input, source: { ...template.source, repository: f.root,
      ...(variant === 'mutant' ? { mutation: { label: 'sensitivity-control', path: 'src/findings.ts', before: 'false', after: 'true' } } : {}) } };
  };
  const checks = ['head', 'mutant', 'setup'].map(id => ({ id, maxAttempts: 1, request: request(id) }));
  enumerateFamilyInputs(spec).forEach((input, index) => checks.push({ id: `trial-${index}`, maxAttempts: 1, request: request('mutant', input) }));
  const family = { id: 'optional-findings', spec, binding: prepareOracle(),
    generatorSha256: generateFindingFamily(spec).generatorSha256, templateCheckId: 'trial-1',
    controls: { pass: 'head', failure: 'mutant', infrastructure: 'setup' } };
  const plan = { schemaVersion: 2, scope: 'worker-only', target: 'fixture', checkout: f.root,
    base: baseRevision, head: headRevision, expiresAt: new Date(Date.now() + 60000).toISOString(),
    familySha256: canonicalSha256(family), family, checks,
    budget: { maxAttempts: 8, maxWallMs: 30000, maxOutputBytes: 1048576 } };
  const path = join(f.root, 'host-plan.json');
  const bytes = JSON.stringify(plan);
  await writeFile(path, bytes);
  await writeFile(f.reviewPath, JSON.stringify({ ...f.review, preflight: { ...f.review.preflight, base: baseRevision, head: headRevision } }));
  const events = new Map();
  const available = registerExperiments({ registerTool() {}, on(name, handler) { events.set(name, handler); } }, f.root,
    { path, sha256: digest(bytes) });
  assert.equal(typeof available, 'function');
  assert.deepEqual(available(f.ctx, sessionId, runId), []);
  await events.get('session_start')({}, f.ctx);
  assert.deepEqual(available(f.ctx, sessionId, runId), [family.id]);
  let adaptive;
  registerAdaptive({ registerTool(tool) { adaptive = tool; } }, f.root, available);
  const call = input => adaptive.execute('family-recommendation', { sessionId, runId, ...input }, undefined, undefined, f.ctx);
  const { contextId } = (await call({ operation: 'status' })).details;
  const observation = (await call({ operation: 'observe', budget, event: { ...f.event, contextId } })).details;
  const selected = (await call({ operation: 'select', actions: [{ kind: 'family', familyId: family.id, factId: observation.facts[0].id }] })).details.selection;
  assert.equal(selected.kind, 'action');
  const receiptDirectory = join(f.directory, `${runId}.experiments`, 'family-fixtur');
  await mkdir(receiptDirectory, { recursive: true });
  const receipt = JSON.stringify({ schemaVersion: 1, profile: 'experiment-family-v1', runId, familyId: family.id,
    status: 'completed', fixture: 'synthetic-index-only; no workload was executed' });
  await writeFile(join(receiptDirectory, 'receipt.json'), receipt);
  await writeFile(join(f.directory, `${runId}.experiments`, 'index.jsonl'), JSON.stringify({ checkId: family.id,
    path: 'family-fixtur/receipt.json', sha256: digest(receipt) }) + '\n');
  const result = (await call({ operation: 'observe', event: { ...f.event, id: 'family-result', contextId,
    source: { kind: 'execution', sha256: digest(receipt) }, actionKey: selected.key } })).details;
  assert.equal(result.disposition, 'accepted');
  assert.deepEqual(result.facts[0].gaps, ['interpretation-needed']);
  assert.equal(result.facts[0].status, 'unknown');
  assert.deepEqual(available({ ...f.ctx, hasUI: false }, sessionId, runId), []);
  await assert.rejects(readFile(path + '.claimed'), { code: 'ENOENT' });
  await writeFile(path + '.claimed', '{}');
  assert.deepEqual(available(f.ctx, sessionId, runId), []);
  await rm(path + '.claimed');
  t.mock.method(Date, 'now', () => Date.parse(plan.expiresAt) + 1);
  assert.deepEqual(available(f.ctx, sessionId, runId), []);
});

test('reload preserves an ambiguous pending recommendation, and cancellation or sealing cannot create another', async t => {
  const f = await setup(t);
  const observed = (await f.call({ operation: 'observe', budget, event: f.event })).details;
  const actions = [{ factId: observed.facts[0].id, kind: 'search', query: 'restore', path: 'src/handler.ts' }];
  await f.call({ operation: 'select', actions });
  const reloadedTools = new Map();
  registerReview({ ...f.pi, registerTool(tool) { reloadedTools.set(tool.name, tool); } }, f.root);
  const pending = await reloadedTools.get('agentic_code_review_next_action').execute('reload',
    { sessionId, runId, operation: 'select', actions }, undefined, undefined, f.ctx);
  assert.equal(pending.details.selection.kind, 'wait-unknown');
  assert.equal((await f.state()).budget.total, 2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.call({ operation: 'select', actions }, controller.signal));
  await assert.rejects(f.call({ operation: 'select', actions }, undefined,
    { ...f.ctx, sessionManager: { getSessionId: () => 'other-coordinator' } }));
  await writeFile(f.reviewPath, JSON.stringify({ ...f.review, status: 'complete' }));
  await assert.rejects(f.call({ operation: 'select', actions }));
  assert.equal((await f.state()).budget.total, 2);
});
