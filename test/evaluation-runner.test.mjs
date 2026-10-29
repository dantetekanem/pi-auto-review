import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBenchmark } from '../evaluation/run-benchmark.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const accountId = 'test-account';
const usage = { account_id: accountId, rate_limit: { allowed: true, limit_reached: false,
  primary_window: { used_percent: 7 }, secondary_window: null } };
const model = { id: 'gpt-6.1-sol', provider: 'openai-codex', api: 'openai-codex-responses',
  baseUrl: 'https://chatgpt.com/backend-api', maxTokens: 128000,
  cost: { input: 2, output: 10 }, thinkingLevelMap: { xhigh: 'xhigh' } };
const answer = { findings: [{ title: 'An actual issue', path: 'a.ts', line: 1,
  body: 'Concrete cause and impact.' }], unresolved: [] };

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-run-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function pin(name, content) {
    const path = join(root, name);
    await writeFile(path, content);
    return { path, sha256: sha(content) };
  }
  const plan = { schemaVersion: 1, protocol: 'one-shot-recorded-evidence',
    model: 'openai-codex/gpt-6.1-sol', thinking: 'xhigh',
    billing: 'snapshot-guarded-existing-credits', accountSha256: sha(accountId),
    prompt: await pin('prompt.md', 'Review only supplied data.'),
    cases: [{ id: 'case-a', packet: await pin('packet.json', JSON.stringify({
      case: { id: 'case-a', scope: ['a.ts'] }, diff: 'public source', snapshots: {},
    })), observations: await pin('observations.json', '{"observation":"public runtime evidence"}') }],
    order: [{ caseId: 'case-a', variant: 'source' }, { caseId: 'case-a', variant: 'recorded' }],
    limits: { requests: 2, deadlineMs: 1000, responseBytes: 1048576, requestBytes: 1048576,
      minRemainingPercent: 20, nominalUsd: 25 }, pins: [] };
  const requests = [];
  const contexts = [];
  const dependencies = {
    model,
    normalizeContext: context => ({ messages: [
      { role: 'system', content: context.systemPrompt, timestamp: 0 }, ...context.messages,
    ] }),
    readCredential: async () => ({ type: 'oauth', access: 'never-log-me', accountId, expires: Date.now() + 60000 }),
    fetch: async (url, options) => {
      requests.push({ url, method: options.method });
      return new Response(url.endsWith('/usage') ? JSON.stringify(usage) : 'raw response');
    },
    stream: (_model, context, options) => {
      contexts.push(context);
      return { result: async () => {
        assert.equal(options.reasoningEffort, 'xhigh');
        assert.equal(options.transport, 'sse');
        assert.equal(options.maxRetries, 0);
        const body = { model: 'gpt-6.1-sol', reasoning: { effort: 'xhigh' },
          instructions: context.messages.find(message => message.role === 'system')?.content,
          input: context.messages.filter(message => message.role !== 'system') };
        options.onPayload(body);
        const response = await options.fetch('https://chatgpt.com/backend-api/codex/responses', {
          method: 'POST', body: JSON.stringify(body), signal: options.signal,
        });
        await response.text();
        return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(answer) }],
          usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 } };
      } };
    },
  };
  return { root, plan, dependencies, requests, contexts, output: join(root, 'results') };
}

test('isolates paired inputs, records exact requests and refuses to rerun a claimed output', async t => {
  const f = await fixture(t);
  const result = await runBenchmark(f.output, f.plan, f.dependencies);
  assert.equal(result.inferenceRequests, 2);
  assert.deepEqual(result.runs.map(run => run.status), ['complete', 'complete']);
  assert.deepEqual(f.requests.map(request => request.method), ['GET', 'POST', 'GET', 'POST']);
  assert.equal(f.contexts.length, 2);
  assert.deepEqual(f.contexts[0].messages.map(message => message.role), ['system', 'user']);
  assert.equal(JSON.stringify(f.contexts[0]).includes('runtime evidence'), false);
  assert.equal(JSON.stringify(f.contexts[1]).includes('runtime evidence'), true);
  assert.equal(f.contexts[0].tools, undefined);
  const receipt = await readFile(join(f.output, '1.receipt.json'), 'utf8');
  assert.equal(receipt.includes('never-log-me'), false);
  assert.equal(JSON.parse(receipt).findings[0].id, 'f1');
  await assert.rejects(runBenchmark(f.output, f.plan, f.dependencies), /EEXIST/);
  assert.equal(f.requests.length, 4);
});

