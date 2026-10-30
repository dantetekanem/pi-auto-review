import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const piRoot = process.env.PI_PACKAGE_ROOT
  || resolve(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), '../..');
const require = createRequire(join(piRoot, 'package.json'));
const { createJiti } = require('jiti');
const host = createJiti(join(piRoot, 'package.json'));
const alias = Object.fromEntries(
  ['@earendil-works/pi-coding-agent', 'typebox']
    .map(name => [name, fileURLToPath(host.esmResolve(name))]),
);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias });
const { registerReview } = await jiti.import('../src/index.ts');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const sha = char => char.repeat(40);

function createReviewFixture(t, sessionId = 'session-1') {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-review-test-'));
  const storage = join(dir, 'agent', 'auto-review');
  const cwd = join(dir, 'project');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'untouched.txt'), 'existing work');

  const previousHerdr = process.env.HERDR_ENV;
  const previousPane = process.env.HERDR_PANE_ID;
  process.env.HERDR_ENV = '1';
  process.env.HERDR_PANE_ID = 'w1:p1';

  const commands = new Map();
  const tools = new Map();
  const messages = [];
  const userMessages = [];
  const notices = [];
  const confirmations = [];
  const execCalls = [];
  const modelChanges = [];
  const thinkingChanges = [];
  const eventHandlers = new Map();
  const nativeEntries = [];
  const behavior = {
    confirm: true,
    input: undefined,
    thinkingLevel: 'max',
    setModel: true,
    setThinking: true,
    execute(command, args) {
      if (command === 'gs') return { code: 0, stdout: JSON.stringify({ number: 42, title: 'Keep eligibility outside Verdict', baseSha: sha('a'), headSha: sha('b'), baseRef: 'main', headRef: 'feature', htmlUrl: 'https://meteorite.shopify.io/repos/shop/world/pulls/42' }), stderr: '' };
      if (command === 'gh') return { code: 0, stdout: JSON.stringify({ number: 7, title: 'GitHub change', baseRefOid: sha('c'), headRefOid: sha('d'), url: 'https://github.com/owner/repo/pull/7' }), stderr: '' };
      if (command === 'git') return { code: 0, stdout: `${sha('e')}\n`, stderr: '' };
      if (command === 'herdr' && args[0] === 'pane' && args[1] === 'layout') return { code: 0, stdout: JSON.stringify({ result: { layout: { panes: [{ pane_id: 'w1:p1', rect: { width: 200, height: 60 } }] } } }), stderr: '' };
      if (command === 'herdr' && args[0] === 'pane' && args[1] === 'split') return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: 'w1:p2' } } }), stderr: '' };
      return { code: 0, stdout: '{}', stderr: '' };
    },
  };

  const pi = {
    __disableAutoReviewWatchdog: true,
    on(event, handler) {
      const previous = eventHandlers.get(event);
      eventHandlers.set(event, (...args) => Promise.all([previous?.(...args), handler(...args)]));
    },
    appendEntry: (customType, data) => nativeEntries.push({ id: `native-${nativeEntries.length}`, type: 'custom', customType, data }),
    registerCommand: (name, definition) => commands.set(name, definition),
    registerTool: definition => tools.set(definition.name, definition),
    sendMessage: (message, options) => messages.push({ message, options }),
    sendUserMessage: (message, options) => userMessages.push({ message, options }),
    exec: async (command, args, options) => {
      execCalls.push({ command, args, options });
      return behavior.execute(command, args, options);
    },
    setModel: async model => {
      modelChanges.push(model);
      if (behavior.setModel) ctx.model = model;
      return behavior.setModel;
    },
    getThinkingLevel: () => behavior.thinkingLevel,
    setThinkingLevel: level => {
      thinkingChanges.push(level);
      if (behavior.setThinking) behavior.thinkingLevel = level;
    },
  };
  const ctx = {
    cwd,
    hasUI: true,
    model: { provider: 'openai', id: 'gpt-test', reasoning: true },
    thinkingLevel: 'medium',
    modelRegistry: {
      find: (provider, id) => [ctx.model, ...(ctx.scopedModels ?? []).map(item => item.model)].find(model => model.provider === provider && model.id === id),
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => [...messages.map(item => ({ type: 'custom_message', customType: item.message.customType, content: item.message.content, details: item.message.details, display: item.message.display ?? false })), ...nativeEntries],
    },
    ui: {
      notify: (...args) => notices.push(args),
      confirm: async (...args) => {
        confirmations.push(args);
        return behavior.confirm;
      },
      input: async () => behavior.input,
    },
  };
  registerReview(pi, storage);

  t.after(() => {
    eventHandlers.get('session_shutdown')?.();
    rmSync(dir, { recursive: true, force: true });
    if (previousHerdr === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previousHerdr;
    if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPane;
  });

  return {
    dir, storage, cwd, pi, commands, tools, messages, userMessages, notices, confirmations, execCalls, modelChanges, thinkingChanges, eventHandlers, nativeEntries, behavior, ctx,
    command: context => commands.get('code-review').handler(context, ctx),
    tool: (context = '', signal, options = {}) => tools.get('agentic_code_review').execute('call-1', { context, ...options }, signal, undefined, ctx),
    complete: input => tools.get('agentic_code_review_complete').execute('complete-1', input, undefined, undefined, ctx),
  };
}

function call(harness, command, startsWith) {
  return harness.execCalls.find(item => item.command === command && item.args.slice(0, startsWith.length).every((value, index) => value === startsWith[index]));
}

