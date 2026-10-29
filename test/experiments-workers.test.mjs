import assert from 'node:assert/strict';
import test from 'node:test';
import { runWorkerBatch } from '../src/experiments-workers.ts';

const deferred = () => Promise.withResolvers();

test('fixed waves cap worker leases, retain input order and drain before reusing slots', async () => {
  const jobs = ['one', 'two', 'three'];
  const releases = jobs.map(deferred);
  const started = [];
  const secondStarted = deferred();
  const thirdStarted = deferred();
  const pending = runWorkerBatch(jobs, 2, async (id, slot) => {
    started.push({ id, slot });
    if (id === 'two') secondStarted.resolve();
    if (id === 'three') thirdStarted.resolve();
    await releases[jobs.indexOf(id)].promise;
    return id.toUpperCase();
  });
  await secondStarted.promise;
  assert.deepEqual(started, [{ id: 'one', slot: 0 }, { id: 'two', slot: 1 }]);
  releases[1].resolve();
  await Promise.resolve();
  assert.equal(started.length, 2);
  releases[0].resolve();
  await thirdStarted.promise;
  releases[2].resolve();
  const result = await pending;
  assert.deepEqual(result.outcomes.map(item => item.value), ['ONE', 'TWO', 'THREE']);
  assert.equal(result.peakWorkers, 2);
  assert.equal(result.started, 3);
  assert.equal(result.status, 'completed');
});

test('cancellation drains existing work, preserves late observations and starts no next wave', async () => {
  const controller = new AbortController();
  const first = deferred();
  const second = deferred();
  const ready = deferred();
  const started = [];
  let finished = false;
  const pending = runWorkerBatch(['one', 'two', 'three'], 2, async (id, _slot, signal) => {
    started.push(id);
    if (id === 'two') ready.resolve();
    await (id === 'one' ? first : second).promise;
    assert.equal(signal.aborted, true);
    return `${id}-settled`;
  }, controller.signal).then(result => {
    finished = true;
    return result;
  });
  await ready.promise;
  controller.abort();
  first.resolve();
  await Promise.resolve();
  assert.equal(finished, false);
  second.resolve();
  const result = await pending;
  assert.deepEqual(started, ['one', 'two']);
  assert.equal(result.status, 'inconclusive');
  assert.deepEqual(result.outcomes.map(item => item.status), ['settled', 'settled', 'not-started']);
  assert.equal(result.outcomes[1].value, 'two-settled');
});

test('a failed worker cancels its peers and leaves remaining work unstarted', async () => {
  const result = await runWorkerBatch(['one', 'two', 'three'], 2, async (id, _slot, signal) => {
    if (id === 'one') throw new Error('lease unavailable');
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return 'drained';
  });
  assert.equal(result.status, 'inconclusive');
  assert.deepEqual(result.outcomes.map(item => item.status), ['unresolved', 'settled', 'not-started']);
  assert.match(result.outcomes[0].reason, /lease unavailable/);
});

test('serial mode preserves observations and invalid batch inputs are rejected', async () => {
  const ids = ['one', 'two', 'three'];
  const serial = await runWorkerBatch(ids, 1, async id => id);
  const parallel = await runWorkerBatch(ids, 2, async id => id);
  assert.deepEqual(serial.outcomes, parallel.outcomes);
  assert.equal(serial.peakWorkers, 1);
  for (const workers of [0, 3, 1.5, '2']) await assert.rejects(runWorkerBatch(ids, workers, async id => id));
  await assert.rejects(runWorkerBatch(['one', 'one'], 2, async id => id));
  await assert.rejects(runWorkerBatch([], 1, async id => id));
});