test('accepts the approved ten-minute deadline with a sufficiently long-lived credential', async t => {
  const f = await fixture(t);
  f.plan.limits.deadlineMs = 600000;
  f.dependencies.readCredential = async () => ({
    type: 'oauth', access: 'never-log-me', accountId, expires: Date.now() + 700000,
  });

  const result = await runBenchmark(f.output, f.plan, f.dependencies);
  assert.deepEqual(result.runs.map(run => run.status), ['complete', 'complete']);
  assert.equal(result.inferenceRequests, 2);
});

test('installed Codex provider uses the guarded transport without a live request', {
  skip: !process.env.PI_BENCHMARK_AI_ROOT,
}, async t => {
  const f = await fixture(t);
  const root = process.env.PI_BENCHMARK_AI_ROOT;
  const { stream } = await import(pathToFileURL(join(root, 'dist/api/openai-codex-responses.js')).href);
  const catalog = JSON.parse(await readFile(join(root, 'dist/providers/data/openai-codex.json')));
  f.dependencies.model = catalog['openai-codex-responses']['chat:gpt-6.1-sol'];
  f.dependencies.stream = stream;
  f.dependencies.normalizeContext = (await import(pathToFileURL(join(root, 'dist/utils/transcript.js')).href)).normalizeContext;
  const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url');
  f.dependencies.readCredential = async () => ({ type: 'oauth', access: `e30.${claims}.test`, accountId, expires: Date.now() + 60000 });
  const events = [
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg-1', role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify(answer) }] } },
    { type: 'response.completed', response: { id: 'resp-1', status: 'completed',
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } },
  ];
  f.dependencies.fetch = async url => new Response(url.endsWith('/usage')
    ? JSON.stringify(usage) : events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));

  const result = await runBenchmark(f.output, f.plan, f.dependencies);
  assert.deepEqual(result.runs.map(run => run.status), ['complete', 'complete']);
  const request = JSON.parse(await readFile(join(f.output, '1.request.json')));
  assert.equal(request.model, 'gpt-6.1-sol');
  assert.equal(request.instructions, 'Review only supplied data.');
  assert.equal(request.reasoning.effort, 'xhigh');
  assert.equal(request.tools?.length ?? 0, 0);
  assert.equal(result.inferenceRequests, 2);
});

test('blocks drift, duplicate cells and unauthorized model or limit changes before network', async t => {
  for (const change of [
    f => { f.plan.model = 'other/model'; },
    f => { f.plan.order[1] = f.plan.order[0]; },
    f => { f.plan.limits.requests = 33; },
    f => { f.plan.limits.deadlineMs = 600001; },
    f => { f.plan.limits.minRemainingPercent = 0; },
    f => { f.plan.prompt.sha256 = '0'.repeat(64); },
  ]) {
    const f = await fixture(t); change(f);
    await assert.rejects(runBenchmark(f.output, f.plan, f.dependencies));
    assert.equal(f.requests.length, 0);
  }
});

test('quota denial or account mismatch stops without inference and retains unknown cells', async t => {
  for (const response of [
    { ...usage, account_id: 'another-account' },
    { ...usage, rate_limit: { ...usage.rate_limit, primary_window: { used_percent: 81 } } },
    { ...usage, rate_limit: { allowed: true, limit_reached: false } },
  ]) {
    const f = await fixture(t);
    f.dependencies.fetch = async () => new Response(JSON.stringify(response));
    const result = await runBenchmark(f.output, f.plan, f.dependencies);
    assert.equal(result.inferenceRequests, 0);
    assert.deepEqual(result.runs.map(run => run.status), ['infrastructure-error', 'unknown']);
  }
});

test('rejects lost instructions, retries, oversized output and late replies without replacing the failed cell', async t => {
  for (const failure of ['lost-instructions', 'retry', 'overflow', 'deadline', 'malformed']) {
    const f = await fixture(t);
    f.plan.limits.responseBytes = 64;
    f.plan.limits.deadlineMs = 30;
    const original = f.dependencies.stream;
    f.dependencies.stream = (selected, context, options) => ({ result: async () => {
      const message = await original(selected, context, options).result();
      if (failure === 'retry') await options.fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', body: '{}' });
      if (failure === 'deadline') await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      if (failure === 'malformed') message.content[0].text = 'not JSON';
      return message;
    } });
    if (failure === 'lost-instructions') f.dependencies.normalizeContext = () => ({ messages: [] });
    if (failure === 'overflow') f.dependencies.fetch = async url => new Response(url.endsWith('/usage') ? JSON.stringify(usage) : 'x'.repeat(65));
    const result = await runBenchmark(f.output, f.plan, f.dependencies);
    assert.equal(result.inferenceRequests, failure === 'lost-instructions' ? 0 : 1);
    assert.notEqual(result.runs[0].status, 'complete');
    assert.equal(result.runs[1].status, 'unknown');
  }
});
