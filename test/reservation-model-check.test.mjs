import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { interpretCheck, directoryIdentity, prepareReservationCheck, runReservationCheck, readReservationCheck, verifyReservationModel } from '../src/reservation-model-check.ts';
import { planModelChecks } from '../src/model-check-contract.ts';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const line = fields => `${JSON.stringify(fields)}\n`;
const passed = { status: 'success', invariant: null, trace: 0, generated: 12, distinct: 5, queued: 0 };
const broke = { status: 'invariant-violation', invariant: 'NoUnjustifiedReacquisition', trace: 2, generated: 12, distinct: 5, queued: 3 };
const observed = (stdout = line(passed), exitCode = 0) => ({ status: 'completed', exitCode, stdout, stderr: '' });
const bundled = name => readFileSync(new URL(`../formal/ReservationOwnership.${name}`, import.meta.url), 'utf8');
const plannedChecks = planModelChecks(bundled('checks'), bundled('cfg'), bundled('tla')).length;
const success = { status: 'success', generatedStates: 12, distinctStates: 5, queuedStates: 0, depth: 3 };
const returns = result => `export async function check() { return ${JSON.stringify(result)}; }\n`;
// Breaks the named rule whenever a check turns a safeguard off or asks for a control, like a model that meets its contract.
const meetsContract = `export async function check({ config }) {
  const rule = config.trim().split('\\n').at(-1).trim();
  if (!config.includes('= FALSE') && !rule.startsWith('Never')) return ${JSON.stringify(success)};
  return { status: 'invariant-violation', violation: { name: rule, trace: [{}, {}] }, generatedStates: 12, distinctStates: 5, queuedStates: 3, depth: 2 };
}
`;

test('a passing check needs one complete result line from a finished run', () => {
  assert.deepEqual(interpretCheck(observed()), { status: 'bounded-model-checked', generated: 12, distinct: 5 });
  for (const output of [observed(''), observed(JSON.stringify(passed)), observed(line(passed) + line(passed)), observed('{not json}\n'),
    observed('Model checking completed. No error has been found.\n'), observed(line({ ...passed, queued: 2 })),
    observed(line({ ...passed, distinct: 0, generated: 0 })), observed(line({ ...passed, generated: 4 })),
    observed(line({ ...passed, distinct: 2 ** 53, generated: 2 ** 53 })), observed(line({ ...passed, distinct: 4.5 })),
    observed(line({ ...passed, distinct: '5' })), observed(line({ ...passed, depth: 3 })), observed(line({ ...passed, queued: undefined })),
    observed(line({ ...passed, status: 'deadlock' })), observed(line({ ...passed, status: 'error' })),
    observed(line({ ...passed, invariant: 'TypeOK' })), observed(line(passed), 1),
    ...['timeout', 'cancelled', 'output_limit', 'process_error', 'stale-input'].map(status => ({ ...observed(), status }))]) {
    assert.equal(interpretCheck(output).status, 'unknown', JSON.stringify(output));
  }
});

test('a model counterexample names its invariant and needs a trace', () => {
  assert.deepEqual(interpretCheck(observed(line(broke))), { status: 'model-counterexample', invariant: 'NoUnjustifiedReacquisition' });
  assert.equal(interpretCheck(observed(line({ ...broke, invariant: 'NeverFenced' }))).invariant, 'NeverFenced');
  for (const fields of [{ ...broke, trace: 0 }, { ...broke, queued: -1 }, { ...broke, invariant: null }, { ...broke, invariant: 7 }, { ...broke, invariant: 'Two words' },
    { ...broke, status: 'property-violation' }, { ...broke, status: 'liveness-violation' }]) {
    assert.equal(interpretCheck(observed(line(fields))).status, 'unknown', JSON.stringify(fields));
  }
  assert.equal(interpretCheck(observed(line(broke), 12)).status, 'unknown');
});

