import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url);
const { approveTrustedFixture, digestBytes } = await jiti.import('../src/experiments-contract.ts');
const { runTrustedFixture } = await jiti.import('../src/experiments-runner.ts');

const probe = `
import { existsSync, writeFileSync } from 'node:fs';
export default (subject, input, check) => {
  console.log('fresh=' + !existsSync('scratch-marker'));
  writeFileSync('scratch-marker', 'touched');
  check(subject.double(input), input * 2);
};`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'autoreview-fixture-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const request = {
    runId: 'demo-run',
    profile: 'trusted-fixture',
    source: 'export const double = n => n * 2;',
    probe,
    input: '3',
    targetId: 'double-value',
    limits: { timeoutMs: 2000, maxOutputBytes: 4096 },
  };
  const artifacts = join(root, 'artifacts');
  const run = (changes = {}, options = {}) => {
    const input = { ...request, ...changes };
    const grant = approveTrustedFixture(input, { approvedBy: 'authorized test harness', maxAttempts: 1 });
    return runTrustedFixture(input, grant, artifacts, options);
  };
  return { root, artifacts, request, run };
}

function output(receipt, stream) {
  return readFileSync(receipt.paths[stream], 'utf8');
}

test('runs the same probe on two real implementations and replays the failure in fresh scratch', async t => {
  const f = fixture(t);
  const basePath = join(f.root, 'base.mjs');
  const headPath = join(f.root, 'head.mjs');
  writeFileSync(basePath, f.request.source);
  writeFileSync(headPath, 'export const double = n => n * 2 + 1;');
  const base = await f.run({ source: readFileSync(basePath, 'utf8') });
  const request = { ...f.request, source: readFileSync(headPath, 'utf8') };
  const grant = approveTrustedFixture(request, { approvedBy: 'authorized test harness', maxAttempts: 2 });
  const head = await runTrustedFixture(request, grant, f.artifacts);
  const savedRequest = JSON.parse(readFileSync(head.paths.request, 'utf8'));
  const replay = await runTrustedFixture(savedRequest, grant, f.artifacts);

  assert.deepEqual([base.observation, head.observation, replay.observation], ['passed', 'target_failure', 'target_failure']);
  assert.deepEqual([base.exitCode, head.exitCode, replay.exitCode], [0, 1, 1]);
  assert.notEqual(base.identities.source, head.identities.source);
  assert.equal(base.identities.probe, head.identities.probe);
  assert.equal(head.requestDigest, replay.requestDigest);
  assert.notEqual(head.attemptId, replay.attemptId);
  assert.notEqual(head.cwd, replay.cwd);
  assert.equal(readFileSync(basePath, 'utf8'), f.request.source);
  assert.equal(readFileSync(headPath, 'utf8'), request.source);
  for (const receipt of [base, head, replay]) {
    assert.equal(receipt.status, 'completed');
    assert.match(output(receipt, 'stdout'), /fresh=true/);
    assert.equal(receipt.sandboxed, false);
    assert.equal(receipt.processControl, 'direct-child-only');
    assert.equal(receipt.cleanup, 'workspace-removed');
    assert.equal(existsSync(receipt.cwd), false);
    assert.equal(receipt.outputs.stdout.sha256, digestBytes(readFileSync(receipt.paths.stdout)));
    assert.deepEqual(JSON.parse(readFileSync(receipt.paths.receipt, 'utf8')), receipt);
  }
});

test('denies missing, forged, changed and exhausted grants before any artifact or child effect', async t => {
  const f = fixture(t);
  const marker = join(f.root, 'must-not-run');
  const input = {
    ...f.request,
    source: `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad');`,
  };
  for (const grant of [undefined, { approved: true }]) {
    await assert.rejects(runTrustedFixture(input, grant, f.artifacts), /grant/i);
  }
  const grant = approveTrustedFixture(input, { approvedBy: 'test harness', maxAttempts: 1 });
  await assert.rejects(runTrustedFixture({ ...input, input: '4' }, grant, f.artifacts), /match/i);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(f.artifacts), false);
  const allowed = approveTrustedFixture(f.request, { approvedBy: 'test harness', maxAttempts: 1 });
  await runTrustedFixture(f.request, allowed, f.artifacts);
  await assert.rejects(runTrustedFixture(f.request, allowed, f.artifacts), /exhausted/i);
  assert.equal(readdirSync(f.artifacts).length, 1);
});

