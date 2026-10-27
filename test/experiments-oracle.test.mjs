import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, canonicalSha256, freezeOracle, assessClaim } from '../src/experiments-oracle.ts';

const sha = 'a'.repeat(64);
const evidence = (kind = 'repository-contract') => ({ kind, ref: 'prompts/finding.md', sha256: sha });
const requirement = () => ({
  id: 'optional-findings-nonblocking',
  statement: 'Optional nit and fix findings are nonblocking.',
  authority: evidence(),
  entryId: 'registerFindings',
  revisions: ['87bc85e61121be57051b8b341cb3653eb0d26270', 'c3bca5ff8623dedb11d956cc8f2199f2aac7b766'],
  inputClasses: ['nit', 'fix'],
  exceptions: [],
});
const oracle = () => ({
  targetCheckId: 'nit-blocking',
  targetSignature: 'nit finding must be nonblocking',
  normalizerVersion: 'finding-v1',
  normalizerSha256: 'b'.repeat(64),
});
const prepared = () => freezeOracle({ requirement: requirement(), oracle: oracle() });
const claim = (overrides = {}) => ({
  revision: requirement().revisions[1], inputClass: 'nit',
  claimKind: 'requirement-violation', verifiedTargetFailure: true, ...overrides,
});

test('canonical JSON sorts only object keys, preserves array order and hashes equivalent data identically', () => {
  const left = { z: [{ b: 2, a: 1 }, 'x'], a: { y: true, x: null } };
  const right = { a: { x: null, y: true }, z: [{ a: 1, b: 2 }, 'x'] };
  assert.equal(canonicalJson(left), '{"a":{"x":null,"y":true},"z":[{"a":1,"b":2},"x"]}');
  assert.equal(canonicalSha256(left), canonicalSha256(right));
  assert.notEqual(canonicalSha256(left), canonicalSha256({ ...left, z: [...left.z].reverse() }));
});

test('canonical serialization refuses unsupported values, nonfinite values, accessors and cycles', () => {
  const cycle = {}; cycle.self = cycle;
  const sparse = [, 1];
  const accessor = Object.defineProperty({}, 'x', { enumerable: true, get() { return 1; } });
  const invalid = [undefined, NaN, Infinity, -Infinity, 1n, Symbol('x'), () => 1,
    new Date(), new Number(2), sparse, { x: undefined }, accessor, cycle];
  for (const value of invalid) assert.throws(() => canonicalJson(value), TypeError);
  assert.throws(() => canonicalJson(Object.defineProperty({}, 'hidden', { get() { return 1; } })), TypeError);
});

test('freezes copied requirement and oracle, not mutable caller data; order-independent identity', () => {
  const input = { requirement: requirement(), oracle: oracle() };
  const result = freezeOracle(input);
  const equivalent = freezeOracle({ oracle: { ...input.oracle }, requirement: { ...input.requirement } });
  assert.equal(result.identity, equivalent.identity);
  input.requirement.authority.ref = 'changed';
  assert.equal(result.requirement.authority.ref, 'prompts/finding.md');
  assert.ok(Object.isFrozen(result.requirement.authority));
  assert.ok(Object.isFrozen(result.requirement.revisions));
  assert.ok(Object.isFrozen(result.oracle));
  assert.throws(() => { result.requirement.revisions.push('third'); }, TypeError);
});

test('evidence, oracle, and scoped intentional-change exceptions each change identity', () => {
  const baseline = prepared().identity;
  const changedEvidence = requirement(); changedEvidence.authority.sha256 = 'c'.repeat(64);
  const changedOracle = oracle(); changedOracle.normalizerSha256 = 'd'.repeat(64);
  const exception = { id: 'intended-change', evidence: evidence('user-criterion'),
    revisions: [requirement().revisions[1]], inputClasses: ['nit'] };
  const identities = [
    freezeOracle({ requirement: changedEvidence, oracle: oracle() }).identity,
    freezeOracle({ requirement: requirement(), oracle: changedOracle }).identity,
    freezeOracle({ requirement: { ...requirement(), exceptions: [exception] }, oracle: oracle() }).identity,
  ];
  for (const identity of identities) assert.notEqual(identity, baseline);
});

test('rejects malformed or underspecified authority, scopes and oracle bindings', () => {
  const wrong = [
    { requirement: { ...requirement(), authority: evidence('approved-spec') } },
    { requirement: { ...requirement(), authority: { ...evidence(), sha256: 'hash' } } },
    { requirement: { ...requirement(), revisions: [] } },
    { requirement: { ...requirement(), inputClasses: ['nit', 'nit'] } },
    { requirement: { ...requirement(), exceptions: [{ id: 'x', evidence: evidence(), revisions: [], inputClasses: ['nit'] }] } },
    { oracle: { ...oracle(), targetCheckId: '' } },
    { oracle: { ...oracle(), normalizerSha256: '' } },
    { requirement: { ...requirement(), arbitrary: true } },
    { requirement: { ...requirement(), exceptions: [{ id: 'x', evidence: evidence('implementation-inference'), revisions: [requirement().revisions[1]], inputClasses: ['nit'] }] } },
  ];
  for (const change of wrong) assert.throws(() => freezeOracle({ requirement: requirement(), oracle: oracle(), ...change }));
  const spoofed = requirement();
  delete spoofed.id;
  delete spoofed.statement;
  spoofed['id\0statement'] = 'spoof';
  assert.throws(() => freezeOracle({ requirement: spoofed, oracle: oracle() }));
});

test('revision and class applicability, and intentional-change exceptions, are explicit non-passes', () => {
  const binding = prepared();
  assert.equal(assessClaim(binding, claim()).status, 'eligible-violation');
  assert.equal(assessClaim(binding, claim({ revision: 'other' })).status, 'inapplicable');
  assert.equal(assessClaim(binding, claim({ inputClass: 'bug' })).status, 'inapplicable');
  const exception = { id: 'intended-change', evidence: evidence('user-criterion'),
    revisions: [requirement().revisions[1]], inputClasses: ['nit'] };
  const excepted = freezeOracle({ requirement: { ...requirement(), exceptions: [exception] }, oracle: oracle() });
  assert.deepEqual(assessClaim(excepted, claim()), { status: 'exceptioned', exceptionId: 'intended-change', eligible: false });
  assert.equal(assessClaim(excepted, claim({ revision: requirement().revisions[0] })).status, 'eligible-violation');
});

test('implementation inference cannot become a requirement violation; missing verified failure is observation only', () => {
  const inferred = freezeOracle({ requirement: { ...requirement(), authority: evidence('implementation-inference') }, oracle: oracle() });
  assert.deepEqual(assessClaim(inferred, claim()), { status: 'provisional-inference', eligible: false });
  assert.deepEqual(assessClaim(prepared(), claim({ verifiedTargetFailure: false })), { status: 'observation', eligible: false });
  assert.deepEqual(assessClaim(prepared(), claim({ claimKind: 'observation' })), { status: 'observation', eligible: false });
  assert.deepEqual(assessClaim(prepared(), claim({ claimKind: 'provisional-inference' })), { status: 'provisional-inference', eligible: false });
});
