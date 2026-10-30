import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { createBenchmarkInputs } from '../evaluation/benchmark-inputs.mjs';
import { createBenchmarkGuard } from '../evaluation/benchmark-guard.mjs';
import { createRequire } from 'node:module';

const sha = value => createHash('sha256').update(value).digest('hex');
const sdkRoot = process.env.PI_BENCHMARK_SDK_ROOT;
const nativeTest = { skip: !sdkRoot };

async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'policy-native-')));
  let session;
  t.after(async () => {
    await session?.abort();
    await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
    session?.dispose();
    await rm(root, { recursive: true, force: true });
    await overrides.cleanup?.();
  });
  await overrides.setup?.(root);
  const sdk = await import(pathToFileURL(join(sdkRoot, 'dist/index.js')).href);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected live network request.'); });
  const source = join(root, 'source.ts');
  await writeFile(source, 'export const publicValue = 1;');
  await writeFile(join(root, 'AGENTS.md'), 'PRIVATE_CONTEXT_CANARY');
  await mkdir(join(root, '.pi'), { recursive: true });
  await writeFile(join(root, '.pi/SYSTEM.md'), 'PRIVATE_SYSTEM_CANARY');
  await writeFile(join(root, 'private.txt'), 'PRIVATE_LABEL_CANARY');
  await symlink(join(root, 'private.txt'), join(root, 'linked.ts'));
  const pins = [{ path: source, sha256: sha('export const publicValue = 1;') }];
  const inputs = await createBenchmarkInputs(sdk, { cwd: root, loaderDirectory: join(root, 'clean-loader'), files: pins, tools: ['read'], ...overrides });
  await inputs.options.resourceLoader.reload();
  const runtime = await sdk.ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const model = runtime.getModel('openai-codex', 'gpt-6.1-sol');
  ({ session } = await sdk.createAgentSession({ cwd: root, agentDir: join(root, 'clean-loader'), modelRuntime: runtime,
    model, thinkingLevel: 'xhigh', sessionManager: sdk.SessionManager.inMemory(root), ...inputs.options }));
  await session.bindExtensions({ mode: 'print' });
  return { root, sdk, source, inputs, session, model, runtime };
}

test('real SDK startup exposes only the pinned read operation and excludes ambient input', nativeTest, async t => {
  const f = await fixture(t);
  const receipt = f.inputs.attest(f.session);
  assert.deepEqual(receipt.registeredTools, ['read']);
  assert.equal(f.session.systemPrompt.includes('PRIVATE_'), false);
  assert.equal(f.session.autoRetryEnabled, false);
  assert.equal(f.session.autoCompactionEnabled, false);
  const read = f.inputs.options.customTools[0];
  const result = await read.execute('read', { path: f.source }, undefined, undefined, {});
  assert.match(result.content[0].text, /publicValue/);
  for (const path of ['private.txt', '../private.txt', join(f.root, 'private.txt'), 'linked.ts']) {
    await assert.rejects(read.execute('read', { path }, undefined, undefined, {}), /not admitted|symlink/);
  }
  await writeFile(f.source, 'changed after sealing');
  await assert.rejects(read.execute('read', { path: f.source }, undefined, undefined, {}), /digest drift/);
});

async function guardedRuntime(f, reply) {
  const { lazyStream } = await import(pathToFileURL(join(sdkRoot, '../pi-ai/dist/api/lazy.js')).href);
  const { streamSimple } = await import(pathToFileURL(join(sdkRoot, '../pi-ai/dist/api/openai-codex-responses.js')).href);
  const ledgerPath = join(f.root, 'ledger.json');
  const ledger = JSON.stringify({ schemaVersion: 1, totalAuthorizedRequests: 32, admittedRequests: 10,
    reservedRequests: 0, availableUnreserved: 22, nominalCatalogReserveUsd: 4.919209 });
  await writeFile(ledgerPath, ledger);
  const accountId = 'native-fixture';
  const token = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url')}.test`;
  f.runtime.registerProvider('openai-codex', { apiKey: token });
  const requests = [];
  const guard = await createBenchmarkGuard({ schemaVersion: 1, ledger: { path: ledgerPath, sha256: sha(ledger) },
    billing: 'snapshot-guarded-existing-credits', accountSha256: sha(accountId),
    selections: { coordinator: { model: 'openai-codex/gpt-6.1-sol', thinking: 'xhigh' },
      'read-review': { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium' } },
    limits: { requests: 4, deadlineMs: 1000, requestBytes: 1048576, responseBytes: 1048576, nominalUsd: 25, minRemainingPercent: 20 },
  }, { streamSimple, lazyStream,
    readCredential: async () => ({ type: 'oauth', access: token, accountId, expires: Date.now() + 700000 }),
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (options.method === 'GET') return new Response(JSON.stringify({ account_id: accountId,
        rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 10 } } }));
      const body = JSON.parse(typeof options.body === 'string' ? options.body : zstdDecompressSync(options.body).toString());
      const items = reply?.(body) ?? [{ type: 'message', id: 'msg-1', role: 'assistant', content: [{ type: 'output_text', text: 'Observed approved input.' }] }];
      return new Response([
        ...items.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })),
        { type: 'response.completed', response: { id: 'resp-1', status: 'completed', usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    },
  });
  return { guard, requests };
}

