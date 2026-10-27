import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { calibratePredicate } from '../src/experiments-calibration.ts';
import { readRestrictedAttempt } from '../src/experiments-comparison.ts';
import { prepareOracle, syntheticControls } from './experiments-helpers.mjs';

test('two green controls, skips, unrelated failure and wrong context cannot calibrate a predicate', () => {
  const binding = prepareOracle();
  const controls = syntheticControls();
  assert.equal(calibratePredicate(binding, controls, 'optional-findings').status, 'calibrated');
  for (const changed of [
    { ...controls, failure: controls.pass },
    { ...controls, failure: { ...controls.failure, predicate: 'UNRESOLVED' } },
    { ...controls, infrastructure: { ...controls.infrastructure, status: 'completed' } },
    { ...controls, failure: { ...controls.failure, request: { ...controls.failure.request, input: '{"items":[]}' } } },
  ]) assert.equal(calibratePredicate(binding, changed, 'optional-findings').status, 'unresolved');
});

const saved = process.env.PI_AUTO_REVIEW_M1_ACCEPTANCE;
test('real pass, labeled target failure and setup controls calibrate mechanics, not requirement truth', { skip: !saved }, async () => {
  const summary = JSON.parse(await readFile(saved, 'utf8'));
  const attempts = await Promise.all(summary.attempts.map(item => readRestrictedAttempt(item.reference)));
  const controls = { pass: attempts[1], failure: attempts[2], infrastructure: attempts[4] };
  const result = calibratePredicate(summary.binding, controls, 'optional-findings');
  assert.equal(result.status, 'calibrated');
  assert.equal(result.requirementTruthEstablished, false);
  assert.equal(result.controls.length, 3);
  for (const changed of [
    { ...controls, failure: controls.pass },
    { ...controls, failure: { ...controls.failure, predicate: 'UNRESOLVED' } },
    { ...controls, infrastructure: { ...controls.infrastructure, status: 'completed' } },
    { ...controls, failure: { ...controls.failure, request: { ...controls.failure.request, input: '{"items":[]}' } } },
  ]) assert.equal(calibratePredicate(summary.binding, changed, 'optional-findings').status, 'unresolved');
  assert.equal(calibratePredicate(summary.binding, controls, 'other-input-class').status, 'unresolved');
});
