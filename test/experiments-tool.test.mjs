import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareNodeExperiment, prepareOracle, finding, baseRevision, headRevision } from './experiments-helpers.mjs';
import { generateFindingFamily, enumerateFamilyInputs } from '../src/experiments-family.ts';
import { canonicalSha256 } from '../src/experiments-oracle.ts';
import { memberOrderIdentity, prepareMemberOrderPair } from '../src/experiments-metamorphic.ts';
import { reductionIdentity } from '../src/experiments-reduce.ts';

const require = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const { createJiti } = require('jiti');
const { registerExperiments, readExecutionReceipts } = await createJiti(import.meta.url).import('../src/experiments-tool.ts');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const executableHash = hash(readFileSync(process.execPath));
const runId = '11111111-1111-4111-8111-111111111111';

function fixture(t, planChanges = {}) {
  const root = mkdtempSync(join(tmpdir(), 'autoreview-tool-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
  const second = await invoke({ checkId: 'head' });
  assert.equal(first.details.receipt.observation, 'passed');
  assert.notEqual(first.details.receipt.attemptId, second.details.receipt.attemptId);
  const receipts = readExecutionReceipts(f.storage, 'owner', runId);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].checkId, 'head');
  assert.equal(receipts[0].sha256, hash(readFileSync(receipts[0].path)));
  await assert.rejects(invoke({ checkId: 'head' }), /exhausted/);
  await assert.rejects(f.load().invoke({ checkId: 'head' }), /consumed/);
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
  await assert.rejects(invoke({ checkId: 'head' }), /budget|exhausted/);
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
  assert.equal(readExecutionReceipts(f.storage, 'owner', runId).length, 16);
  await assert.rejects(invoke({ familyId: family.id }), /consumed/);
  await assert.rejects(invoke({ checkId: 'trial-0' }), /budget|exhausted/);
});

test('reserves attempts before concurrent invocations and never executes a pre-cancelled request', async t => {
  const f = fixture(t);
  const { invoke } = f.load();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(invoke({ checkId: 'head' }, f.ctx, controller.signal), { name: 'AbortError' });
  assert.equal(existsSync(f.planPath + '.claimed'), false);
  const results = await Promise.allSettled([invoke({ checkId: 'head' }), invoke({ checkId: 'head' }), invoke({ checkId: 'head' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /exhausted/);
  assert.equal(readExecutionReceipts(f.storage, 'owner', runId).length, 2);
});