test('real Pi coordinator uses the guarded installed Codex transport and denies unowned auxiliary calls', nativeTest, async t => {
  const f = await fixture(t);
  const { guard, requests } = await guardedRuntime(f);
  t.after(() => guard.close());
  guard.enroll(f.session, 'coordinator', () => f.inputs.attest(f.session));
  await guard.ready(f.session);
  await f.session.prompt('Review the supplied public source.');
  assert.equal(f.session.getLastAssistantText(), 'Observed approved input.');
  assert.deepEqual(requests.map(request => request.options.method), ['GET', 'POST']);
  const payload = await readFile(join(guard.directory, '11.request.json'), 'utf8');
  assert.equal(payload.includes('PRIVATE_'), false);
  assert.equal(JSON.parse(payload).reasoning.effort, 'xhigh');
  const auxiliary = await f.runtime.streamSimple(f.model, { messages: [] }, { reasoning: 'xhigh' }).result();
  assert.equal(auxiliary.stopReason, 'error');
  assert.equal(requests.length, 2);
});

test('public teams launch enrolls the actual child before its read/report turns and retains configured thinking', {
  skip: !sdkRoot || !process.env.PI_BENCHMARK_TEAMS_ROOT, timeout: 15000,
}, async t => {
  const teamsRoot = process.env.PI_BENCHMARK_TEAMS_ROOT;
  const { registerNativeChildPolicy } = await import(pathToFileURL(join(teamsRoot, 'src/native-child-policy.ts')).href);
  const extensionPath = join(teamsRoot, 'extensions/index.ts');
  const savedEnv = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, HERDR_ENV: process.env.HERDR_ENV };
  const entrypoint = process.argv[1];
  let f, host, guard, childInputs, retire, child, requests, childTurns = 0;
  const captures = [];
  f = await fixture(t, {
    tools: ['read', 'spawn_agent'], extensions: [{ path: extensionPath, sha256: sha(await readFile(extensionPath)) }],
    async setup(root) {
      // The native resolver locates its host SDK from the executable entrypoint, not this test's older peer.
      process.argv[1] = join(sdkRoot, 'dist/cli.js');
      process.env.HOME = root;
      process.env.PI_CODING_AGENT_DIR = join(root, '.pi/agent');
      delete process.env.HERDR_ENV;
      await mkdir(join(root, '.pi/agent/pi-extended-teams'), { recursive: true });
      await writeFile(join(root, '.pi/agent/pi-extended-teams/settings.json'), JSON.stringify({
        favoriteModels: { 'read-review': { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium' } },
      }));
    },
    cleanup() {
      process.argv[1] = entrypoint;
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
    extensionFactories: [pi => {
      pi.on('session_start', (_event, ctx) => {
        host = { pi, ctx };
        retire = registerNativeChildPolicy(ctx.sessionManager, {
          async prepare(input) {
            assert.equal(input.cwd, f.root);
            assert.equal(input.role, 'read');
            childInputs = await createBenchmarkInputs(f.sdk, { cwd: input.cwd, loaderDirectory: join(f.root, 'child-loader'),
              files: [{ path: f.source, sha256: sha(await readFile(f.source)) }],
              tools: ['read', 'send_message', 'read_inbox', 'report_progress', 'report_and_exit'],
              extensionFactories: input.mandatoryFactories, appendSystemPrompt: input.rolePrompt });
            await childInputs.options.resourceLoader.reload();
            return childInputs.options;
          },
          enroll(session) {
            child = session;
            guard.enroll(session, 'read-review', () => childInputs.attest(session));
          },
          assertReady: session => guard.ready(session),
        });
      });
    }],
  });
  ({ guard, requests } = await guardedRuntime(f, body => {
    captures.push(body);
    if (body.reasoning.effort !== 'medium') return;
    childTurns++;
    const call = (name, args, id) => ({ type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(args) });
    if (childTurns === 1) {
      return [
        call('read', { path: f.source }, 'source'),
        call('read', { path: join(f.root, 'private.txt') }, 'denied'),
        call('bash', { command: 'pwd' }, 'shell'),
      ];
    }
    return [call('report_and_exit', { content: 'Approved source read; outside input denied.', outcome: 'succeeded' }, 'report')];
  }));
  t.after(() => {
    retire?.();
    guard?.close();
  });
  guard.enroll(f.session, 'coordinator', () => f.inputs.attest(f.session));
  await guard.ready(f.session);
  const once = (name, predicate) => new Promise(resolve => {
    const stop = host.pi.events.on(name, event => {
      if (!predicate(event)) return;
      stop();
      resolve(event);
    });
  });
  const childCost = once('pi-extended-teams:cost-changed', () => f.session.sessionManager.getEntries().some(entry =>
    entry.type === 'custom' && entry.customType === 'pi-extended-teams-cost-v1'
    && entry.data?.phase === 'final' && entry.data.telemetry?.agentName === 'isolated-child'));
  const report = once('pi-extended-teams:agent-report', event => event.name === 'isolated-child');
  const response = once('pi-extended-teams:orchestration-response', event => event.requestId === 'fixture-launch');
  const settled = new Promise(resolve => {
    const stop = f.session.subscribe(event => {
      if (event.type !== 'agent_settled') return;
      stop();
      resolve();
    });
  });
  host.pi.events.emit('pi-extended-teams:orchestration-request', { requestId: 'fixture-launch', type: 'spawn_agent', ctx: host.ctx,
    params: { name: 'isolated-child', prompt: 'Read approved source, then report.', model_slot: 'read-review', session_context: 'none' } });
  const admitted = await response;
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  const delivered = await report;
  assert.equal(delivered.ok, true, delivered.report);
  await settled;
  await childCost;
  const { createJiti } = createRequire(join(sdkRoot, 'package.json'))('jiti');
  const { buildReviewTelemetry } = await createJiti(import.meta.url).import('../src/telemetry-report.ts');
  const nativeEntries = f.session.sessionManager.getEntries();
  const telemetry = buildReviewTelemetry({
    sessionId: f.session.sessionManager.getSessionId(),
    runId: 'native-fixture',
    coordinatorSessionId: f.session.sessionManager.getSessionId(),
    startedAt: 0,
    completedAt: Date.now(),
    capturedAt: Date.now(),
    rootAvailable: true,
    entries: nativeEntries,
    children: nativeEntries.filter(entry => entry.type === 'custom' && entry.customType === 'pi-extended-teams-cost-v1').map(entry => entry.data),
  });
  assert.equal(telemetry.agents.length, 2);
  assert.equal(telemetry.agents[1].name, 'isolated-child');
  assert.equal(telemetry.agents[1].recordedResponses, 2);
  assert.equal(telemetry.models[0].model, 'gpt-6.1-sol');
  assert.equal(typeof telemetry.cost.totalUsd, 'number');
  assert.equal(telemetry.cost.billedUsd, null);
  assert.equal(JSON.stringify(telemetry).includes('PRIVATE_'), false);
  assert.equal(child.modelRuntime, f.runtime);
  assert.equal(child.thinkingLevel, 'medium');
  assert.equal(childTurns, 2);
  assert.equal(captures.some(body => body.reasoning.effort === 'xhigh'), true);
  assert.match(JSON.stringify(captures), /publicValue/);
  assert.match(JSON.stringify(captures), /not admitted/);
  assert.equal(JSON.stringify(captures).includes('PRIVATE_'), false);
  assert.equal(guard.summary.inferenceRequests, requests.filter(request => request.options.method === 'POST').length);
  assert.match(JSON.stringify(captures), /Tool bash not found/);
  retire();
  guard.close();
  const previousRequests = requests.length;
  const rejected = once('pi-extended-teams:agent-report', event => event.name === 'retired-child');
  host.pi.events.emit('pi-extended-teams:orchestration-request', { requestId: 'retired', type: 'spawn_agent', ctx: host.ctx,
    params: { name: 'retired-child', prompt: 'No input should be sent.', model_slot: 'read-review', session_context: 'none' } });
  assert.match((await rejected).report, /policy retired/);
  await f.session.waitForIdle();
  assert.equal(requests.length, previousRequests);
  await writeFile(join(f.root, '.pi/agent/pi-extended-teams/settings.json'), JSON.stringify({
    favoriteModels: { 'read-review': { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium', harness: 'fixture-external' } },
  }));
  const external = once('pi-extended-teams:orchestration-response', event => event.requestId === 'external');
  host.pi.events.emit('pi-extended-teams:orchestration-request', { requestId: 'external', type: 'spawn_agent', ctx: host.ctx,
    params: { name: 'external', prompt: 'Must not launch.', model_slot: 'read-review' } });
  assert.match((await external).error, /Native child policy.*external harness/);
});