function fixture(t, program = returns(success)) {
  const root = mkdtempSync(join(tmpdir(), 'reservation-model-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checker = join(root, 'tla-ts');
  mkdirSync(join(checker, 'dist'), { recursive: true });
  writeFileSync(join(checker, 'package.json'), JSON.stringify({ name: 'tla-ts', version: '0.0.3', type: 'module' }));
  writeFileSync(join(checker, 'dist', 'index.js'), `import { writeFileSync } from 'node:fs';
writeFileSync('invocation.json', JSON.stringify({ argv: process.argv.slice(1), execArgv: process.execArgv, env: process.env }));
${program}`);
  const pin = path => ({ path, sha256: hash(readFileSync(path)) });
  const files = { node: pin(process.execPath), time: pin('/usr/bin/time') };
  for (const [key, path] of Object.entries({ model: 'formal/ReservationOwnership.tla', config: 'formal/ReservationOwnership.cfg',
    checks: 'formal/ReservationOwnership.checks', scope: 'formal/ReservationOwnership.scope.json', source: 'src/experiments-reservations.ts' })) {
    const copy = join(root, key);
    writeFileSync(copy, readFileSync(new URL('../' + path, import.meta.url)));
    files[key] = pin(copy);
  }
  const plan = {
    approvedBy: 'focused-fake-checker-test',
    expiresAt: Date.now() + 60000,
    maxRuns: 2,
    outputDir: join(root, 'results'),
    files,
    checker: { path: checker, sha256: directoryIdentity(checker) },
  };
  return { root, plan };
}
const mac = { skip: process.platform !== 'darwin' };

test('the pinned checker runs through the runner with exact arguments and a clean environment', mac, async t => {
  const f = fixture(t);
  const grant = prepareReservationCheck(f.plan);
  const reference = await runReservationCheck(grant);
  const result = readReservationCheck(reference, f.plan);

  assert.equal(result.status, 'bounded-model-checked');
  assert.equal(result.check.kind, 'safe');
  assert.equal(result.grade, 'pass');
  assert.equal(result.kind, 'model-only');
  assert.equal(result.codeLinkedProof, false);
  assert.equal(result.typescriptReplay, 'not-attempted');
  assert.equal(result.bounds.tokensPerKey, 3);
  assert.ok(result.execution.peakRssBytes > 0);
  const invocation = JSON.parse(readFileSync(join(reference.path, '..', 'invocation.json')));
  assert.deepEqual(invocation.execArgv, ['--max-old-space-size=128']);
  assert.ok(invocation.argv[0].endsWith(join('src', 'model-check-runner.mjs')));
  assert.deepEqual(invocation.argv.slice(1), [join(f.plan.checker.path, 'dist', 'index.js'), 'ReservationOwnership']);
  // CoreFoundation, which Node links on macOS, adds __CF_USER_TEXT_ENCODING inside the child itself.
  assert.deepEqual(Object.keys(invocation.env).filter(key => key !== '__CF_USER_TEXT_ENCODING').sort(), ['HOME', 'LANG', 'LC_ALL', 'TMPDIR']);
  await runReservationCheck(grant, 2);
  await assert.rejects(runReservationCheck(grant), /budget/);
  await assert.rejects(runReservationCheck(prepareReservationCheck(f.plan)), /consumed/);
  writeFileSync(join(reference.path, '..', 'stdout.txt'), 'changed');
  assert.throws(() => readReservationCheck(reference, f.plan), /identity/);
});

test('authorization, input/assumption drift and unsupported options reject before launch', mac, async t => {
  const f = fixture(t);
  for (const changes of [{ maxRuns: plannedChecks + 1 }, { maxRuns: '2' }, { flags: ['-simulate'] }, { environment: {} }, { expiresAt: 1 },
    { files: { ...f.plan.files, node: f.plan.files.time } }]) {
    assert.throws(() => prepareReservationCheck({ ...f.plan, ...changes }));
  }
  const grant = prepareReservationCheck(f.plan);

  await assert.rejects(runReservationCheck({}, 'none'), /host|grant/);
  for (const check of [['0'], 1.5, -1, plannedChecks]) await assert.rejects(runReservationCheck(grant, check), /Unsupported model check/);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(runReservationCheck(grant, 0, cancelled.signal));
  assert.equal(existsSync(f.plan.outputDir), false);
  const entry = join(f.plan.checker.path, 'dist', 'index.js');
  for (const path of [...['model', 'config', 'checks', 'scope', 'source'].map(key => f.plan.files[key].path), entry]) {
    const bytes = readFileSync(path);
    writeFileSync(path, Buffer.concat([bytes, Buffer.from('\n// changed')]));
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

test('an added, changed or linked file anywhere in the checker directory stops the run', mac, async t => {
  const f = fixture(t);
  const grant = prepareReservationCheck(f.plan);
  const extra = join(f.plan.checker.path, 'dist', 'extra.js');
  for (const [add, remove] of [[() => writeFileSync(extra, ''), () => rmSync(extra)], [() => symlinkSync('index.js', extra), () => rmSync(extra)],
    [() => writeFileSync(join(f.plan.checker.path, 'README.md'), 'changed'), () => rmSync(join(f.plan.checker.path, 'README.md'))]]) {
    add();
    await assert.rejects(runReservationCheck(grant), /identity|pinned file/);
    remove();
  }
  assert.equal(existsSync(f.plan.outputDir), false);

  const late = fixture(t, `export async function check() { writeFileSync(new URL('./late.js', import.meta.url), ''); return ${JSON.stringify(success)}; }\n`);
  const reference = await runReservationCheck(prepareReservationCheck(late.plan));
  assert.equal(JSON.parse(readFileSync(reference.path)).execution.status, 'stale-input');
  assert.throws(() => readReservationCheck(reference, late.plan), /identity/);
});

test('a checker package other than tla-ts 0.0.3 is refused even when the host pins it', mac, t => {
  const f = fixture(t);
  for (const manifest of [{ name: 'tla-ts', version: '0.0.4' }, { name: 'not-tla-ts', version: '0.0.3' }]) {
    writeFileSync(join(f.plan.checker.path, 'package.json'), JSON.stringify({ ...manifest, type: 'module' }));
    const checker = { path: f.plan.checker.path, sha256: directoryIdentity(f.plan.checker.path) };
    assert.throws(() => prepareReservationCheck({ ...f.plan, checker }), /Unsupported model checker/, JSON.stringify(manifest));
  }
});

test('process output limits and cancellation settle without a successful model result', mac, async t => {
  const limited = fixture(t, `export async function check() { process.stdout.write('x'.repeat(70000)); return ${JSON.stringify(success)}; }\n`);
  const limitedReference = await runReservationCheck(prepareReservationCheck(limited.plan));
  assert.equal(readReservationCheck(limitedReference, limited.plan).execution.status, 'output_limit');
  assert.ok(readFileSync(join(limitedReference.path, '..', 'stdout.txt')).length <= 65536);
  const cancelled = fixture(t);
  const grant = prepareReservationCheck(cancelled.plan);
  const reference = await runReservationCheck(grant, 0, AbortSignal.timeout(1));
  const result = readReservationCheck(reference, cancelled.plan);
  assert.equal(result.execution.status, 'cancelled');
  assert.equal(result.status, 'unknown');
});

test('incomplete or crashed checker output remains unknown and receipt edits cannot elevate it', mac, async t => {
  const crashed = fixture(t, 'export async function check() { throw new Error("unsupported feature"); }\n');
  const crash = readReservationCheck(await runReservationCheck(prepareReservationCheck(crashed.plan)), crashed.plan);
  assert.equal(crash.status, 'unknown');
  assert.notEqual(crash.execution.exitCode, 0);
  const f = fixture(t, returns({ status: 'success' }));
  const reference = await runReservationCheck(prepareReservationCheck(f.plan));
  assert.equal(readReservationCheck(reference, f.plan).status, 'unknown');
  const receipt = JSON.parse(readFileSync(reference.path));
  receipt.bindings = '0'.repeat(64);
  writeFileSync(reference.path, JSON.stringify(receipt));
  assert.throws(() => readReservationCheck(reference, f.plan), /identity/);
});

test('a re-pinned receipt relabeled to another check or the old schema is rejected', mac, async t => {
  const f = fixture(t);
  const reference = await runReservationCheck(prepareReservationCheck(f.plan));
  const receipt = JSON.parse(readFileSync(reference.path));
  for (const change of [{ check: 1 }, { check: plannedChecks }, { schemaVersion: 1 }]) {
    writeFileSync(reference.path, JSON.stringify({ ...receipt, ...change }));
    const repinned = { path: reference.path, sha256: hash(readFileSync(reference.path)) };
    assert.throws(() => readReservationCheck(repinned, f.plan), /identity mismatch/, JSON.stringify(change));
  }
});

test('the model meets its check contract only when every planned check meets its expectation', mac, async t => {
  const meets = fixture(t, meetsContract);
  const verified = await verifyReservationModel(prepareReservationCheck({ ...meets.plan, maxRuns: plannedChecks }));
  assert.equal(verified.status, 'contract-verified');
  assert.equal(verified.results.length, plannedChecks);
  assert.ok(verified.results.every(result => result.grade === 'pass'));
  assert.deepEqual(new Set(verified.results.map(result => result.check.kind)), new Set(['safe', 'mutant', 'control']));

  const blind = fixture(t);
  const failed = await verifyReservationModel(prepareReservationCheck({ ...blind.plan, maxRuns: plannedChecks }));
  assert.equal(failed.status, 'contract-failed');
  for (const result of failed.results) assert.equal(result.grade, result.check.kind === 'safe' ? 'pass' : 'fail');

  const unfinished = fixture(t, returns({ status: 'success' }));
  assert.equal((await verifyReservationModel(prepareReservationCheck({ ...unfinished.plan, maxRuns: plannedChecks }))).status, 'unknown');

  const short = fixture(t);
  await assert.rejects(verifyReservationModel(prepareReservationCheck(short.plan)), /does not cover every planned check/);
  assert.equal(existsSync(short.plan.outputDir), false);
});
