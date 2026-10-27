import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { approveRestricted } from '../src/experiments-restricted-contract.ts';
import { runRestrictedNode } from '../src/experiments-node.ts';
import { compareAttempts, readRestrictedAttempt } from '../src/experiments-comparison.ts';
import { freezeOracle } from '../src/experiments-oracle.ts';
import { prepareNodeExperiment, prepareOracle } from './experiments-helpers.mjs';

const known = (source, predicate) => ({ ...source, predicate });
test('comparison requires matching frozen context and leaves unavailable bases unknown', { skip: !process.env.PI_AUTO_REVIEW_DOCKER_TEST_BACKEND }, async t => {
  const f = await prepareNodeExperiment(t);
  const binding = prepareOracle();
  const requests = [f.request('base'), f.request('head'), f.request('mutant'), f.request('setup')];
  const grant = approveRestricted(requests, f.approval);
  const attempts = [];
  for (const index of [0, 1, 2, 2, 3]) {
    const result = await runRestrictedNode(requests[index], grant, f.artifacts, f.guard);
    attempts.push(await readRestrictedAttempt({ path: result.receipt.paths.receipt, sha256: result.sha256 }));
  }
  const [base, head, mutant, replay, setup] = attempts;
  assert.equal(compareAttempts(binding, base, head, 'optional-findings').status, 'compatible');
  assert.equal(compareAttempts(binding, head, mutant, 'optional-findings').status, 'sensitivity-control');
  assert.equal(setup.predicate, 'UNRESOLVED');
  assert.equal(compareAttempts(binding, setup, head, 'optional-findings').status, 'incompatible');
  assert.equal(compareAttempts(binding, known(base, 'UNRESOLVED'), head, 'optional-findings').status, 'unknown');
  assert.notEqual(mutant.attemptId, replay.attemptId);
  assert.equal(mutant.requestDigest, replay.requestDigest);
  assert.equal(mutant.predicate, 'FAIL');
  assert.deepEqual(mutant.normalized, replay.normalized);
  const changedSignature = freezeOracle({ requirement: binding.requirement, oracle: { ...binding.oracle, targetSignature: 'unrelated target' } });
  assert.equal(compareAttempts(changedSignature, base, head, 'optional-findings').status, 'incompatible');
  const changed = { ...head, request: { ...head.request, input: '{"items":[]}' } };
  assert.equal(compareAttempts(binding, base, changed, 'optional-findings').status, 'incompatible');
  assert.equal(compareAttempts(binding, known(base, 'PASS'), known(head, 'FAIL'), 'optional-findings').status, 'introduced-violation');
  assert.equal(compareAttempts(binding, known(base, 'PASS'), known(head, 'FAIL'), 'unrelated-class').status, 'inapplicable');
  const original = readFileSync(head.reference.path);
  writeFileSync(head.reference.path, '{}');
  await assert.rejects(readRestrictedAttempt(head.reference), /identity|digest/);
  writeFileSync(head.reference.path, original);
  writeFileSync(head.outputs.stdout, 'fabricated');
  await assert.rejects(readRestrictedAttempt(head.reference), /identity|digest/);
});
