import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { readPinnedFile } from '../src/experiments-materialize.ts';

const endpoint = 'https://chatgpt.com/backend-api/codex/responses';
const usageEndpoint = 'https://chatgpt.com/backend-api/wham/usage';
const sha = value => createHash('sha256').update(value).digest('hex');
const size = value => Buffer.byteLength(value);
const save = (root, name, value) => writeFile(join(root, name), JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
const bounded = (value, maximum) => Number.isSafeInteger(value) && value > 0 && value <= maximum;

async function quotaSnapshot(response, credential, minimum) {
  if (!response.ok || !response.body) throw new Error('Usage preflight failed.');
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > 1048576) throw new Error('Usage preflight exceeds byte limit.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  const usage = JSON.parse(raw);
  const windows = [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window].filter(Boolean);
  if (usage.account_id !== credential.accountId || usage.rate_limit?.allowed !== true
    || usage.rate_limit.limit_reached !== false || !windows.length || windows.some(window =>
      !Number.isFinite(window.used_percent) || window.used_percent < 0 || window.used_percent > 100 - minimum)) {
    throw new Error('Account identity or included-quota headroom check failed.');
  }
  return { sha256: sha(raw), observedAt: new Date().toISOString(), usedPercent: windows.map(window => window.used_percent) };
}

/** One retained grant, shared by all enrolled native sessions. This does not launch a benchmark. */
export async function createBenchmarkGuard(input, { streamSimple, lazyStream, readCredential, fetch: request }) {
  const plan = structuredClone(input);
  const ledger = JSON.parse(await readPinnedFile(plan.ledger, 1048576));
  const limits = plan.limits;
  const prior = ledger.admittedRequests;
  if (plan.schemaVersion !== 1 || plan.billing !== 'snapshot-guarded-existing-credits'
    || !/^[a-f0-9]{64}$/.test(plan.accountSha256) || ledger.schemaVersion !== 1
    || !bounded(ledger.totalAuthorizedRequests, 32) || !Number.isSafeInteger(prior) || prior < 0
    || ledger.reservedRequests !== 0 || ledger.availableUnreserved !== ledger.totalAuthorizedRequests - prior
    || !bounded(limits?.requests, ledger.availableUnreserved) || !bounded(limits.deadlineMs, 600000)
    || !bounded(limits.requestBytes, 1048576) || !bounded(limits.responseBytes, 1048576)
    || !bounded(limits.minRemainingPercent, 100) || limits.minRemainingPercent < 20
    || !Number.isFinite(limits.nominalUsd) || limits.nominalUsd <= 0 || limits.nominalUsd > 25
    || !Number.isFinite(ledger.nominalCatalogReserveUsd) || ledger.nominalCatalogReserveUsd < 0
    || ledger.nominalCatalogReserveUsd >= limits.nominalUsd) {
    throw new Error('Invalid retained allowance or limits.');
  }
  if (plan.selections?.coordinator?.model !== 'openai-codex/gpt-6.1-sol'
    || plan.selections.coordinator.thinking !== 'xhigh'
    || Object.entries(plan.selections).some(([slot, selection]) => !/^(coordinator|read-(collect|review|analyze|critical))$/.test(slot)
      || !/^openai-codex\/[^/\s]+$/.test(selection.model) || !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(selection.thinking))) {
    throw new Error('Invalid frozen model selections.');
  }
  // The lease belongs to the retained ledger, not a fresh output directory. Never clear it to retry.
  const directory = plan.ledger.path + '.guard';
  await mkdir(directory, { mode: 0o700 });
  await save(directory, 'plan.json', plan);
  let consumed = 0;
  let posted = 0;
  let reserved = ledger.nominalCatalogReserveUsd;
  let stopped;
  let activeController;
  let tail = Promise.resolve();
  const enrolled = new Map();
  const runtimes = new WeakSet();
  const summary = () => ({
    admittedRequests: prior + consumed,
    inferenceRequests: posted,
    reservedNominalUsd: reserved,
    billedCostUsd: null,
    serverOutputTokenCap: null,
  });

  async function* run(identity, attest, model, context, options) {
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    if (stopped) {
      release();
      throw stopped;
    }
    const controller = new AbortController();
    activeController = controller;
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    const timer = setTimeout(() => controller.abort(new Error('Client deadline exceeded.')), limits.deadlineMs);
    const deadline = new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    void deadline.catch(() => {}); // Validation can fail before the first awaited operation.
    const wait = promise => Promise.race([promise, deadline]);
    const number = prior + consumed + 1;
    const receipt = {
      ...identity, number, startedAt: new Date().toISOString(),
      inferenceRequests: 0, usage: null, billedCostUsd: null,
      serverOutputTokenCap: null, status: 'incomplete',
    };
    const chunks = [];
    let credential;
    let payload;
    let captured = 0;
    let active = true;
    let terminal;
    try {
      signal.throwIfAborted();
      const selection = plan.selections[identity.slot];
      if (!selection || selection.model !== `${model.provider}/${model.id}` || options.reasoning !== selection.thinking
        || model.api !== 'openai-codex-responses' || model.baseUrl !== 'https://chatgpt.com/backend-api'
        || !bounded(model.maxTokens, 128000) || consumed >= limits.requests) {
        throw new Error('Model, effort or request allowance mismatch.');
      }
      await wait(Promise.resolve().then(() => attest(context)));
      credential = await wait(readCredential());
      if (credential?.type !== 'oauth' || typeof credential.access !== 'string' || !credential.access
        || typeof credential.accountId !== 'string' || sha(credential.accountId) !== plan.accountSha256
        || !(credential.expires > Date.now() + limits.deadlineMs)) {
        throw new Error('Matching unexpired stored OAuth credential required.');
      }
      receipt.quota = await wait(quotaSnapshot(await wait(request(usageEndpoint, {
        method: 'GET', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${credential.access}`, 'chatgpt-account-id': credential.accountId, 'User-Agent': 'codex-cli' },
      })), credential, limits.minRemainingPercent));
      signal.throwIfAborted();
      const stream = streamSimple(model, context, {
        ...options, apiKey: credential.access, signal, transport: 'sse', maxRetries: 0, cacheRetention: 'none',
        async onPayload(body) {
          const replacement = await options.onPayload?.(body, model);
          const final = replacement === undefined ? body : replacement;
          const encoded = JSON.stringify(final);
          if (final.model !== model.id || final.reasoning?.effort !== (model.thinkingLevelMap?.[selection.thinking] ?? selection.thinking)
            || size(encoded) > limits.requestBytes) throw new Error('Unexpected provider payload.');
          await attest(context, final);
          signal.throwIfAborted();
          payload = encoded;
          return final;
        },
        async fetch(url, transport) {
          signal.throwIfAborted();
          if (!active || url !== endpoint || transport?.method !== 'POST' || !payload || receipt.inferenceRequests) {
            throw new Error('Inference request denied.');
          }
          const headers = new Headers(transport.headers);
          if (headers.get('authorization') !== `Bearer ${credential.access}` || headers.get('chatgpt-account-id') !== credential.accountId) {
            throw new Error('Transport credential or account differs from quota preflight.');
          }
          let body = transport.body;
          if (headers.get('content-encoding') === 'zstd') body = zlib.zstdDecompressSync(body, { maxOutputLength: limits.requestBytes });
          if ((typeof body !== 'string' && !(body instanceof Uint8Array)) || Buffer.from(body).toString() !== payload) {
            throw new Error('Transport payload differs from attested request.');
          }
          const rates = [model.cost, ...(model.cost?.tiers ?? [])];
          const inputRate = Math.max(...rates.map(rate => rate?.input));
          const outputRate = Math.max(...rates.map(rate => rate?.output));
          const reservation = (size(payload) * inputRate + model.maxTokens * outputRate) / 1000000;
          if (![inputRate, outputRate, reservation].every(value => Number.isFinite(value) && value >= 0)
            || reserved + reservation > limits.nominalUsd) {
            throw new Error('Nominal catalog allowance exceeded.');
          }
          consumed++;
          reserved += reservation;
          await save(directory, `${number}.claim.json`, { ...identity, number, reservedNominalUsd: reserved, requestSha256: sha(payload) });
          await writeFile(join(directory, `${number}.request.json`), payload, { flag: 'wx', mode: 0o600 });
          signal.throwIfAborted();
          receipt.inferenceRequests++;
          posted++;
          const response = await request(url, { ...transport, signal, redirect: 'error' });
          signal.throwIfAborted();
          receipt.httpStatus = response.status;
          if (!response.body) throw new Error('Missing inference response body.');
          const capture = new TransformStream({ transform(chunk, destination) {
            signal.throwIfAborted();
            const remaining = limits.responseBytes - captured;
            const kept = Buffer.from(chunk).subarray(0, remaining);
            chunks.push(kept);
            captured += kept.length;
            if (chunk.byteLength > remaining) {
              controller.abort(new Error('Inference response exceeds byte limit.'));
              throw signal.reason;
            }
            destination.enqueue(chunk);
          } });
          return new Response(response.body.pipeThrough(capture), { status: response.status, headers: response.headers });
        },
      });
      const iterator = stream[Symbol.asyncIterator]();
      for (;;) {
        const next = await wait(iterator.next());
        if (next.done) break;
        if (next.value.type === 'done' || next.value.type === 'error') terminal = next.value;
        else yield next.value;
      }
      const message = terminal?.message ?? terminal?.error;
      receipt.usage = message?.usage ?? null;
      if (!receipt.inferenceRequests || receipt.httpStatus >= 400 || !['stop', 'toolUse'].includes(message?.stopReason)) {
        throw new Error(message?.errorMessage || 'Inference did not complete normally.');
      }
      receipt.status = 'complete';
    } catch (error) {
      stopped = new Error(String(error?.message ?? error).replaceAll(credential?.access || '\0', '[redacted]'));
      receipt.error = stopped.message;
    } finally {
      active = false;
      clearTimeout(timer);
      controller.abort(new Error('Request ended.'));
      activeController = undefined;
      const raw = Buffer.concat(chunks);
      try {
        await writeFile(join(directory, `${number}.response.bin`), raw, { flag: 'wx', mode: 0o600 });
        await save(directory, `${number}.receipt.json`, { ...receipt, totals: summary(), responseBytes: raw.length, responseSha256: sha(raw) });
      } catch (error) {
        stopped = new Error(`Could not persist request evidence: ${error.message}`);
      }
      release();
    }
    if (stopped) throw stopped;
    yield terminal;
  }
  return {
    directory,
    get summary() { return summary(); },
    streamFor(identity, attest) {
      if (!identity || typeof identity.sessionId !== 'string' || !plan.selections[identity.slot] || typeof attest !== 'function') {
        throw new Error('An enrolled session, frozen selection and input attestation are required.');
      }
      const fixed = structuredClone(identity);
      return (model, context, options = {}) => lazyStream(model, async () => run(fixed, attest, model, context, options));
    },
    enroll(session, slot, attest) {
      const sessionId = session.sessionManager.getSessionId();
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || enrolled.has(sessionId)) throw new Error('Invalid or duplicate session enrollment.');
      const entry = { session, slot, attest, ready: false };
      const guarded = this.streamFor({ sessionId, slot }, (...args) => {
        if (!entry.ready) throw new Error('Benchmark session has not passed startup attestation.');
        return attest(...args);
      });
      enrolled.set(sessionId, entry);
      session.agent.streamFunction = guarded;
      const runtime = session.modelRuntime;
      if (!runtimes.has(runtime)) {
        // Only the enrolled agent stream may infer. Nested/direct calls have no attested turn owner.
        runtime.registerProvider('openai-codex', { api: 'openai-codex-responses',
          streamSimple: model => lazyStream(model, async () => { throw new Error('Unowned benchmark inference denied.'); }),
        });
        runtimes.add(runtime);
      }
    },
    async ready(session) {
      const sessionId = session.sessionManager.getSessionId();
      const entry = enrolled.get(sessionId);
      if (!entry || entry.session !== session || entry.ready || stopped) throw new Error('Session is not awaiting attestation.');
      const inputs = await entry.attest();
      await save(directory, `${sessionId}.inputs.json`, { sessionId, slot: entry.slot, inputs });
      entry.ready = true;
    },
    close() {
      stopped = new Error('Benchmark grant closed.');
      activeController?.abort(stopped);
    },
  };
}
