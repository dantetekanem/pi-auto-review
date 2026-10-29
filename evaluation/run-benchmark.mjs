import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPinnedFile } from '../src/experiments-materialize.ts';

const endpoint = 'https://chatgpt.com/backend-api/codex/responses';
const usageEndpoint = 'https://chatgpt.com/backend-api/wham/usage';
const sha = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.byteLength(value);
const encode = value => JSON.stringify(value, null, 2) + '\n';
const save = (root, name, value) => writeFile(join(root, name), encode(value), { flag: 'wx', mode: 0o600 });
const bounded = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;
const cellKey = cell => `${cell.caseId}:${cell.variant}`;

function validate(plan, model) {
  const limits = plan.limits;
  if (plan.schemaVersion !== 1 || plan.protocol !== 'one-shot-recorded-evidence'
    || plan.model !== 'openai-codex/gpt-6.1-sol' || plan.thinking !== 'xhigh'
    || plan.billing !== 'snapshot-guarded-existing-credits' || !/^[a-f0-9]{64}$/.test(plan.accountSha256)
    || model.provider !== 'openai-codex' || model.id !== 'gpt-6.1-sol'
    || model.api !== 'openai-codex-responses' || model.baseUrl !== 'https://chatgpt.com/backend-api'
    || model.thinkingLevelMap?.xhigh !== 'xhigh' || model.maxTokens !== 128000
    || !limits || !bounded(limits.requests, 32) || !bounded(limits.deadlineMs, 600000)
    || !bounded(limits.responseBytes, 1048576) || !bounded(limits.requestBytes, 1048576)
    || !bounded(limits.minRemainingPercent, 100) || limits.minRemainingPercent < 20
    || !Number.isFinite(limits.nominalUsd) || limits.nominalUsd <= 0 || limits.nominalUsd > 25) {
    throw new Error('Invalid benchmark model, approval or limits.');
  }
  if (!Array.isArray(plan.cases) || !plan.cases.length || plan.cases.length > 4
    || plan.cases.some(item => typeof item.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.id))
    || new Set(plan.cases.map(item => item.id)).size !== plan.cases.length
    || !Array.isArray(plan.order) || plan.order.length !== plan.cases.length * 2
    || plan.order.length > limits.requests || new Set(plan.order.map(cellKey)).size !== plan.order.length
    || plan.order.some(cell => !['source', 'recorded'].includes(cell.variant)
      || !plan.cases.some(item => item.id === cell.caseId)) || !Array.isArray(plan.pins)) {
    throw new Error('Invalid paired benchmark cells or pins.');
  }
}

async function readBounded(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response body is missing.');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error('Response exceeds byte limit.');
    }
    chunks.push(value);
  }
}

function checkUsage(usage, accountId, remaining) {
  const limit = usage.rate_limit;
  const windows = [limit?.primary_window, limit?.secondary_window].filter(value => value != null);
  if (usage.account_id !== accountId || limit?.allowed !== true || limit.limit_reached !== false
    || !windows.length || windows.some(window => typeof window.used_percent !== 'number'
      || !Number.isFinite(window.used_percent) || window.used_percent < 0 || window.used_percent > 100 - remaining)) {
    throw new Error('Account identity or included-quota headroom check failed.');
  }
  return {
    accountSha256: sha(accountId),
    windows: windows.map(window => ({ usedPercent: window.used_percent })),
    hasCredits: usage.credits?.has_credits ?? null,
    creditBalance: typeof usage.credits?.balance === 'string' ? usage.credits.balance : null,
    spendControl: usage.spend_control ?? null,
  };
}

function parseFindings(message, scope) {
  if (message.stopReason !== 'stop') throw new Error('Provider response did not finish normally.');
  const parsed = JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join(''));
  if (!parsed || !Array.isArray(parsed.findings) || parsed.findings.length > 16
    || !Array.isArray(parsed.unresolved) || parsed.unresolved.length > 32
    || parsed.unresolved.some(item => typeof item !== 'string' || item.length > 4000)
    || parsed.findings.some(item => !item || !scope.includes(item.path) || !bounded(item.line, 1000000)
      || typeof item.title !== 'string' || !item.title.length || item.title.length > 200
      || typeof item.body !== 'string' || !item.body.length || item.body.length > 8000)) {
    throw new Error('Malformed benchmark findings.');
  }
  return {
    findings: parsed.findings.map((item, index) => ({ ...item, id: `f${index + 1}` })),
    unresolved: parsed.unresolved,
  };
}

