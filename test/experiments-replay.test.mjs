import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const { createJiti } = require('jiti');
const { approveTrustedReplay, runTrustedReplay } = await createJiti(import.meta.url).import('../src/experiments-replay.ts');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const executableHash = hash(readFileSync(process.execPath));
const program = `
import { readFileSync } from 'node:fs';
console.log('RUNTIME test-node');
const value = readFileSync(new URL('input.txt', import.meta.url), 'utf8');
if (process.argv[2] === 'base') {
  console.log('FAIL duplicate ExpectedFailure: duplicate key');
  console.log('PASS control ' + value);
  console.log('RESULT 2 cases, 1 failures');
  process.exitCode = 1;
} else {
  console.log('PASS duplicate ' + value);
  console.log('PASS control ' + value);
  console.log('RESULT 2 cases, 0 failures');
}`;

function fixture(t, source = program) {
  const root = mkdtempSync(join(tmpdir(), 'autoreview-replay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'probe.mjs');
  const input = join(root, 'input.txt');
  writeFileSync(script, source);
  writeFileSync(input, 'real input');
  const request = {
    runId: 'replay-test', profile: 'trusted-program', revision: 'a'.repeat(40),
    executable: process.execPath, script: 'probe.mjs', args: ['head'], cwd: root,
    environment: {},
    files: [
      { path: script, sha256: hash(source), copyAs: 'probe.mjs' },
      { path: input, sha256: hash('real input'), copyAs: 'input.txt' },
      { path: process.execPath, sha256: executableHash },
    ],
    headers: ['RUNTIME test-node'],
    cases: [{ id: 'duplicate', failure: { prefix: 'ExpectedFailure:', contains: 'duplicate key' } }, { id: 'control' }],
    limits: { timeoutMs: 2000, maxOutputBytes: 4096 },
  };
  const artifacts = join(root, 'artifacts');
  const approve = input => approveTrustedReplay(input, { approvedBy: 'authorized test host', maxAttempts: 2 });
  const run = (changes = {}, options = {}) => {
    const input = { ...request, ...changes };
    return runTrustedReplay(input, approve(input), artifacts, options);
  };
  return { root, script, input, request, artifacts, approve, run };
}

test('runs pinned programs through the shared supervisor and freshly replays a saved request', async t => {
  const f = fixture(t);
  const base = await f.run({ args: ['base'] });
  const grant = f.approve(f.request);
  const head = await runTrustedReplay(f.request, grant, f.artifacts);
  const saved = JSON.parse(readFileSync(head.paths.request, 'utf8'));
  const replay = await runTrustedReplay(saved, grant, f.artifacts);
  assert.deepEqual([base.observation, head.observation, replay.observation], ['target_failure', 'passed', 'passed']);
  assert.deepEqual([base.exitCode, head.exitCode, replay.exitCode], [1, 0, 0]);
  assert.equal(head.requestDigest, replay.requestDigest);
  assert.notEqual(head.attemptId, replay.attemptId);
  assert.notEqual(head.workspace, replay.workspace);
  for (const receipt of [base, head, replay]) {
    assert.equal(receipt.profile, 'trusted-program');
    assert.equal(receipt.sandboxed, false);
    assert.equal(receipt.observationOrigin, 'parsed-child-transcript');
    assert.equal(receipt.processControl, 'direct-child-only');
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.cleanup, 'workspace-removed');
    assert.equal(existsSync(receipt.workspace), false);
    assert.equal(receipt.outputs.stdout.sha256, hash(readFileSync(receipt.paths.stdout)));
    assert.deepEqual(JSON.parse(readFileSync(receipt.paths.receipt, 'utf8')), receipt);
  }
  assert.equal(readFileSync(f.script, 'utf8'), program);
  assert.equal(readFileSync(f.input, 'utf8'), 'real input');
  await assert.rejects(runTrustedReplay(saved, grant, f.artifacts), /exhausted/);
});

test('denies forged grants, altered requests and changed pinned files before execution', async t => {
  const f = fixture(t);
  await assert.rejects(runTrustedReplay(f.request, { approved: true }, f.artifacts), /grant/);
  const grant = f.approve(f.request);
  await assert.rejects(runTrustedReplay({ ...f.request, args: ['base'] }, grant, f.artifacts), /match/);
  writeFileSync(f.input, 'changed');
  await assert.rejects(runTrustedReplay(f.request, grant, f.artifacts), /identity/);
  assert.equal(existsSync(f.artifacts), false);
  assert.throws(() => f.approve({ ...f.request, files: f.request.files.map(file => ({ ...file, copyAs: '../escape' })) }), /file/);
  assert.throws(() => f.approve({ ...f.request, environment: { RUBYOPT: '-runknown' } }), /environment/);
});

test('does not turn setup failures, missing cases or unrelated failures into target proof', async t => {
  for (const [source, status, observation] of [
    ["throw new Error('missing dependency');", 'setup_error', null],
    ["console.log('RUNTIME test-node');", 'completed', 'not_observed'],
    ["console.log('RUNTIME test-node\\nFAIL duplicate TypeError: wrong failure\\nPASS control ok\\nRESULT 2 cases, 1 failures'); process.exitCode=1;", 'completed', 'probe_error'],
    ["console.log('RUNTIME test-node\\nPASS duplicate ok\\nPASS control ok\\nRESULT 2 cases, 0 failures'); process.exitCode=1;", 'process_error', null],
  ]) {
    const f = fixture(t, source);
    const receipt = await f.run();
    assert.equal(receipt.status, status);
    assert.equal(receipt.observation, observation);
  }
});

test('timeout, cancellation and output limits suppress transcript success', async t => {
  const hanging = fixture(t, program + '\nsetInterval(() => {}, 1000);');
  const timeout = await hanging.run({ limits: { timeoutMs: 100, maxOutputBytes: 4096 } });
  assert.equal(timeout.status, 'timeout');
  assert.equal(timeout.observation, null);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  t.after(() => clearTimeout(timer));
  const cancelled = await hanging.run({}, { signal: controller.signal });
  assert.equal(cancelled.status, 'cancelled');
  const flooding = fixture(t, "process.stdout.write('x'.repeat(100000));");
  const flood = await flooding.run();
  assert.equal(flood.status, 'output_limit');
  assert.equal(flood.observation, null);
  assert.ok(flood.outputs.stdout.bytes <= 4096);
});

test('cancellation during post-execution pin verification cannot return a passing observation', async t => {
  const f = fixture(t, program + "\nimport { writeFileSync } from 'node:fs'; writeFileSync('executed', 'yes');");
  const controller = new AbortController();
  const throwIfAborted = controller.signal.throwIfAborted.bind(controller.signal);
  t.mock.method(controller.signal, 'throwIfAborted', () => {
    if (existsSync(join(f.root, 'executed'))) controller.abort();
    throwIfAborted();
  });

  const receipt = await f.run({}, { signal: controller.signal });

  assert.equal(existsSync(join(f.root, 'executed')), true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(receipt.status, 'cancelled');
  assert.equal(receipt.observation, null);
  assert.equal(receipt.cleanup, 'workspace-removed');
});

test('checks read dependencies again after execution rather than accepting drifted evidence', async t => {
  const f = fixture(t);
  const source = program + `\nimport { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(f.input)}, 'changed during execution');`;
  writeFileSync(f.script, source);
  const receipt = await f.run({ files: f.request.files.map(file => file.path === f.script ? { ...file, sha256: hash(source) } : file) });
  assert.equal(receipt.status, 'input_changed');
  assert.equal(receipt.observation, null);
  assert.equal(receipt.cleanup, 'workspace-removed');
});