test('keeps import failure, unrelated assertion and an unexecuted target separate from target failure', async t => {
  const f = fixture(t);
  const setup = await f.run({ source: "import './missing-dependency.mjs';" });
  const unrelated = await f.run({ probe: "import assert from 'node:assert/strict'; export default () => assert.fail('other assertion');" });
  const skipped = await f.run({ probe: 'export default () => {};' });
  const earlyExit = await f.run({ probe: 'process.exit(0);' });
  const thrownUndefined = await f.run({
    probe: 'export default (subject, input, check) => { check(1, 1); throw undefined; };',
  });
  assert.equal(thrownUndefined.observation, 'probe_error');
  assert.equal(setup.status, 'setup_error');
  assert.equal(setup.observation, null);
  assert.equal(unrelated.observation, 'probe_error');
  assert.equal(skipped.observation, 'not_observed');
  assert.equal(earlyExit.status, 'process_error');
  assert.equal(earlyExit.observation, null);
});

test('a swallowed target failure stays failed, while multiple target checks are not a valid observation', async t => {
  const f = fixture(t);
  const swallowed = await f.run({ probe: 'export default (subject, input, check) => { try { check(1, 2); } catch {} };' });
  const multiple = await f.run({ probe: 'export default (subject, input, check) => { check(1, 1); check(2, 2); };' });
  assert.equal(swallowed.observation, 'target_failure');
  assert.equal(multiple.observation, 'probe_error');
});

test('timeout and output flood override child success and preserve bounded bytes', async t => {
  const f = fixture(t);
  const timeout = await f.run({
    probe: 'export default (subject, input, check) => { check(1, 1); setInterval(() => {}, 1000); };',
    limits: { timeoutMs: 250, maxOutputBytes: 4096 },
  });
  const flood = await f.run({ probe: "process.stdout.write('x'.repeat(100000)); export default (s, i, check) => check(1, 1);" });
  assert.equal(timeout.status, 'timeout');
  assert.equal(timeout.observation, null);
  assert.equal(flood.status, 'output_limit');
  assert.equal(flood.observation, null);
  assert.ok(flood.outputs.stdout.truncated);
  const total = ['stdout', 'stderr', 'result'].reduce((sum, name) => sum + readFileSync(flood.paths[name]).length, 0);
  assert.ok(total <= f.request.limits.maxOutputBytes);
  for (const receipt of [timeout, flood]) {
    assert.equal(receipt.cleanup, 'workspace-removed');
    assert.ok(receipt.signal);
    assert.throws(() => process.kill(receipt.pid, 0), { code: 'ESRCH' });
  }
});

test('cancels execution and removes scratch before returning', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  const pending = f.run({
    probe: 'export default () => new Promise(() => { setInterval(() => {}, 1000); });',
  }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 100);
  t.after(() => clearTimeout(timer));
  const cancelled = await pending;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.observation, null);
  assert.equal(cancelled.cleanup, 'workspace-removed');
});

test('uses a fresh HOME without inheriting ambient secrets', async t => {
  const f = fixture(t);
  const previous = process.env.AUTOREVIEW_FIXTURE_SECRET;
  process.env.AUTOREVIEW_FIXTURE_SECRET = 'synthetic-test-value';
  try {
    const receipt = await f.run({ probe: 'export default (s, i, check) => check(process.env.AUTOREVIEW_FIXTURE_SECRET, undefined);' });
    assert.equal(receipt.observation, 'passed');
    assert.equal(receipt.environment.HOME, receipt.cwd);
    assert.equal('AUTOREVIEW_FIXTURE_SECRET' in receipt.environment, false);
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_FIXTURE_SECRET;
    else process.env.AUTOREVIEW_FIXTURE_SECRET = previous;
  }
});