async function settleWatcher() {
  await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
}

test('installed Pi loader registers the dedicated-session review tools from a different cwd', async t => {
  const harness = createReviewFixture(t);
  const { loadExtensions } = await import(join(piRoot, 'dist/core/extensions/loader.js'));
  const loaded = await loadExtensions([fileURLToPath(new URL('../src/index.ts', import.meta.url))], harness.cwd);

  assert.deepEqual(loaded.errors, []);
  assert.ok(loaded.extensions[0].commands.has('code-review'));
  assert.deepEqual([...loaded.extensions[0].tools.keys()].sort(), [
    'agentic_code_review',
    'agentic_code_review_append_finding',
    'agentic_code_review_complete',
    'agentic_code_review_execute_experiment',
    'agentic_code_review_export_telemetry',
    'agentic_code_review_next_action',
    'agentic_code_review_read_learning',
    'agentic_code_review_read_prompt',
    'agentic_code_review_save_learning',
    'agentic_code_review_subscribe',
  ]);
});

test('tool preflights the current model at medium and starts one visible Pi pane without a delegated coordinator', async t => {
  const harness = createReviewFixture(t);
  const context = 'https://meteorite.shopify.io/repos/shop/world/pulls/42';
  const result = await harness.tool(context);

  assert.ok(result.details.preflight.elapsedMs >= 0);
  const { elapsedMs: _elapsedMs, ...preflight } = result.details.preflight;
  assert.deepEqual(preflight, {
    target: context,
    provider: 'meteorite',
    number: 42,
    title: 'Keep eligibility outside Verdict',
    base: sha('a'),
    head: sha('b'),
    checkout: harness.cwd,
    model: 'openai/gpt-test',
    thinking: 'medium',
  });
  const split = call(harness, 'herdr', ['pane', 'split']);
  assert.ok(split);
  assert.ok(split.args.includes('--no-focus'));
  assert.equal(split.args[split.args.indexOf('--direction') + 1], 'right');

  const start = call(harness, 'herdr', ['agent', 'start']);
  assert.ok(start);
  assert.equal(start.args[start.args.indexOf('--kind') + 1], 'pi');
  assert.deepEqual(start.args.slice(start.args.indexOf('--') + 1), [
    '--model', 'openai/gpt-test',
    '--thinking', 'medium',
    '--name', result.details.reviewSession.name,
  ]);

  const prompt = call(harness, 'herdr', ['agent', 'prompt']);
  assert.equal(prompt.args.at(-1), `Read the complete auto-review mission at ${result.details.paths.mission} and execute it now.`);
  assert.match(readFileSync(result.details.paths.mission, 'utf8'), /visible top-level review session/);
  assert.match(readFileSync(result.details.paths.mission, 'utf8'), new RegExp(result.details.paths.review.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.content[0].text, /Thinking: medium/);
  assert.match(result.content[0].text, /Herdr pane w1:p2/);
  assert.equal(harness.messages.length, 0);
  assert.equal(readJson(result.details.paths.review).preflight.thinking, 'medium');
  assert.equal(readJson(result.details.paths.review).reviewSession.name, result.details.reviewSession.name);
  assert.equal(readJson(result.details.paths.review).reviewSession.mode, 'pane');
  assert.equal(harness.execCalls.some(item => item.command === 'spawn_agent'), false);
  assert.deepEqual(harness.userMessages, []);
  assert.deepEqual(harness.thinkingChanges, []);
});

test('tool preserves active high and xhigh thinking through launch and saved preflight', async t => {
  for (const [thinking, thinkingLevelMap] of [
    ['high', undefined],
    ['xhigh', { xhigh: 'xhigh' }],
  ]) {
    const harness = createReviewFixture(t, `active-${thinking}`);
    harness.ctx.thinkingLevel = thinking;
    harness.behavior.thinkingLevel = thinking;
    harness.ctx.model.thinkingLevelMap = thinkingLevelMap;

    const result = await harness.tool();
    const start = call(harness, 'herdr', ['agent', 'start']);
    assert.equal(result.details.preflight.thinking, thinking);
    assert.equal(start.args[start.args.indexOf('--thinking') + 1], thinking);
    assert.equal(readJson(result.details.paths.review).preflight.thinking, thinking);
  }
});

test('current-session review adopts an exact xhigh-capable model without downgrading', async t => {
  const harness = createReviewFixture(t);
  harness.ctx.model.reasoning = false;
  harness.ctx.thinkingLevel = 'xhigh';
  harness.behavior.thinkingLevel = 'medium';
  harness.ctx.scopedModels = [{ model: {
    provider: 'openai', id: 'xhigh-model', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' },
  } }];

  await harness.command('');

  assert.deepEqual(harness.modelChanges.map(model => `${model.provider}/${model.id}`), ['openai/xhigh-model']);
  assert.deepEqual(harness.thinkingChanges, ['xhigh']);
  assert.equal(readJson(harness.messages[0].message.details.paths.review).preflight.thinking, 'xhigh');
  assert.match(harness.messages[0].message.content, /set model openai\/xhigh-model, thinking xhigh/);
});

test('current-session review refuses a runtime thinking clamp', async t => {
  const harness = createReviewFixture(t);
  harness.ctx.thinkingLevel = 'high';
  harness.behavior.thinkingLevel = 'medium';
  harness.behavior.setThinking = false;

  await harness.command('');

  assert.deepEqual(harness.thinkingChanges, ['high']);
  assert.equal(harness.userMessages.length, 0);
  assert.match(harness.notices[0][0], /could not select thinking high/);
});

test('xhigh preflight fails instead of falling back to a medium-only model', async t => {
  const harness = createReviewFixture(t);
  harness.ctx.thinkingLevel = 'xhigh';
  harness.ctx.model.thinkingLevelMap = { xhigh: null };
  harness.ctx.scopedModels = [{ model: { provider: 'anthropic', id: 'medium-model', reasoning: true } }];
  harness.behavior.input = 'anthropic/medium-model';

  await assert.rejects(harness.tool(), /xhigh-capable model selection/);
  assert.match(harness.notices[0][0], /does not support xhigh/);
  assert.equal(harness.execCalls.some(item => item.command === 'herdr' || item.command === 'pi'), false);
  assert.equal(exists(join(harness.storage, 'session-1')), false);
});

test('tool accepts per-run model and thinking without mutating the invoking session', async t => {
  const harness = createReviewFixture(t);
  const selected = {
    provider: 'openai-codex', id: 'gpt-6.1-sol', reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh' },
  };
  harness.ctx.modelRegistry.find = (provider, id) =>
    provider === selected.provider && id === selected.id ? selected : undefined;

  const result = await harness.tool('', undefined, { model: 'openai-codex/gpt-6.1-sol', thinking: 'xhigh' });
  const start = call(harness, 'herdr', ['agent', 'start']);
  assert.equal(result.details.preflight.model, 'openai-codex/gpt-6.1-sol');
  assert.equal(result.details.preflight.thinking, 'xhigh');
  assert.deepEqual(start.args.slice(start.args.indexOf('--') + 1), [
    '--model', 'openai-codex/gpt-6.1-sol', '--thinking', 'xhigh', '--name', result.details.reviewSession.name,
  ]);
  assert.deepEqual(harness.modelChanges, []);
  assert.deepEqual(harness.thinkingChanges, []);
  assert.equal(harness.ctx.model.id, 'gpt-test');
  assert.equal(harness.ctx.thinkingLevel, 'medium');
  const { elapsedMs: _elapsedMs, ...preflight } = readJson(result.details.paths.review).preflight;
  assert.deepEqual(preflight, {
    target: 'local working tree', provider: 'local', number: null, title: null,
    base: 'HEAD', head: sha('e'), checkout: harness.cwd,
    model: 'openai-codex/gpt-6.1-sol', thinking: 'xhigh',
  });

  const headless = createReviewFixture(t, 'headless-options');
  headless.ctx.modelRegistry.find = (provider, id) =>
    provider === selected.provider && id === selected.id ? selected : undefined;
  const fallback = headless.behavior.execute.bind(headless.behavior);
  headless.behavior.execute = (command, args, options) => {
    if (command === 'herdr') return { code: 1, stdout: '', stderr: 'pane unavailable' };
    return fallback(command, args, options);
  };

  const recovered = await headless.tool('', undefined, { model: 'openai-codex/gpt-6.1-sol', thinking: 'xhigh' });
  const pi = call(headless, 'pi', ['--mode', 'json']);
  assert.deepEqual(pi.args.slice(0, 9), [
    '--mode', 'json', '-p', '--no-session', '--no-approve', '--model', 'openai-codex/gpt-6.1-sol', '--thinking', 'xhigh',
  ]);
  assert.equal(recovered.details.preflight.model, 'openai-codex/gpt-6.1-sol');
  assert.equal(recovered.details.preflight.thinking, 'xhigh');
});

test('explicit unavailable or unsupported per-run options fail before artifacts or launch', async t => {
  const unknown = createReviewFixture(t);
  await assert.rejects(unknown.tool('', undefined, { model: 'missing/model', thinking: 'xhigh' }), /unavailable|registered/i);
  assert.equal(exists(join(unknown.storage, 'session-1')), false);
  assert.equal(unknown.execCalls.some(item => item.command === 'herdr' || item.command === 'pi'), false);

  const unsupported = createReviewFixture(t, 'unsupported-options');
  unsupported.ctx.modelRegistry.find = () => ({
    provider: 'openai', id: 'medium-only', reasoning: true,
    thinkingLevelMap: { xhigh: null },
  });
  await assert.rejects(unsupported.tool('', undefined, { model: 'openai/medium-only', thinking: 'xhigh' }), /does not support xhigh/i);
  assert.equal(exists(join(unsupported.storage, 'unsupported-options')), false);
  assert.equal(unsupported.execCalls.some(item => item.command === 'herdr' || item.command === 'pi'), false);
});

test('preflight reuses the newest matching reviewed checkout before falling back to the invoking cwd', async t => {
  const harness = createReviewFixture(t);
  const priorRoot = join(harness.dir, 'world-root');
  const history = join(harness.storage, 'old-session');
  mkdirSync(priorRoot);
  mkdirSync(history, { recursive: true });
  writeFileSync(join(history, 'old.review.json'), JSON.stringify({
    codebases: [{ repository: 'https://gitstream.shopify.io/shop/world.git', root: priorRoot }],
  }));

  const result = await harness.tool('https://meteorite.shopify.io/repos/shop/world/pulls/42');
  assert.equal(result.details.preflight.checkout, priorRoot);
  const split = call(harness, 'herdr', ['pane', 'split']);
  assert.equal(split.args[split.args.indexOf('--cwd') + 1], priorRoot);
});

test('preflight fetches a missing PR head without changing the working tree', async t => {
  const harness = createReviewFixture(t);
  let headProbes = 0;
  const fallback = harness.behavior.execute.bind(harness.behavior);
  harness.behavior.execute = (command, args, options) => {
    if (command === 'git' && args.includes('cat-file') && args.at(-1) === `${sha('b')}^{commit}`) {
      headProbes += 1;
      return headProbes === 1 ? { code: 1, stdout: '', stderr: 'missing' } : { code: 0, stdout: '', stderr: '' };
    }
    if (command === 'git' && args.includes('fetch')) return { code: 0, stdout: '', stderr: '' };
    return fallback(command, args, options);
  };

  await harness.tool('https://meteorite.shopify.io/repos/shop/world/pulls/42');
  const fetch = harness.execCalls.find(item => item.command === 'git' && item.args.includes('fetch'));
  assert.deepEqual(fetch.args.slice(-3), ['--no-tags', 'origin', 'feature']);
  assert.equal(headProbes, 2);
  assert.equal(harness.execCalls.some(item => item.command === 'git' && item.args.includes('checkout')), false);
});

test('provider metadata or commit failures launch from a saved provider patch instead of ending the review', async t => {
  const metadataFailure = createReviewFixture(t, 'metadata-fallback');
  const fallback = metadataFailure.behavior.execute.bind(metadataFailure.behavior);
  metadataFailure.behavior.execute = (command, args, options) => {
    if (command === 'gs' && args[0] === 'pr' && args[1] === 'view' && args.includes('--json')) return { code: 1, stdout: '', stderr: 'metadata unavailable' };
    if (command === 'gs' && args[0] === 'pr' && args[1] === 'diff') return { code: 0, stdout: 'diff --git a/a.rb b/a.rb\n+changed\n', stderr: '' };
    return fallback(command, args, options);
  };
  const metadata = await metadataFailure.tool('https://meteorite.shopify.io/repos/shop/world/pulls/42');
  assert.equal(metadata.details.preflight.base, 'unresolved');
  assert.match(readFileSync(metadata.details.paths.patch, 'utf8'), /\+changed/);
  assert.match(readJson(metadata.details.paths.review).prContext.gaps.join('\n'), /metadata unavailable/);

  const commitFailure = createReviewFixture(t, 'commit-fallback');
  const base = commitFailure.behavior.execute.bind(commitFailure.behavior);
  commitFailure.behavior.execute = (command, args, options) => {
    if (command === 'git' && args.includes('cat-file') && args.at(-1) === `${sha('b')}^{commit}`) return { code: 1, stdout: '', stderr: 'missing head' };
    if (command === 'git' && args.includes('fetch')) return { code: 1, stdout: '', stderr: 'fetch unavailable' };
    if (command === 'gs' && args[0] === 'pr' && args[1] === 'diff') return { code: 0, stdout: 'diff --git a/b.rb b/b.rb\n+fallback\n', stderr: '' };
    return base(command, args, options);
  };
  const commit = await commitFailure.tool('https://meteorite.shopify.io/repos/shop/world/pulls/42');
  const review = readJson(commit.details.paths.review);
  assert.match(review.prContext.gaps.join('\n'), /head commit.*fetch unavailable/);
  assert.match(readFileSync(commit.details.paths.patch, 'utf8'), /\+fallback/);
});

test('slash command preflights, sets this session to medium and runs the mission here without a pane', async t => {
  const harness = createReviewFixture(t);
  await harness.command('https://github.com/owner/repo/pull/7');

  assert.equal(harness.confirmations.length, 0);
  assert.equal(harness.execCalls.filter(item => item.command === 'herdr' || item.command === 'pi').length, 0);
  assert.ok(call(harness, 'gh', ['pr', 'view']));
  assert.deepEqual(harness.thinkingChanges, ['medium']);
  assert.deepEqual(harness.modelChanges, []);

  const receipts = harness.messages.filter(item => item.message.customType === 'agentic-code-review');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].options.triggerTurn, false);
  assert.match(receipts[0].message.content, /Target: GitHub change — https:\/\/github\.com\/owner\/repo\/pull\/7/);
  assert.match(receipts[0].message.content, /Thinking: medium/);
  assert.match(receipts[0].message.content, /Session: review-[0-9a-f]{8} in this Pi session \(set thinking medium\)/);
  const { paths, runId, sessionId, reviewSession } = receipts[0].message.details;
  assert.equal(reviewSession.mode, 'current');

  assert.deepEqual(harness.userMessages, [{
    message: `Read the complete auto-review mission at ${paths.mission} and execute it now.`,
    options: { deliverAs: 'followUp' },
  }]);
  const review = readJson(paths.review);
  assert.equal(review.status, 'prepared');
  assert.equal(review.reviewSession.mode, 'current');
  assert.equal(review.preflight.model, 'openai/gpt-test');
  assert.equal(review.preflight.thinking, 'medium');
  assert.match(readFileSync(paths.mission, 'utf8'), /visible top-level review session/);
  assert.match(readFileSync(paths.pr, 'utf8'), /GitHub change/);

  await harness.tools.get('agentic_code_review_subscribe').execute('subscribe', {
    reviewSessionId: sessionId, runId, expectedTarget: review.preflight.target, expectedHead: review.preflight.head,
  }, undefined, undefined, { sessionManager: { getSessionId: () => 'waiting-session', getSessionFile: () => '/tmp/waiting-session.jsonl' } });
  harness.nativeEntries.push({ id: 'before-mission', type: 'message', message: {
    role: 'assistant', provider: 'test', model: 'earlier-turn', usage: { cost: { total: 9 } },
  } });
  await harness.eventHandlers.get('before_agent_start')({ prompt: harness.userMessages[0].message }, harness.ctx);
  harness.nativeEntries.push({ id: 'observed-review-response', type: 'message', message: {
    role: 'assistant', provider: 'test', model: 'observed-model', usage: { cost: { total: 0.2 } },
  } });
  writeFileSync(paths.review, JSON.stringify({ ...review, status: 'complete', completedAt: '2026-09-15T00:00:00Z', findings: [], commentDrafts: [] }));
  const completion = await harness.complete({ sessionId, runId, summary: 'Clean change.' });
  assert.equal(completion.terminate, true);
  assert.equal(completion.details.telemetry.cost.totalUsd, 0.2);
  assert.equal(completion.details.telemetry.models[0].model, 'observed-model');
  assert.deepEqual(readJson(paths.review).telemetry, completion.details.telemetry);
  await settleWatcher();
  const handoffs = harness.messages.filter(item => item.message.customType === 'agentic-code-review-complete');
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].options.triggerTurn, true);
  assert.equal(handoffs[0].message.details.runId, runId);
  assert.deepEqual(handoffs[0].message.details.telemetry, completion.details.telemetry);
  const external = harness.messages.find(item => item.message.customType === 'agentic-code-review-subscription');
  assert.deepEqual(external.message.details.telemetry, completion.details.telemetry);
});

