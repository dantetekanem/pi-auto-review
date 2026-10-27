import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { digestBytes } from '../src/experiments-contract.ts';
import { reduceFindingWitness, reductionIdentity } from '../src/experiments-reduce.ts';
import { enumerateFamilyInputs, requestWithInput } from '../src/experiments-family.ts';
import { approveRestricted } from '../src/experiments-restricted-contract.ts';
import { runRestrictedNode } from '../src/experiments-node.ts';
import { readRestrictedAttempt } from '../src/experiments-comparison.ts';
import { finding, syntheticAttempt, prepareNodeExperiment } from './experiments-helpers.mjs';

test('reduction identity pins the loaded implementation bytes', () => {
  assert.equal(reductionIdentity(), digestBytes(readFileSync(new URL('../src/experiments-reduce.ts', import.meta.url))));
});

const atoms = [finding('fix'), finding('nit'), finding('fix', false, 'Other')];
function fixture(items = atoms, fails = items => items.some(item => item.kind === 'nit')) {
  const calls = [];
  const evidence = request => syntheticAttempt({ request, predicate: fails(JSON.parse(request.input).items) ? 'FAIL' : 'PASS',
    normalized: { items: JSON.parse(request.input).items } });
  const initial = evidence(syntheticAttempt({ request: { input: JSON.stringify({ items }) } }).request);
  const execute = async (request, phase) => { calls.push({ request, phase }); return evidence(request); };
  return { initial, execute, calls };
}

test('ordered single-deletion reduction freshly stabilizes, audits and replays the retained target', async () => {
  const f = fixture();
  const result = await reduceFindingWitness(f.initial, f.execute);
  assert.equal(result.status, 'completed');
  assert.equal(result.oneMinimal, true);
  assert.equal(result.originalItems, 3);
  assert.equal(result.reducedItems, 1);
  assert.deepEqual(JSON.parse(result.witness.request.input).items, [atoms[1]]);
  assert.deepEqual(f.calls.slice(0, 2).map(call => call.phase), ['stability', 'stability']);
  assert.ok(f.calls.some(call => call.phase === 'audit' && call.request.input === '{"items":[]}'));
  assert.equal(f.calls.at(-1).phase, 'replay');
  assert.equal(result.replay.predicate, 'FAIL');
  assert.notEqual(result.replay.attemptId, result.witness.attemptId);
  assert.equal(new Set([f.initial, ...result.attempts].map(a => a.attemptId)).size, result.attempts.length + 1);
});

test('nonmonotonic outcomes qualify only single-removal minimality, not a global minimum', async () => {
  const f = fixture(atoms, items => items.length === 3 || items.length === 0);
  const result = await reduceFindingWitness(f.initial, f.execute);
  assert.equal(result.oneMinimal, true);
  assert.equal(result.reducedItems, 3);
  assert.equal(f.calls.filter(call => call.phase === 'audit').length, 3);
  const empty = fixture([], () => true);
  const core = await reduceFindingWitness(empty.initial, empty.execute);
  assert.equal(core.status, 'completed');
  assert.equal(core.reducedItems, 0);
  assert.equal(core.oneMinimal, true);
});

test('unknown, unrelated failures and executor errors stop without retrying or minimality claims', async () => {
  for (const status of ['setup_error', 'not_observed', 'probe_error', 'timeout']) {
    const f = fixture();
    let count = 0;
    const result = await reduceFindingWitness(f.initial, async (request, phase) => {
      count++;
      return phase === 'stability' ? f.execute(request, phase)
        : syntheticAttempt({ request, predicate: 'UNRESOLVED', status });
    });
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.oneMinimal, false);
    assert.equal(count, 3);
  }
  const f = fixture();
  let count = 0;
  const result = await reduceFindingWitness(f.initial, async () => {
    count++;
    throw Error('shared budget exhausted');
  });
  assert.match(result.reason, /shared budget exhausted/);
  assert.equal(count, 1);
});

