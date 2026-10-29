import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExperimentReservations, experimentKey } from '../src/experiments-reservations.ts';

const request = { runId: 'run', source: { revision: 'source' }, input: 'input', probe: 'probe', environment: 'environment' };
const oracle = 'a'.repeat(64);
const key = experimentKey(request, oracle);
const result = (attemptId = 'attempt-1', cleanupConfirmed = true) => ({ attemptId, cleanupConfirmed });

function fixture() {
  let now = 100;
  const reservations = new ExperimentReservations(() => now);
  return { reservations, reserve: replayOf => reservations.reserve(key, 200, replayOf), setNow: value => { now = value; } };
}

test('canonical key ignores run IDs and object order but includes source, input, probe, environment, oracle and schedule', () => {
  assert.equal(key, experimentKey({ ...request, runId: 'another-run' }, oracle));
  assert.equal(key, experimentKey(Object.fromEntries(Object.entries(request).reverse()), oracle));
  for (const field of ['source', 'input', 'probe', 'environment']) assert.notEqual(key, experimentKey({ ...request, [field]: 'changed' }, oracle));
  assert.notEqual(key, experimentKey(request, 'b'.repeat(64)));
  assert.notEqual(key, experimentKey(request, oracle, 'different-schedule'));
});

test('simultaneous duplicates reserve once; a completed observation is not silently reused', async () => {
  const f = fixture();
  const attempts = await Promise.allSettled([Promise.resolve().then(() => f.reserve()), Promise.resolve().then(() => f.reserve())]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  const token = attempts.find(item => item.status === 'fulfilled').value;
  f.reservations.settle(token, result());
  assert.throws(() => f.reserve(), /explicit replay/i);
});

test('explicit replay follows the latest settled attempt; concurrent or stale replay requests cannot start twice', () => {
  const f = fixture();
  const first = f.reserve();
  assert.throws(() => f.reserve('attempt-1'), /active|fenced/i);
  f.reservations.settle(first, result());
  const replay = f.reserve('attempt-1');
  assert.notEqual(replay, first);
  assert.throws(() => f.reserve('attempt-1'), /active|fenced/i);
  f.reservations.settle(replay, result('attempt-2'));
  assert.throws(() => f.reserve('attempt-1'), /latest/i);
  f.reservations.settle(f.reserve('attempt-2'), result('attempt-3'));
  assert.throws(() => f.reservations.reserve('b'.repeat(64), 200, 'attempt-3'), /replay/i);
});

test('expiry, lost result and unconfirmed cleanup keep ownership fenced', () => {
  for (const mode of ['expired', 'lost', 'cleanup']) {
    const f = fixture();
    const token = f.reserve();
    if (mode === 'expired') {
      f.setNow(200);
      assert.throws(() => f.reservations.settle(token, result()), /expired|late/i);
    } else if (mode === 'lost') f.reservations.fence(token);
    else assert.throws(() => f.reservations.settle(token, result('attempt-1', false)), /cleanup|fenced/i);
    assert.throws(() => f.reservations.reserve(key, 500, 'attempt-1'), /fenced/i);
  }
});

test('unknown tokens and late duplicate settlements cannot change completed ownership', () => {
  const f = fixture();
  assert.throws(() => f.reservations.settle({}, result()), /reservation/i);
  const token = f.reserve();
  f.reservations.settle(token, result());
  assert.throws(() => f.reservations.settle(token, result('different')), /reservation/i);
  const next = f.reserve('attempt-1');
  assert.throws(() => f.reservations.settle(token, result('different')), /reservation/i);
  f.reservations.settle(next, result('attempt-2'));
});