test('slash command switches this session to the preflighted medium model and reports a failed switch', async t => {
  const harness = createReviewFixture(t);
  harness.ctx.model.reasoning = false;
  harness.ctx.scopedModels = [{ model: { provider: 'anthropic', id: 'medium-model', reasoning: true } }];
  await harness.command('');

  assert.deepEqual(harness.modelChanges.map(model => `${model.provider}/${model.id}`), ['anthropic/medium-model']);
  assert.deepEqual(harness.thinkingChanges, ['medium']);
  assert.equal(harness.userMessages.length, 1);
  assert.match(harness.messages[0].message.content, /set model anthropic\/medium-model, thinking medium/);

  const refused = createReviewFixture(t, 'refused-switch');
  refused.ctx.model.reasoning = false;
  refused.ctx.scopedModels = [{ model: { provider: 'anthropic', id: 'medium-model', reasoning: true } }];
  refused.behavior.setModel = false;
  await refused.command('');
  assert.equal(refused.notices.length, 1);
  assert.match(refused.notices[0][0], /could not switch to anthropic\/medium-model/);
  assert.equal(refused.notices[0][1], 'error');
  assert.deepEqual(refused.userMessages, []);
  assert.deepEqual(refused.thinkingChanges, []);
});

test('slash command failures surface as one notice and send no mission', async t => {
  const harness = createReviewFixture(t);
  harness.ctx.sessionManager.getSessionId = () => '../escape';
  await harness.command('');

  assert.equal(harness.notices.length, 1);
  assert.match(harness.notices[0][0], /session/i);
  assert.equal(harness.notices[0][1], 'error');
  assert.deepEqual(harness.userMessages, []);
  assert.deepEqual(harness.messages, []);
  assert.equal(exists(dirname(harness.storage)), false);

  harness.ctx.hasUI = false;
  await assert.rejects(harness.command(''), /session/i);
});

