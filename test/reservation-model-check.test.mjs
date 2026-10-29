import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { interpretTlc, runtimeIdentity, prepareReservationCheck, runReservationCheck, readReservationCheck } from '../src/reservation-model-check.ts';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const frame = (id, body, level = 0) => `@!@!@STARTMSG ${id}:${level} @!@!@\n${body}\n@!@!@ENDMSG ${id} @!@!@\n`;
const start = frame(2187, 'Running breadth-first search Model-Checking with 1 worker') + frame(2185, 'Starting...');
const initialized = frame(2190, 'Finished computing initial states: 1 distinct state generated at now.');
const stats = frame(2199, '12 states generated, 5 distinct states found, 0 states left on queue.');
const finished = frame(2186, 'Finished in 1s');
const success = start + initialized + frame(2193, 'Model checking completed. No error has been found.') + stats + finished;
const violation = start + initialized + frame(2110, 'Invariant NoUnjustifiedReacquisition is violated.', 1)
  + frame(2121, 'The behavior up to this point is:', 1) + frame(2217, '1: <Initial predicate>\nhistory = <<>>', 4) + stats + finished;
const observed = (stdout = success, exitCode = 0) => ({ status: 'completed', exitCode, stdout, stderr: '' });

test('TLC completion requires complete finite exploration, not exit zero or success prose', () => {
  assert.equal(interpretTlc(observed()).status, 'bounded-model-checked');
  for (const output of [observed(''), observed('Model checking completed.'), observed(success.replace(stats, '')),
    observed(success.replace(initialized, '')), observed(success.replace(finished, '')),
    observed(success.replace('0 states left', '2 states left')), observed(success.replace('1 distinct state generated', '0 distinct state generated')),
    observed(success + frame(2111, 'Evaluation failed', 1)), observed(success + frame(2188, 'Simulation')),
    observed(finished + success.replace(finished, '')), observed(success.replace('with 1 worker', 'with 2 workers')),
    observed(success.replace('1 distinct state generated', '9007199254740992 distinct states generated')),
    { ...observed(), stderr: frame(2111, 'Evaluation failed', 1) },
    observed(success.replace('@!@!@ENDMSG 2193', '@!@!@ENDMSG 9999')), observed(success, 1),
    ...['timeout', 'cancelled', 'output_limit', 'process_error'].map(status => ({ ...observed(), status }))]) {
    assert.equal(interpretTlc(output).status, 'unknown', JSON.stringify(output));
  }
});

test('the pinned non-semantic JVM GC advisory is retained without hiding other warnings', () => {
  const advisory = frame(2401, 'Please run the Java VM which executes TLC with a throughput optimized garbage collector by passing the "-XX:+UseParallelGC" property.', 3);
  const passed = interpretTlc(observed(advisory + success));
  assert.equal(passed.status, 'bounded-model-checked');
  assert.equal(passed.advisories[0].code, 2401);
  assert.equal(interpretTlc(observed(advisory + violation, 12)).status, 'model-counterexample');
  assert.equal(interpretTlc(observed(frame(2401, 'Different warning', 3) + success)).status, 'unknown');
  assert.equal(interpretTlc(observed(frame(2402, 'Other warning', 3) + success)).status, 'unknown');
});

test('only the named invariant with a finished trace is a model counterexample', () => {
  assert.equal(interpretTlc(observed(violation, 12)).status, 'model-counterexample');
  for (const stdout of [violation.replace('NoUnjustifiedReacquisition', 'OtherInvariant'),
    violation.replace(frame(2217, '1: <Initial predicate>\nhistory = <<>>', 4), ''), violation + frame(2193, 'No error')]) {
    assert.equal(interpretTlc(observed(stdout, 12)).status, 'unknown');
  }
  assert.equal(interpretTlc(observed(violation, 0)).status, 'unknown');
});

