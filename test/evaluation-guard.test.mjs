import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBenchmarkGuard } from '../evaluation/benchmark-guard.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const model = { provider: 'openai-codex', id: 'gpt-6.1-sol', api: 'openai-codex-responses',
  baseUrl: 'https://chatgpt.com/backend-api', maxTokens: 128000, cost: { input: 2, output: 10 } };
const quota = { account_id: 'fixture', rate_limit: { allowed: true, limit_reached: false,
  primary_window: { used_percent: 10 } } };
const lazyStream = (_model, setup) => ({ result: async () => {
  try {
    let result;
    for await (const event of await setup()) result = event.message ?? event.error ?? result;
    return result;
  } catch (error) {
    return { stopReason: 'error', errorMessage: error.message };
  }
} });

async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'policy-guard-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = JSON.stringify({ schemaVersion: 1, totalAuthorizedRequests: 32, admittedRequests: 10,
    reservedRequests: 0, availableUnreserved: 22, nominalCatalogReserveUsd: 4.919209 });
  const path = join(root, 'ledger.json');
  await writeFile(path, ledger);
  const plan = { schemaVersion: 1, ledger: { path, sha256: sha(ledger) },
    billing: 'snapshot-guarded-existing-credits', accountSha256: sha('fixture'),
    selections: { coordinator: { model: 'openai-codex/gpt-6.1-sol', thinking: 'xhigh' },
      'read-review': { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium' } },
    limits: { requests: 22, deadlineMs: 1000, requestBytes: 1048576, responseBytes: 1048576,
      nominalUsd: 25, minRemainingPercent: 20, ...overrides } };
  const calls = [];
  const headers = { Authorization: 'Bearer fixture-secret', 'chatgpt-account-id': 'fixture' };
  const deps = {
    lazyStream,
    readCredential: async () => ({ type: 'oauth', accountId: 'fixture', access: 'fixture-secret', expires: Date.now() + 700000 }),
    fetch: async (url, options) => {
      calls.push({ url, method: options.method, signal: options.signal });
      return new Response(url.endsWith('/usage') ? JSON.stringify(quota) : 'response');
    },
    streamSimple: (_model, context, options) => ({ async *[Symbol.asyncIterator]() {
      assert.equal(options.maxRetries, 0);
      assert.equal(options.transport, 'sse');
      const body = await options.onPayload({ model: _model.id, reasoning: { effort: options.reasoning }, input: context });
      const response = await options.fetch('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST', body: JSON.stringify(body), headers,
      });
      await response.text();
      yield { type: 'done', message: { stopReason: 'stop', content: [], usage: { input: 10, output: 2 } } };
    } }),
  };
  const open = () => createBenchmarkGuard(plan, deps);
  const request = (guard, slot = 'coordinator', selected = model, extra = {}) => guard.streamFor(
    { sessionId: slot, slot }, () => {},
  )(selected, { public: true }, { reasoning: plan.selections[slot].thinking, ...extra }).result();
  return { root, path, ledger, plan, deps, calls, headers, open, request };
}

test('shares a durable serial allowance across coordinator and child, retaining prior consumption', async t => {
  const f = await fixture(t);
  let active = 0;
  let maximum = 0;
  const original = f.deps.fetch;
  f.deps.fetch = async (url, options) => {
    if (options.method === 'POST') {
      active++;
      maximum = Math.max(maximum, active);
      const number = 11 + f.calls.filter(call => call.method === 'POST').length;
      const claim = JSON.parse(await readFile(join(f.path + '.guard', `${number}.claim.json`)));
      assert.ok(claim.reservedNominalUsd > 4.919209);
    }
    const response = await original(url, options);
    if (options.method === 'POST') active--;
    return response;
  };
  const guard = await f.open();
  const results = await Promise.all([f.request(guard), f.request(guard, 'read-review')]);
  assert.deepEqual(results.map(result => result.stopReason), ['stop', 'stop']);
  assert.deepEqual(f.calls.map(call => call.method), ['GET', 'POST', 'GET', 'POST']);
  assert.equal(maximum, 1);
  assert.equal(guard.summary.admittedRequests, 12);
  assert.equal(guard.summary.inferenceRequests, 2);
  assert.equal(await readFile(f.path, 'utf8'), f.ledger);
  await assert.rejects(f.open(), /EEXIST/);
  const receipt = await readFile(join(guard.directory, '11.receipt.json'), 'utf8');
  assert.equal(receipt.includes('fixture-secret'), false);
  assert.equal(JSON.parse(receipt).billedCostUsd, null);
  assert.equal(JSON.parse(await readFile(join(guard.directory, '12.receipt.json'))).inferenceRequests, 1);
  guard.close();
});