test('session reload keeps a current-session run on its watcher instead of launching a pane', async t => {
  const harness = createReviewFixture(t);
  await harness.command('');
  const { paths, runId, sessionId } = harness.messages[0].message.details;
  harness.eventHandlers.get('session_shutdown')();
  harness.execCalls.length = 0;

  await harness.eventHandlers.get('session_start')({}, harness.ctx);
  await settleWatcher();
  assert.equal(harness.execCalls.filter(item => item.command === 'herdr').length, 0);
  assert.equal(harness.messages.filter(item => item.message.customType === 'agentic-code-review-complete').length, 0);

  writeFileSync(paths.complete, JSON.stringify({ sessionId, runId, status: 'complete', completedAt: '2026-09-15T00:00:00Z', summary: 'Finished after reload.' }));
  await settleWatcher();
  assert.equal(harness.messages.filter(item => item.message.customType === 'agentic-code-review-complete').length, 1);
});

test('completion validates optional evidence graphs against this run before publishing a marker', async t => {
  const harness = createReviewFixture(t);
  const { paths, runId, sessionId } = (await harness.tool('')).details;
  const review = { ...readJson(paths.review), status: 'complete', completedAt: '2026-10-27T00:00:00Z',
    evidenceGraph: { schemaVersion: 1, runId, nodes: [{ id: 'missing', kind: 'evidence', identities: [] }], incompatibilities: [] } };
  writeFileSync(paths.review, JSON.stringify(review));
  await assert.rejects(harness.complete({ sessionId, runId, summary: 'Source inspected.' }), /map record.*missing/i);
  assert.equal(exists(paths.complete), false);

  const record = { id: 'missing', runId, kind: 'evidence', repository: 'repo', revision: 'head', state: 'observed', sources: [] };
  writeFileSync(paths.map, readFileSync(paths.map, 'utf8') + JSON.stringify(record) + '\n');
  const result = await harness.complete({ sessionId, runId, summary: 'Source inspected.' });
  assert.equal(result.terminate, true);
  assert.equal(readJson(paths.complete).runId, runId);
  const assessment = readJson(paths.review).evidenceAssessment;
  assert.equal(assessment.basis, 'recorded-identities');
  assert.equal(assessment.nodes[0].status, 'unknown');
  assert.deepEqual(assessment.nodes[0].reasons, ['missing-identity']);
});