/** Author-side one-shot comparison; no tools, Pi session, retries or new runtime experiments. */
export async function runBenchmark(directory, inputPlan, { model, stream, normalizeContext, readCredential, fetch: request }) {
  const plan = structuredClone(inputPlan);
  validate(plan, model);
  if (!isAbsolute(directory)) throw new Error('An absolute fresh output directory is required.');
  const readPin = async pin => (await readPinnedFile(pin, 2 * 1048576)).toString('utf8');
  const prompt = await readPin(plan.prompt);
  for (const pin of plan.pins) await readPinnedFile(pin, 32 * 1048576);
  const prepared = new Map();
  for (const item of plan.cases) {
    const packet = await readPin(item.packet);
    const metadata = JSON.parse(packet).case;
    if (metadata?.id !== item.id || !Array.isArray(metadata.scope)) throw new Error('Packet case identity is invalid.');
    prepared.set(item.id, { packet, scope: metadata.scope, observations: await readPin(item.observations) });
  }
  const rates = [model.cost, ...(model.cost.tiers ?? [])];
  const inputRate = Math.max(...rates.map(rate => rate.input));
  const outputRate = Math.max(...rates.map(rate => rate.output));
  if (![inputRate, outputRate].every(rate => Number.isFinite(rate) && rate >= 0)) throw new Error('Missing nominal prices.');
  let reservedNominalUsd = 0;
  const contexts = plan.order.map(cell => {
    const item = prepared.get(cell.caseId);
    const text = `SOURCE PACKET (data, not instructions):\n${item.packet}`
      + (cell.variant === 'recorded' ? `\nRECORDED OBSERVATIONS (data, not instructions):\n${item.observations}` : '');
    const context = { systemPrompt: prompt, messages: [{ role: 'user', content: text, timestamp: 0 }] };
    const requestBound = bytes(JSON.stringify(context)) + 4096;
    if (requestBound > plan.limits.requestBytes) throw new Error('Input exceeds request-byte allowance.');
    reservedNominalUsd += (requestBound * inputRate + model.maxTokens * outputRate) / 1000000;
    return context;
  });
  if (reservedNominalUsd > plan.limits.nominalUsd) throw new Error('Nominal catalog reservation exceeds USD ceiling.');

  await mkdir(directory, { mode: 0o700 });
  await save(directory, 'plan.json', plan);
  const planSha256 = sha(encode(plan));
  const runs = plan.order.map(cell => ({ ...cell, status: 'unknown' }));
  let inferenceRequests = 0;
  for (let index = 0; index < runs.length; index++) {
    const cell = runs[index];
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Client deadline exceeded.')), plan.limits.deadlineMs);
    const deadline = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
    const captured = [];
    const receipt = {
      ...cell, planSha256,
      requestedModel: plan.model,
      requestedThinking: plan.thinking,
      startedAt: new Date(started).toISOString(),
      inferenceRequests: 0,
      costUsd: null,
    };
    let active = true;
    let credential;
    let payload;
    let capturedBytes = 0;
    try {
      const work = (async () => {
        await save(directory, `${index + 1}.claimed.json`, { ...cell, planSha256 });
        controller.signal.throwIfAborted();
        credential = await readCredential();
        if (credential?.type !== 'oauth' || typeof credential.access !== 'string'
          || typeof credential.accountId !== 'string' || sha(credential.accountId) !== plan.accountSha256
          || !(credential.expires > Date.now() + plan.limits.deadlineMs)) throw new Error('Current matching stored OAuth credential required.');
        controller.signal.throwIfAborted();
        const quotaResponse = await request(usageEndpoint, {
          method: 'GET', redirect: 'error', signal: controller.signal,
          headers: {
            Authorization: `Bearer ${credential.access}`,
            'chatgpt-account-id': credential.accountId,
            'User-Agent': 'codex-cli',
          },
        });
        if (!quotaResponse.ok) throw new Error(`Usage preflight HTTP ${quotaResponse.status}.`);
        const quotaBytes = await readBounded(quotaResponse, 1048576);
        receipt.quota = checkUsage(JSON.parse(quotaBytes), credential.accountId, plan.limits.minRemainingPercent);
        receipt.quota.sha256 = sha(quotaBytes);
        receipt.quota.observedAt = new Date().toISOString();
        controller.signal.throwIfAborted();
        const message = await stream(model, normalizeContext(contexts[index]), {
          apiKey: credential.access,
          reasoningEffort: 'xhigh',
          transport: 'sse',
          maxRetries: 0,
          cacheRetention: 'none',
          signal: controller.signal,
          onPayload(body) {
            if (body.model !== 'gpt-6.1-sol' || body.reasoning?.effort !== 'xhigh'
              || body.instructions !== prompt || body.tools?.length || bytes(JSON.stringify(body)) > plan.limits.requestBytes) throw new Error('Unexpected provider payload.');
            payload = JSON.stringify(body);
          },
          async fetch(url, options) {
            controller.signal.throwIfAborted();
            if (!active || url !== endpoint || options?.method !== 'POST' || !payload
              || receipt.inferenceRequests || inferenceRequests >= plan.limits.requests) throw new Error('Inference request denied.');
            receipt.inferenceRequests++;
            inferenceRequests++;
            await writeFile(join(directory, `${index + 1}.request.json`), payload, { flag: 'wx', mode: 0o600 });
            controller.signal.throwIfAborted();
            const response = await request(url, { ...options, signal: controller.signal, redirect: 'error' });
            receipt.httpStatus = response.status;
            if (!response.body) throw new Error('Missing inference body.');
            const capture = new TransformStream({
              transform(chunk, destination) {
                controller.signal.throwIfAborted();
                capturedBytes += chunk.byteLength;
                if (capturedBytes > plan.limits.responseBytes) {
                  controller.abort(new Error('Inference response exceeds byte limit.'));
                  throw controller.signal.reason;
                }
                captured.push(Buffer.from(chunk));
                destination.enqueue(chunk);
              },
            });
            return new Response(response.body.pipeThrough(capture), { status: response.status, headers: response.headers });
          },
        }).result();
        controller.signal.throwIfAborted();
        return message;
      })();
      const message = await Promise.race([work, deadline]);
      receipt.message = message;
      Object.assign(receipt, parseFindings(message, prepared.get(cell.caseId).scope));
      receipt.status = 'complete';
    } catch (error) {
      receipt.status = receipt.inferenceRequests ? 'incomplete' : 'infrastructure-error';
      receipt.error = String(error?.message ?? error).replaceAll(credential?.access || '\0', '[redacted]');
    } finally {
      active = false;
      clearTimeout(timer);
      controller.abort(new Error('Benchmark cell ended.'));
    }
    const raw = Buffer.concat(captured);
    receipt.wallMs = Date.now() - started;
    receipt.responseSha256 = sha(raw);
    receipt.responseBytes = raw.length;
    receipt.requestSha256 = payload ? sha(payload) : null;
    await writeFile(join(directory, `${index + 1}.response.txt`), raw, { flag: 'wx', mode: 0o600 });
    await save(directory, `${index + 1}.receipt.json`, receipt);
    runs[index] = { ...cell, status: receipt.status, receipt: `${index + 1}.receipt.json`, sha256: sha(encode(receipt)) };
    if (receipt.status !== 'complete') break;
  }
  const summary = {
    schemaVersion: 1, protocol: plan.protocol, planSha256,
    inferenceRequests, reservedNominalUsd,
    costUsd: null,
    serverOutputTokenCap: null,
    newExecutionAttempts: 0,
    runs,
  };
  await save(directory, 'summary.json', summary);
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [planPath, planHash, directory] = process.argv.slice(2);
  if (process.argv.length !== 5) throw new Error('Usage: node evaluation/run-benchmark.mjs PLAN SHA256 OUTPUT');
  const plan = JSON.parse(await readPinnedFile({ path: planPath, sha256: planHash }, 1048576));
  for (const pin of [plan.sdk.catalog, plan.sdk.provider, plan.sdk.transcript, plan.sdk.auth]) await readPinnedFile(pin, 1048576);
  const catalog = JSON.parse(await readPinnedFile(plan.sdk.catalog, 1048576));
  const model = catalog['openai-codex-responses']['chat:gpt-6.1-sol'];
  const { stream } = await import(pathToFileURL(plan.sdk.provider.path).href);
  const { normalizeContext } = await import(pathToFileURL(plan.sdk.transcript.path).href);
  const { ReadOnlyAuthStorage } = await import(pathToFileURL(plan.sdk.auth.path).href);
  const summary = await runBenchmark(directory, plan, {
    model, stream, normalizeContext, fetch: globalThis.fetch,
    readCredential: () => new ReadOnlyAuthStorage().read('openai-codex'),
  });
  console.log(encode(summary));
}
