import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluationIdentity, scoreEvaluation } from '../evaluation/scoring.ts';

const sha = 'a'.repeat(64);
const plan = () => ({
  schemaVersion: 1, corpusSha256: sha, model: 'fixture/model', thinking: 'high',
  variants: [{ id: 'source', sha256: sha }, { id: 'runtime', sha256: 'b'.repeat(64) }],
  budget: { modelCalls: 4, inputTokens: 2000, outputTokens: 1000, executionAttempts: 3, costUsd: 1 },
  cases: [
    { id: 'restore', base: '1'.repeat(40), head: '2'.repeat(40), knownDefects: ['restoration-shape'] },
    { id: 'progress', base: '3'.repeat(40), head: '4'.repeat(40), knownDefects: ['progress-reset'] },
    { id: 'thinking', base: '5'.repeat(40), head: '6'.repeat(40), knownDefects: [] },
  ],
});
const run = (frozen, caseId, variant = 'source', options = {}) => ({
  planId: evaluationIdentity(frozen), caseId, variant, status: 'complete', findings: [], ...options,
});
const judgment = (findingId, verdict, extra = {}) => ({
  caseId: 'restore', variant: 'source', findingId, verdict,
  adjudicator: 'independent-reviewer', reason: 'Compared the actual causal claim with the frozen rule.', evidence: ['receipt-or-source-ref'], ...extra,
});

test('scores adjudicated defects, false positives, duplicates and unresolved novel findings separately', () => {
  const frozen = plan();
  const runs = [
    run(frozen, 'restore', 'source', { findings: ['one', 'again', 'wrong', 'new', 'pending'].map(id => ({ id })) }),
    run(frozen, 'progress'),
    run(frozen, 'thinking'),
  ];
  const scored = scoreEvaluation(frozen, runs, [
    judgment('one', 'known', { defectId: 'restoration-shape' }),
    judgment('again', 'known', { defectId: 'restoration-shape' }),
    judgment('wrong', 'false-positive'), judgment('new', 'novel'),
  ]).variants[0];

  assert.equal(scored.truePositives, 1);
  assert.equal(scored.falsePositives, 1);
  assert.equal(scored.duplicates, 1);
  assert.equal(scored.novel, 1);
  assert.equal(scored.unadjudicated, 1);
  assert.equal(scored.missedKnown, 1);
  assert.equal(scored.unassessedKnown, 0);
  assert.deepEqual(scored.precision, { numerator: 1, denominator: 2, value: 0.5 });
  assert.deepEqual(scored.recallAll, { numerator: 1, denominator: 2, value: 0.5 });
  assert.deepEqual(scored.recallRunnable, scored.recallAll);
});

test('includes missing, invalid and infrastructure cases without calling them passes or missed runnable defects', () => {
  const frozen = plan();
  const scored = scoreEvaluation(frozen, [
    run(frozen, 'restore', 'runtime', { status: 'infrastructure-error' }),
    run(frozen, 'progress', 'runtime', { status: 'invalid-fixture' }),
  ], []).variants[1];
  assert.deepEqual(scored.cases, { all: 3, runnable: 0, incomplete: 0, infrastructureError: 1, invalidFixture: 1, unsupported: 0, unknown: 1 });
  assert.equal(scored.missedKnown, 0);
  assert.equal(scored.unassessedKnown, 2);
  assert.deepEqual(scored.recallAll, { numerator: 0, denominator: 2, value: 0 });
  assert.deepEqual(scored.recallRunnable, { numerator: 0, denominator: 0, value: null });
  assert.deepEqual(scored.usage.costUsd, { total: null, knownTotal: 0, missingCases: 3 });
});

test('keeps actual known usage and missing metrics distinct, and counts supplied runtime receipts', () => {
  const frozen = plan();
  const scored = scoreEvaluation(frozen, [
    run(frozen, 'restore', 'runtime', {
      usage: {
        inputTokens: 100, outputTokens: 40, costUsd: 0.25,
        costBasis: 'usage-times-prices', wallMs: 1500,
      },
      execution: {
        attempts: 3, replayedFailures: 1, setupFailures: 1, invalidFixtures: 0,
        duplicates: 0, unresolved: 1, receipts: [sha],
      },
    }),
    run(frozen, 'progress', 'runtime', { usage: { inputTokens: 50, costUsd: null } }),
    run(frozen, 'thinking', 'runtime', { usage: { inputTokens: 0, costUsd: 0, costBasis: 'provider-reported' } }),
  ], []).variants[1];
  assert.deepEqual(scored.usage.inputTokens, { total: 150, knownTotal: 150, missingCases: 0 });
  assert.deepEqual(scored.usage.costUsd, { total: null, knownTotal: 0.25, missingCases: 1 });
  assert.deepEqual(scored.execution.replayedFailures, { total: null, knownTotal: 1, missingCases: 2 });
});

test('explicit duplicates must reference an adjudicated finding in the same case and variant', () => {
  const frozen = plan();
  const runs = [run(frozen, 'restore', 'source', { findings: [{ id: 'one' }, { id: 'again' }] })];
  const judgments = [judgment('again', 'duplicate', { duplicateOf: 'one' }), judgment('one', 'false-positive')];
  assert.equal(scoreEvaluation(frozen, runs, judgments).variants[0].duplicates, 1);
  judgments[0].duplicateOf = 'missing';
  assert.throws(() => scoreEvaluation(frozen, runs, judgments), /duplicate/i);
});

test('rejects stale plans, conflicting identities, unsupported gold links and fabricated numeric usage', () => {
  const frozen = plan();
  const valid = run(frozen, 'restore', 'source', { findings: [{ id: 'one' }] });
  assert.throws(() => scoreEvaluation(frozen, [{ ...valid, planId: 'b'.repeat(64) }], []), /plan/i);
  assert.throws(() => scoreEvaluation(frozen, [valid, valid], []), /duplicate run/i);
  assert.throws(() => scoreEvaluation(frozen, [{ ...valid, findings: [{ id: 'one' }, { id: 'one' }] }], []), /finding/i);
  assert.throws(() => scoreEvaluation(frozen, [valid], [judgment('one', 'known', { defectId: 'not-gold' })]), /defect/i);
  assert.throws(() => scoreEvaluation(frozen, [valid], [judgment('one', 'known', { defectId: 'restoration-shape' }), judgment('one', 'novel')]), /judgment/i);
  assert.throws(() => scoreEvaluation(frozen, [valid], [judgment('missing', 'novel')]), /finding/i);
  for (const costUsd of [-1, NaN, Infinity]) {
    assert.throws(() => scoreEvaluation(frozen, [{ ...valid, usage: { costUsd, costBasis: 'provider-reported' } }], []), /usage/i);
  }
  assert.throws(() => scoreEvaluation(frozen, [{ ...valid, usage: { costUsd: 0.1 } }], []), /cost basis/i);
  assert.throws(() => scoreEvaluation({ ...frozen, cases: [frozen.cases[0], frozen.cases[0]] }, [], []), /case/i);
  assert.throws(() => scoreEvaluation(frozen, [
    run(frozen, 'restore', 'source', { usage: { costUsd: Number.MAX_VALUE, costBasis: 'provider-reported' } }),
    run(frozen, 'progress', 'source', { usage: { costUsd: Number.MAX_VALUE, costBasis: 'provider-reported' } }),
  ], []), /total/i);
});