test('prepared artifacts are private and completion wakes the invoking session exactly once', async t => {
  const harness = createReviewFixture(t);
  const result = await harness.tool('https://meteorite.shopify.io/repos/shop/world/pulls/42');
  const { paths, runId, sessionId } = result.details;

  for (const path of [paths.map, paths.bugs, paths.review, paths.pr, paths.threads, paths.prContext, paths.mission]) {
    assert.equal(dirname(path), join(harness.storage, sessionId));
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  assert.match(readFileSync(paths.pr, 'utf8'), /Keep eligibility outside Verdict/);
  assert.ok(readJson(paths.prContext).checks);
  assert.equal(exists(paths.complete), false);
  const review = readJson(paths.review);
  assert.equal(review.status, 'prepared');
  assert.deepEqual(review.commentDrafts, []);
  assert.equal(review.preflight.thinking, 'medium');
  assert.equal(review.prompts.session, fileURLToPath(new URL('../prompts/session-launch.md', import.meta.url)));
  assert.equal(review.prompts.workflow, fileURLToPath(new URL('../prompts/workflow.md', import.meta.url)));
  assert.equal(paths.prompts, join(harness.storage, sessionId, `${runId}.prompts`));
  assert.equal(statSync(paths.prompts).mode & 0o777, 0o700);
  for (const [key, file] of [['reviewZone', 'review-zone'], ['collect', 'collect'], ['taste', 'taste'], ['craft', 'craft'], ['voice', 'voice'], ['prComments', 'pr-comments'], ['presentation', 'presentation']]) {
    assert.equal(review.prompts[key], join(paths.prompts, `${file}.md`));
    assert.equal(statSync(review.prompts[key]).mode & 0o777, 0o600);
    assert.equal(readFileSync(review.prompts[key], 'utf8'), readFileSync(fileURLToPath(new URL(`../prompts/${file}.md`, import.meta.url)), 'utf8'));
  }
  assert.equal(review.collection, null);
  assert.equal(review.learning, null);
  assert.equal(review.timing, null);
  assert.deepEqual(readdirSync(harness.cwd), ['untouched.txt']);

  await assert.rejects(harness.complete({ sessionId, runId, summary: 'Too early' }), /complete the review json/i);
  writeFileSync(paths.review, JSON.stringify({ ...review, status: 'incomplete', completedAt: '2026-09-15T00:00:00Z' }));
  await assert.rejects(harness.complete({ sessionId, runId, summary: 'Old state' }), /complete the review json/i);
  const accepted = { ...review, status: 'complete', completedAt: '2026-09-15T00:00:00Z', findings: [{ id: 'finding-1', state: 'accepted' }], commentDrafts: [] };
  writeFileSync(paths.review, JSON.stringify(accepted));
  await assert.rejects(harness.complete({ sessionId, runId, summary: 'Missing draft' }), /Every accepted finding needs one valid commentDraft/);
  writeFileSync(paths.review, JSON.stringify({ ...accepted, commentDrafts: [{ findingId: 'finding-1', path: 'app/a.rb', line: 3, kind: 'fix', lens: 'tests_coverage', blocks: false, body: 'Add the missing assertion.\n\n**Review details (for agents)**\n\nThe false path is not asserted.\n\nPi auto-review - Model: test/medium - Rate: B **(nonblocking)**' }] }));
  const completion = await harness.complete({ sessionId, runId, summary: 'The code is sound. One optional simplification remains.' });
  assert.equal(completion.terminate, true);
  assert.equal(statSync(paths.complete).mode & 0o777, 0o600);
  await settleWatcher();
  const handoffs = harness.messages.filter(item => item.message.customType === 'agentic-code-review-complete');
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].options.triggerTurn, true);
  assert.equal(handoffs[0].options.deliverAs, 'followUp');
  assert.match(handoffs[0].message.content, /read .*\.review\.json.*\.bugs\.json/i);
  const repeat = await harness.complete({ sessionId, runId, summary: 'The code is sound. One optional simplification remains.' });
  assert.equal(repeat.terminate, true);
  await assert.rejects(harness.complete({ sessionId, runId, summary: 'Different' }), /different completion/i);
  await settleWatcher();
  assert.equal(harness.messages.filter(item => item.message.customType === 'agentic-code-review-complete').length, 1);
});