test('fresh evidence must preserve request, distinct attempt identity and normalized observations', async () => {
  for (const change of [
    (a, f) => ({ ...a, attemptId: f.initial.attemptId }),
    a => ({ ...a, requestDigest: '0'.repeat(64) }),
    a => ({ ...a, request: { ...a.request, targetId: 'other' } }),
    a => ({ ...a, normalized: { changed: true } }),
    a => ({ ...a, predicate: 'PASS' }),
    a => ({ ...a, status: 'probe_error' }),
  ]) {
    const f = fixture();
    const result = await reduceFindingWitness(f.initial, async (request, phase) => change(await f.execute(request, phase), f));
    assert.equal(result.status, 'inconclusive'); assert.equal(result.oneMinimal, false);
  }
  for (const phaseToChange of ['audit', 'replay']) {
    const f = fixture();
    const result = await reduceFindingWitness(f.initial, async (request, phase) => {
      const attempt = await f.execute(request, phase);
      return phase === phaseToChange ? { ...attempt, normalized: { changed: true } } : attempt;
    });
    assert.equal(result.status, 'inconclusive'); assert.equal(result.oneMinimal, false);
  }
});

test('domain, evaluation, minimum and cancellation bounds fail honestly', async () => {
  for (const items of [[atoms[0], atoms[0]], Array.from({ length: 5 }, (_, i) => finding('nit', true, String(i))), [{ kind: 'bug', blocks: true }]]) {
    const f = fixture(items, () => true);
    assert.equal((await reduceFindingWitness(f.initial, f.execute)).status, 'inconclusive'); assert.equal(f.calls.length, 0);
  }
  for (const options of [{ maxEvaluations: 0 }, { maxEvaluations: 33 }, { maxEvaluations: 1.5 }, { minItems: -1 }, { minItems: 4 }]) {
    const f = fixture(); assert.equal((await reduceFindingWitness(f.initial, f.execute, options)).status, 'inconclusive');
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  const bounded = await reduceFindingWitness(f.initial, f.execute, { maxEvaluations: 2 });
  assert.equal(bounded.status, 'inconclusive');
  assert.equal(f.calls.length, 2);

  const minimum = fixture();
  const limited = await reduceFindingWitness(minimum.initial, minimum.execute, { minItems: 1 });
  assert.equal(limited.oneMinimal, false);
  assert.equal(limited.status, 'inconclusive');

  const controller = new AbortController();
  controller.abort();
  const cancelled = fixture();
  assert.equal((await reduceFindingWitness(cancelled.initial, cancelled.execute, { signal: controller.signal })).status, 'inconclusive');
  assert.equal(cancelled.calls.length, 0);
  const mid = fixture();
  const during = new AbortController();
  const stopped = await reduceFindingWitness(mid.initial, async (request, phase) => {
    const attempt = await mid.execute(request, phase);
    during.abort();
    return attempt;
  }, { signal: during.signal });
  assert.equal(stopped.status, 'inconclusive');
  assert.equal(mid.calls.length, 1);
});

test('authorized Docker mutant reduces to a stable nit and freshly replays verified receipt evidence', {
  skip: !process.env.PI_AUTO_REVIEW_DOCKER_TEST_BACKEND, timeout: 120000,
}, async t => {
  const f = await prepareNodeExperiment(t);
  const spec = { version: 'optional-findings-v1', seed: 17, trials: 1, inputClass: 'optional-findings', domain: { atoms, minItems: 0 } };
  const inputs = enumerateFamilyInputs(spec);
  const template = f.request('mutant', inputs.at(-1));
  const grant = approveRestricted(inputs.map(input => requestWithInput(template, input)), f.approval);
  const execute = async request => {
    const result = await runRestrictedNode(request, grant, f.artifacts, f.guard);
    return readRestrictedAttempt({ path: result.receipt.paths.receipt, sha256: result.sha256 });
  };
  const initial = await execute(template);
  const result = await reduceFindingWitness(initial, execute);
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.oneMinimal, true);
  assert.equal(result.reducedItems, 1);
  assert.deepEqual(JSON.parse(result.witness.request.input).items, [atoms[1]]);
  assert.equal(result.replay.predicate, 'FAIL');
  assert.notEqual(result.replay.attemptId, result.witness.attemptId);
  assert.equal(result.replay.request.source.mutation.label, 'sensitivity-control');
  assert.ok(result.attempts.some(a => a.request.input === '{"items":[]}' && a.predicate === 'PASS'));
});