test('quota, model, input attestation and nominal-limit failures close admission before inference', async t => {
  for (const failure of ['quota', 'account-header', 'model', 'input', 'nominal']) {
    const f = await fixture(t, failure === 'nominal' ? { nominalUsd: 5 } : {});
    if (failure === 'account-header') f.headers['chatgpt-account-id'] = 'other';
    if (failure === 'quota') f.deps.fetch = async () => new Response(JSON.stringify({ ...quota, account_id: 'other' }));
    const guard = await f.open();
    const stream = failure === 'input'
      ? guard.streamFor({ sessionId: 'coordinator', slot: 'coordinator' }, () => { throw new Error('Unexpected tool'); })
      : guard.streamFor({ sessionId: 'coordinator', slot: 'coordinator' }, () => {});
    const first = await stream(failure === 'model' ? { ...model, id: 'other' } : model, {}, { reasoning: 'xhigh' }).result();
    assert.equal(first.stopReason, 'error', failure);
    assert.equal((await f.request(guard, 'read-review')).stopReason, 'error');
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  }
});

test('HTTP errors, extra transport attempts and oversized output keep partial evidence without retries', async t => {
  for (const failure of ['http', 'retry', 'overflow']) {
    const f = await fixture(t, { responseBytes: 8 });
    const original = f.deps.fetch;
    f.deps.fetch = async (url, options) => {
      if (options.method === 'GET') return original(url, options);
      f.calls.push({ method: 'POST' });
      return new Response(failure === 'overflow' ? '123456789' : 'partial', {
        status: failure === 'http' ? 503 : 200,
      });
    };
    if (failure === 'retry') {
      const originalStream = f.deps.streamSimple;
      f.deps.streamSimple = (...args) => ({ async *[Symbol.asyncIterator]() {
        for await (const event of originalStream(...args)) {
          await args[2].fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', body: '{}' });
          yield event;
        }
      } });
    }
    const guard = await f.open();
    assert.equal((await f.request(guard)).stopReason, 'error', failure);
    assert.equal((await f.request(guard)).stopReason, 'error');
    assert.equal(guard.summary.inferenceRequests, 1);
    const captured = await readFile(join(guard.directory, '11.response.bin'));
    assert.equal(captured.toString(), failure === 'overflow' ? '12345678' : 'partial');
    if (failure === 'http') assert.equal(JSON.parse(await readFile(join(guard.directory, '11.receipt.json'))).usage.output, 2);
  }
});

test('deadline fences late transport completion and a fresh request cannot spend another slot', async t => {
  const f = await fixture(t, { deadlineMs: 30 });
  let finish;
  const original = f.deps.fetch;
  f.deps.fetch = (url, options) => {
    if (options.method === 'GET') return original(url, options);
    f.calls.push({ method: 'POST', signal: options.signal });
    return new Promise(resolve => { finish = resolve; });
  };
  const guard = await f.open();
  const first = await f.request(guard);
  assert.equal(first.stopReason, 'error');
  assert.equal(f.calls.at(-1).signal.aborted, true);
  finish(new Response('late'));
  assert.equal((await f.request(guard)).stopReason, 'error');
  assert.equal(guard.summary.admittedRequests, 11);
  assert.equal(guard.summary.inferenceRequests, 1);
  assert.equal((await readFile(join(guard.directory, '11.response.bin'))).length, 0);
});

test('enforces the selected request ceiling and rejects increases above retained authority', async t => {
  const f = await fixture(t, { requests: 1 });
  const guard = await f.open();
  assert.equal((await f.request(guard)).stopReason, 'stop');
  assert.equal((await f.request(guard, 'read-review')).stopReason, 'error');
  assert.equal(guard.summary.inferenceRequests, 1);
  for (const limits of [{ requests: 23 }, { deadlineMs: 600001 }, { responseBytes: 1048577 }, { minRemainingPercent: 19 }]) {
    const invalid = await fixture(t, limits);
    await assert.rejects(invalid.open(), /limits|allowance/i);
    assert.equal(invalid.calls.length, 0);
  }
});