test('completion refuses unlinked machine evidence even when its prose is marked complete', async t => {
  const harness = createReviewFixture(t);
  const { paths, sessionId, runId } = (await harness.tool('')).details;
  writeFileSync(paths.review, JSON.stringify({ ...readJson(paths.review), status: 'complete', completedAt: '2026-10-27T00:00:00Z',
    machineClaims: [{ claimId: 'missing', kind: 'execution', requestDigest: 'a'.repeat(64), receipts: ['b'.repeat(64)] }] }));
  await assert.rejects(harness.complete({ sessionId, runId, summary: 'Confirmed by experiment.' }), /claim|graph/i);
  assert.equal(exists(paths.complete), false);
});

test('completion attaches verified runner receipts rather than agent-supplied execution claims', async t => {
  const harness = createReviewFixture(t);
  await harness.command('https://github.com/owner/repo/pull/7');
  const { paths, sessionId, runId } = harness.messages[0].message.details;
  const directory = join(harness.storage, sessionId, `${runId}.experiments`);
  const receiptPath = join(directory, 'replay-ABC123', 'receipt.json');
  mkdirSync(dirname(receiptPath), { recursive: true });
  const bytes = JSON.stringify({ runId, status: 'completed', observation: 'passed' });
  writeFileSync(receiptPath, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(directory, 'index.jsonl'), JSON.stringify({ checkId: 'head', path: 'replay-ABC123/receipt.json', sha256 }) + '\n');
  writeFileSync(paths.review, JSON.stringify({ ...readJson(paths.review), status: 'complete', completedAt: '2026-10-26T00:00:00Z', executionReceipts: [{ path: 'invented' }] }));
  writeFileSync(receiptPath, '{}');
  await assert.rejects(harness.complete({ sessionId, runId, summary: 'Checked.' }), /receipt/);
  assert.equal(exists(paths.complete), false);
  writeFileSync(receiptPath, bytes);
  await harness.complete({ sessionId, runId, summary: 'Checked.' });
  assert.deepEqual(readJson(paths.review).executionReceipts, [{ checkId: 'head', path: realpathSync(receiptPath), sha256 }]);
});

