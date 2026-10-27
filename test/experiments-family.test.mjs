import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateFindingFamily, enumerateFamilyInputs, runFindingFamily } from '../src/experiments-family.ts';
import { calibratePredicate } from '../src/experiments-calibration.ts';
import { canonicalSha256 } from '../src/experiments-oracle.ts';
import { finding, prepareOracle, syntheticControls, syntheticAttempt } from './experiments-helpers.mjs';

const spec = () => ({ version: 'optional-findings-v1', seed: 17, trials: 6, inputClass: 'optional-findings',
  domain: { atoms: [finding('nit'), finding('fix', false), finding('nit', false, 'Another suggestion')], minItems: 0 } });

function context() {
  const controls = syntheticControls();
  const binding = prepareOracle();
  return { binding, template: controls.pass.request, calibration: calibratePredicate(binding, controls, 'optional-findings') };
}

test('seed/version/domain deterministically generate bounded input sets and diversity counts', () => {
  const first = generateFindingFamily(spec());
  assert.deepEqual(generateFindingFamily(spec()), first);
  assert.equal(first.generated, 6);
  assert.equal(first.accepted + first.rejected, first.generated);
  assert.equal(Object.values(first.classes).reduce((a, b) => a + b, 0), first.generated);
  assert.equal(enumerateFamilyInputs(spec()).length, 8);
  assert.notDeepEqual(generateFindingFamily({ ...spec(), seed: 18 }).trials, first.trials);
  assert.notEqual(generateFindingFamily({ ...spec(), seed: 18 }).identity, first.identity);
  assert.throws(() => generateFindingFamily({ ...spec(), version: 'invented' }));
  assert.throws(() => generateFindingFamily({ ...spec(), trials: 1000 }));
  assert.throws(() => generateFindingFamily({ ...spec(), domain: { ...spec().domain, atoms: Array(5).fill(finding()) } }));
});

test('one family call runs accepted trials serially and keeps each request/result identity', async () => {
  const { binding, template, calibration } = context();
  let active = 0;
  const run = async request => {
    assert.equal(++active, 1);
    await Promise.resolve();
    active--;
    return syntheticAttempt({ request, normalized: JSON.parse(request.input) });
  };
  const result = await runFindingFamily(spec(), binding, template, calibration, run);
  assert.equal(result.status, 'completed');
  assert.equal(result.executed, result.accepted);
  assert.ok(result.outcomes.every(outcome => outcome.attempt.predicate === 'PASS'));
  assert.equal(result.kind, 'revision-observation');
  assert.equal(new Set(result.outcomes.map(outcome => outcome.attempt.attemptId)).size, result.executed);
  const changedDomain = { ...spec(), domain: { ...spec().domain, minItems: 3 } };
  assert.notEqual(generateFindingFamily(changedDomain).identity, generateFindingFamily(spec()).identity);
  assert.equal(canonicalSha256(result.binding), binding.identity);
});

test('all rejected, uncalibrated, interrupted, exhausted and unresolved families stay inconclusive', async () => {
  const { binding, template, calibration } = context();
  const allRejected = { ...spec(), trials: 1, domain: { ...spec().domain, minItems: 3 } };
  let calls = 0;
  const run = async request => { calls++; return syntheticAttempt({ request }); };
  const rejected = await runFindingFamily(allRejected, binding, template, calibration, run);
  assert.equal(rejected.accepted, 0);
  assert.equal(rejected.status, 'inconclusive');
  assert.equal(calls, 0);
  const uncalibrated = await runFindingFamily(spec(), binding, template, { ...calibration, status: 'unresolved' }, run);
  assert.equal(uncalibrated.status, 'inconclusive');
  assert.equal(calls, 0);
  const unknown = await runFindingFamily(spec(), binding, template, calibration, async request => syntheticAttempt({ request, predicate: 'UNRESOLVED' }));
  assert.equal(unknown.status, 'inconclusive');
  const exhausted = await runFindingFamily(spec(), binding, template, calibration, async () => { throw new Error('cumulative budget exhausted'); });
  assert.match(exhausted.reason, /budget exhausted/);
  assert.equal(exhausted.status, 'inconclusive');
  const controller = new AbortController(); controller.abort();
  const cancelled = await runFindingFamily(spec(), binding, template, calibration, run, controller.signal);
  assert.equal(cancelled.status, 'inconclusive');
  const wrong = await runFindingFamily(spec(), binding, template, calibration, async () => syntheticAttempt({ request: { ...template, input: '{"wrong":true}' } }));
  assert.equal(wrong.status, 'inconclusive');
});