function fixture(t, output = success, exitCode = 0) {
  const root = mkdtempSync(join(tmpdir(), 'reservation-model-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, 'runtime');
  mkdirSync(runtime);
  const java = join(runtime, 'java');
  writeFileSync(java, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync('invocation.json', JSON.stringify({args:process.argv.slice(2),env:process.env}));\nprocess.stdout.write(${JSON.stringify(output)});\nprocess.exitCode=${exitCode};\n`, { mode: 0o700 });
  writeFileSync(join(runtime, 'package.json'), '{"type":"module"}');
  const pin = path => ({ path, sha256: hash(readFileSync(path)) });
  const files = { java: pin(java), time: pin('/usr/bin/time') };
  for (const [key, path] of Object.entries({ model: 'formal/ReservationOwnership.tla', config: 'formal/ReservationOwnership.cfg',
    scope: 'formal/ReservationOwnership.scope.json', source: 'src/experiments-reservations.ts' })) {
    const copy = join(root, key);
    writeFileSync(copy, readFileSync(new URL('../' + path, import.meta.url)));
    files[key] = pin(copy);
  }
  const jar = join(root, 'fake-checker.jar');
  writeFileSync(jar, 'Synthetic checker; never TLC.');
  files.jar = pin(jar);
  const plan = {
    approvedBy: 'focused-fake-checker-test',
    expiresAt: Date.now() + 60000,
    maxRuns: 2,
    outputDir: join(root, 'results'),
    files,
    runtime: { path: runtime, sha256: runtimeIdentity(runtime) },
  };
  return { root, plan };
}
const mac = { skip: process.platform !== 'darwin' };

test('host-pinned fake process produces revalidated model-only receipts and exact safe argv', mac, async t => {
  const f = fixture(t);
  const grant = prepareReservationCheck(f.plan);
  const reference = await runReservationCheck(grant);
  const result = readReservationCheck(reference, f.plan);

  assert.equal(result.status, 'bounded-model-checked');
  assert.equal(result.kind, 'model-only');
  assert.equal(result.codeLinkedProof, false);
  assert.equal(result.typescriptReplay, 'not-attempted');
  assert.equal(result.bounds.tokensPerKey, 3);
  assert.ok(result.execution.peakRssBytes > 0);
  const invocation = JSON.parse(readFileSync(join(reference.path, '..', 'invocation.json')));
  assert.ok(invocation.args.includes('-Xmx128m'));
  assert.deepEqual(invocation.args.slice(-6), ['-workers', '1', '-config', 'ReservationOwnership.cfg', '-tool', 'ReservationOwnership']);
  assert.equal(invocation.env.JAVA_TOOL_OPTIONS, undefined);
  await runReservationCheck(grant, 'allow-active');
  await assert.rejects(runReservationCheck(grant), /budget/);
  await assert.rejects(runReservationCheck(prepareReservationCheck(f.plan)), /consumed/);
  writeFileSync(join(reference.path, '..', 'stdout.txt'), 'changed');
  assert.throws(() => readReservationCheck(reference, f.plan), /identity/);
});

test('authorization, input/assumption drift and unsupported options reject before launch', mac, async t => {
  const f = fixture(t);
  for (const changes of [{ maxRuns: 4 }, { maxRuns: '2' }, { flags: ['-simulate'] }, { environment: {} }, { expiresAt: 1 }]) {
    assert.throws(() => prepareReservationCheck({ ...f.plan, ...changes }));
  }
  const grant = prepareReservationCheck(f.plan);

  await assert.rejects(runReservationCheck({}, 'none'), /host|grant/);
  await assert.rejects(runReservationCheck(grant, ['none']), /mutation/);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(runReservationCheck(grant, 'none', cancelled.signal));
  assert.equal(existsSync(f.plan.outputDir), false);
  for (const key of ['model', 'config', 'scope', 'source', 'jar', 'java']) {
    const path = f.plan.files[key].path;
    const bytes = readFileSync(path);
    writeFileSync(path, Buffer.concat([bytes, Buffer.from('\nchanged')]));
    await assert.rejects(runReservationCheck(grant), /identity|pin/);
    writeFileSync(path, bytes);
  }
  const scope = JSON.parse(readFileSync(f.plan.files.scope.path));
  scope.assumptions.push('Unauthorized assumption');
  writeFileSync(f.plan.files.scope.path, JSON.stringify(scope));
  f.plan.files.scope.sha256 = hash(readFileSync(f.plan.files.scope.path));
  assert.throws(() => prepareReservationCheck(f.plan), /scope|input/);
  assert.equal(existsSync(f.plan.outputDir), false);
});

test('process output limits and cancellation settle without a successful model result', mac, async t => {
  const limited = fixture(t, 'x'.repeat(70000));
  const limitedReference = await runReservationCheck(prepareReservationCheck(limited.plan));
  assert.equal(readReservationCheck(limitedReference, limited.plan).execution.status, 'output_limit');
  assert.ok(readFileSync(join(limitedReference.path, '..', 'stdout.txt')).length <= 65536);
  const cancelled = fixture(t);
  const grant = prepareReservationCheck(cancelled.plan);
  const reference = await runReservationCheck(grant, 'none', AbortSignal.timeout(1));
  const result = readReservationCheck(reference, cancelled.plan);
  assert.equal(result.execution.status, 'cancelled');
  assert.equal(result.status, 'unknown');
});

test('incomplete fake checker output remains unknown and receipt edits cannot elevate it', mac, async t => {
  const f = fixture(t, start);
  const reference = await runReservationCheck(prepareReservationCheck(f.plan));
  assert.equal(readReservationCheck(reference, f.plan).status, 'unknown');
  const receipt = JSON.parse(readFileSync(reference.path));
  receipt.bindings = '0'.repeat(64);
  writeFileSync(reference.path, JSON.stringify(receipt));
  assert.throws(() => readReservationCheck(reference, f.plan), /identity/);
});