function createRecoveryFixture(t, deliveryCode = 0) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const harness = createReviewFixture(t);
  harness.pi.__disableAutoReviewWatchdog = false;
  const fallback = harness.behavior.execute.bind(harness.behavior);
  const agent = {
    pane_id: 'w1:p2',
    agent_status: 'done',
    state_change_seq: 1,
    interactive_ready: true,
    launch_pending: false,
  };
  const reply = () => ({ code: 0, stdout: JSON.stringify({ result: { agent } }), stderr: '' });
  let settle;
  let attempts = 0;
  harness.behavior.execute = (command, args, options) => {
    if (command === 'herdr' && args[0] === 'agent') {
      if (args[1] === 'get') return reply();
      if (args[1] === 'wait') {
        return new Promise(resolve => {
          settle = resolve;
          options.signal.addEventListener('abort', () => resolve({ code: 1, stdout: '' }), { once: true });
        });
      }
      if (args[1] === 'prompt' && String(args.at(-1)).startsWith('Resume the auto-review mission')) {
        attempts += 1;
        return { code: deliveryCode, stdout: '', stderr: 'delivery result' };
      }
    }
    return fallback(command, args, options);
  };
  return {
    ...harness,
    agent,
    attempts: () => attempts,
    async idle(sequence, status = 'idle') {
      Object.assign(agent, { agent_status: status, state_change_seq: sequence });
      settle(reply());
      await new Promise(setImmediate);
    },
    async advance(ms) {
      t.mock.timers.tick(ms);
      await new Promise(setImmediate);
    },
  };
}

test('watchdog requires five quiet minutes, rechecks activity, and caps follow-ups across reattachment', async t => {
  const harness = createRecoveryFixture(t);
  await harness.tool();
  await harness.idle(1);
  await harness.advance(299_999);
  assert.equal(harness.attempts(), 0);

  Object.assign(harness.agent, { agent_status: 'working', state_change_seq: 2 });
  await harness.advance(1);
  assert.equal(harness.attempts(), 0);

  await harness.idle(3);
  harness.agent.state_change_seq = 5; // Work started and finished during the quiet window.
  await harness.advance(300_000);
  assert.equal(harness.attempts(), 0);

  await harness.idle(5);
  await harness.advance(300_000);
  assert.equal(harness.attempts(), 1);
  harness.eventHandlers.get('session_shutdown')();
  await harness.eventHandlers.get('session_start')({}, harness.ctx);
  await harness.advance(600_000);
  assert.equal(harness.attempts(), 1);
});

test('watchdog requires a ready, non-busy agent with known activity at the final check', async t => {
  for (const [name, state] of Object.entries({
    bootstrapping: { launch_pending: true },
    notReady: { interactive_ready: false },
    blocked: { agent_status: 'blocked' },
    unknown: { agent_status: 'unknown' },
    missingActivity: { state_change_seq: undefined },
  })) {
    await t.test(name, async t => {
      const harness = createRecoveryFixture(t);
      await harness.tool();
      await harness.idle(1);
      Object.assign(harness.agent, state);
      await harness.advance(300_000);
      assert.equal(harness.attempts(), 0);
    });
  }
});

test('an uncertain follow-up delivery consumes the run allowance across reattachment', async t => {
  const harness = createRecoveryFixture(t, 1);
  await harness.tool();
  await harness.idle(1, 'done');
  await harness.advance(300_000);
  harness.eventHandlers.get('session_shutdown')();
  await harness.eventHandlers.get('session_start')({}, harness.ctx);
  await harness.advance(600_000);
  assert.equal(harness.attempts(), 1);
});

