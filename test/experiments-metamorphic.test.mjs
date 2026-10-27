import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../src/experiments-oracle.ts';
import { calibratePredicate } from '../src/experiments-calibration.ts';
import { prepareMemberOrderPair, runMemberOrderRelation } from '../src/experiments-metamorphic.ts';
import { finding, prepareOracle, syntheticControls, syntheticAttempt, prepareNodeExperiment } from './experiments-helpers.mjs';
import { approveRestricted } from '../src/experiments-restricted-contract.ts';
import { runRestrictedNode } from '../src/experiments-node.ts';
import { readRestrictedAttempt } from '../src/experiments-comparison.ts';

const input = canonicalJson({ items: [finding('nit'), finding('fix')] });
test('member-order transformation changes only object ordering, never arrays or values', () => {
  const pair = prepareMemberOrderPair(input);
  assert.notEqual(pair.left, pair.right);
  assert.deepEqual(JSON.parse(pair.left), JSON.parse(pair.right));
  assert.deepEqual(JSON.parse(pair.right).items.map(item => item.kind), ['nit', 'fix']);
  for (const invalid of ['{"items":[],"items":[]}', '{"items":[]}', '[]', '{invalid', '{"items":[{"kind":"bug"}]}']) {
    assert.throws(() => prepareMemberOrderPair(invalid));
  }
});

test('relation records both fresh executions and refuses unknown, mismatched or inapplicable results', async () => {
  const binding = prepareOracle(), controls = syntheticControls();
  const calibration = calibratePredicate(binding, controls, 'optional-findings');
  const template = { ...controls.pass.request, input };
  const run = async request => syntheticAttempt({ request, normalized: JSON.parse(request.input) });
  const equivalent = await runMemberOrderRelation(binding, template, calibration, run);
  assert.equal(equivalent.status, 'observed-equivalent');
  assert.equal(equivalent.attempts.length, 2);
  const different = await runMemberOrderRelation(binding, template, calibration, async request => syntheticAttempt({ request, normalized: { ordering: request.input } }));
  assert.equal(different.status, 'observed-difference');
  const unresolved = await runMemberOrderRelation(binding, template, calibration, async request => syntheticAttempt({ request, predicate: 'UNRESOLVED' }));
  assert.equal(unresolved.status, 'inconclusive');
  assert.equal((await runMemberOrderRelation(binding, { ...template, input: '{"items":[]}' }, calibration, run)).status, 'inapplicable');
  assert.equal((await runMemberOrderRelation(binding, template, { ...calibration, scope: 'changed' }, run)).status, 'inapplicable');
});

test('actual finding handler preserves normalized data after JSON member reordering', { skip: !process.env.PI_AUTO_REVIEW_DOCKER_TEST_BACKEND }, async t => {
  const f = await prepareNodeExperiment(t);
  const binding = prepareOracle();
  const pair = prepareMemberOrderPair(input);
  const template = f.request('head', pair.left);
  const requests = [f.request('head'), f.request('mutant'), f.request('setup'), template, f.request('head', pair.right)];
  const grant = approveRestricted(requests, f.approval);
  const run = async request => {
    const result = await runRestrictedNode(request, grant, f.artifacts, f.guard);
    return readRestrictedAttempt({ path: result.receipt.paths.receipt, sha256: result.sha256 });
  };
  const controls = { pass: await run(requests[0]), failure: await run(requests[1]), infrastructure: await run(requests[2]) };
  const calibration = calibratePredicate(binding, controls, 'optional-findings');
  const result = await runMemberOrderRelation(binding, template, calibration, run);
  assert.equal(result.status, 'observed-equivalent', result.reason);
  assert.equal(result.attempts.length, 2);
  assert.notEqual(result.attempts[0].attemptId, result.attempts[1].attemptId);
});
