import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const { createJiti } = require('jiti');
const { describeFixture, approveTrustedFixture, claimFixture } = await createJiti(import.meta.url).import('../src/experiments-contract.ts');

function request(overrides = {}) {
  return {
    runId: 'fixture-demo',
    profile: 'trusted-fixture',
    source: 'export const double = value => value * 2;',
    probe: 'export default (subject, input, check) => check(subject.double(input), input * 2);',
    input: '3',
    targetId: 'double-value',
    limits: { timeoutMs: 2000, maxOutputBytes: 4096 },
    ...overrides,
  };
}

const approval = { approvedBy: 'test harness', maxAttempts: 2 };

test('captures exact fixture bytes and bounded runtime settings without retaining mutable inputs', () => {
  const input = request();
  const first = describeFixture(input);
  assert.equal(first.digest, describeFixture(request()).digest);
  assert.equal(first.runtime.version, process.version);
  assert.equal(first.runtime.executable, process.execPath);
  assert.match(first.identities.source, /^[a-f0-9]{64}$/);
  assert.notEqual(first.identities.source, first.identities.probe);
  input.limits.timeoutMs = 5;
  assert.equal(first.request.limits.timeoutMs, 2000);
  assert.ok(Object.isFrozen(first.request.limits));
  assert.notEqual(first.digest, describeFixture(input).digest);
});

test('requires an opaque host-issued grant rather than an approval-shaped object', () => {
  const input = request();
  for (const grant of [undefined, null, { approved: true }, { approvedBy: 'user' }]) {
    assert.throws(() => claimFixture(input, grant), /grant/i);
  }
  const grant = approveTrustedFixture(input, approval);
  assert.throws(() => claimFixture(input, { ...grant }), /grant/i);
  assert.equal(claimFixture(input, grant).approval.approvedBy, 'test harness');
});

test('binds authority to source, probe, input, target, run, profile and execution limits', () => {
  const input = request();
  const grant = approveTrustedFixture(input, approval);
  const changes = [
    { source: input.source + '\n' },
    { probe: input.probe + '\n' },
    { input: '4' },
    { targetId: 'another-target' },
    { runId: 'another-run' },
    { profile: 'restricted' },
    { limits: { ...input.limits, timeoutMs: 1000 } },
    { limits: { ...input.limits, maxOutputBytes: 2048 } },
  ];
  for (const change of changes) {
    assert.throws(() => claimFixture(request(change), grant));
  }
  assert.equal(claimFixture(input, grant).approval.attempt, 1);
});

test('consumes attempts synchronously and permits only the explicitly approved replay count', () => {
  const input = request();
  const grant = approveTrustedFixture(input, approval);
  assert.equal(claimFixture(input, grant).approval.attempt, 1);
  assert.equal(claimFixture(input, grant).approval.attempt, 2);
  assert.throws(() => claimFixture(input, grant), /exhausted/i);
  assert.throws(() => claimFixture(input, JSON.parse(JSON.stringify(grant))), /grant/i);
});

test('refuses invalid identities, oversized executable input, invalid JSON and unsafe limits', () => {
  const invalid = [
    { runId: '../other' },
    { targetId: '' },
    { source: 'a'.repeat(131073) },
    { probe: '' },
    { input: 'undefined' },
    { limits: { timeoutMs: 0, maxOutputBytes: 1 } },
    { limits: { timeoutMs: 30001, maxOutputBytes: 1 } },
    { limits: { timeoutMs: NaN, maxOutputBytes: 1 } },
    { limits: { timeoutMs: 1, maxOutputBytes: 1048577 } },
  ];
  for (const change of invalid) assert.throws(() => describeFixture(request(change)));
  assert.throws(() => approveTrustedFixture(request(), { ...approval, approvedBy: '' }));
  assert.throws(() => approveTrustedFixture(request(), { ...approval, maxAttempts: 0 }));
});