test('session reload does not restart a review whose agent is gone', async t => {
  const harness = createReviewFixture(t);
  await harness.tool();
  harness.eventHandlers.get('session_shutdown')();
  const fallback = harness.behavior.execute.bind(harness.behavior);
  harness.behavior.execute = (command, args, options) => command === 'herdr' && args[1] === 'get'
    ? { code: 1, stdout: '', stderr: 'agent_not_found' }
    : fallback(command, args, options);

  await harness.eventHandlers.get('session_start')({}, harness.ctx);

  assert.equal(harness.execCalls.filter(item => item.command === 'herdr' && item.args[1] === 'split').length, 1);
  assert.equal(harness.execCalls.filter(item => item.command === 'herdr' && item.args[1] === 'prompt').length, 1);
});

test('session reload reattaches a durable completion once without duplicating its handoff', async t => {
  const harness = createReviewFixture(t);
  const result = await harness.tool();
  harness.eventHandlers.get('session_shutdown')();
  const marker = { sessionId: result.details.sessionId, runId: result.details.runId, status: 'complete', completedAt: '2026-09-15T00:00:00Z', summary: 'Completed while the parent was reloading.' };
  writeFileSync(result.details.paths.complete, JSON.stringify(marker));

  await harness.eventHandlers.get('session_start')({}, harness.ctx);
  await settleWatcher();
  assert.equal(harness.messages.filter(item => item.message.customType === 'agentic-code-review-complete').length, 1);
  await harness.eventHandlers.get('session_start')({}, harness.ctx);
  await settleWatcher();
  assert.equal(harness.messages.filter(item => item.message.customType === 'agentic-code-review-complete').length, 1);
});

test('preflight selects a medium fallback before handling missing Herdr, aborts and invalid input', async t => {
  const harness = createReviewFixture(t);
  harness.ctx.model.reasoning = false;
  harness.ctx.scopedModels = [{ model: { provider: 'anthropic', id: 'medium-model', reasoning: true } }];
  const fallback = await harness.tool();
  assert.equal(fallback.details.preflight.model, 'anthropic/medium-model');
  assert.equal(fallback.details.preflight.thinking, 'medium');

  harness.ctx.model.reasoning = true;
  harness.ctx.scopedModels = [];
  delete process.env.HERDR_ENV;
  const headless = await harness.tool();
  assert.equal(headless.details.reviewSession.paneId, 'headless');
  const headlessArgs = call(harness, 'pi', []).args;
  for (const flag of ['--tools', '--no-skills', '--no-prompt-templates', '--no-context-files']) {
    assert.equal(headlessArgs.includes(flag), false, flag);
  }
  process.env.HERDR_ENV = '1';
  await assert.rejects(harness.tool('', AbortSignal.abort()), /abort/i);
  await assert.rejects(harness.tool('x'.repeat(8001)), /context/i);
  for (const sessionId of ['../escape', '', '/absolute', 'bad\n']) {
    harness.ctx.sessionManager.getSessionId = () => sessionId;
    await assert.rejects(harness.tool(), /session/i);
  }
});

test('parallel invocations stay isolated and two failed pane starts recover through one headless review', async t => {
  const harness = createReviewFixture(t);
  const [first, second] = await Promise.all([harness.tool('first'), harness.tool('second')]);
  assert.notEqual(first.details.runId, second.details.runId);
  assert.equal(readJson(first.details.paths.review).context, 'first');
  assert.equal(readJson(second.details.paths.review).context, 'second');

  let starts = 0;
  harness.behavior.execute = (command, args) => {
    if (command === 'git') return { code: 0, stdout: `${sha('e')}\n`, stderr: '' };
    if (command === 'herdr' && args[0] === 'pane' && args[1] === 'layout') return { code: 0, stdout: JSON.stringify({ result: { layout: { panes: [] } } }), stderr: '' };
    if (command === 'herdr' && args[0] === 'pane' && args[1] === 'split') return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: 'w1:p9' } } }), stderr: '' };
    if (command === 'herdr' && args[0] === 'agent' && args[1] === 'start') {
      starts += 1;
      return { code: 1, stdout: '', stderr: 'agent did not start' };
    }
    return { code: 0, stdout: '{}', stderr: '' };
  };
  const recovered = await harness.tool('failure');
  assert.equal(starts, 2);
  assert.equal(recovered.details.reviewSession.paneId, 'headless');
  assert.equal(harness.execCalls.filter(item => item.command === 'pi').length, 1);
  assert.equal(harness.execCalls.filter(item => item.command === 'herdr' && item.args[0] === 'pane' && item.args[1] === 'close').length, 2);
});

test('lanes can read any lane prompt by name without a path', async t => {
  const harness = createReviewFixture(t);
  const readPrompt = (name, signal) => harness.tools.get('agentic_code_review_read_prompt').execute('prompt-1', { name }, signal, undefined, harness.ctx);

  const taste = await readPrompt('taste');
  assert.equal(taste.content[0].text, readFileSync(fileURLToPath(new URL('../prompts/taste.md', import.meta.url)), 'utf8'));
  assert.equal(taste.details.path, fileURLToPath(new URL('../prompts/taste.md', import.meta.url)));
  for (const name of ['review-zone', 'collect', 'craft', 'voice', 'pr-comments', 'presentation']) {
    assert.match((await readPrompt(name)).content[0].text, /\S/);
  }
  await assert.rejects(readPrompt('workflow'), /Unknown review prompt/);
  await assert.rejects(readPrompt('../package.json'), /Unknown review prompt/);
  await assert.rejects(readPrompt('taste', AbortSignal.abort()), /abort/i);
  assert.equal(harness.execCalls.length, 0);
});

function exists(path) {
  try { statSync(path); return true; } catch { return false; }
}
