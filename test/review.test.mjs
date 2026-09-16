import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
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
    on: (event, handler) => eventHandlers.set(event, handler),
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
      getEntries: () => messages.map(item => ({ type: 'custom_message', customType: item.message.customType, content: item.message.content, details: item.message.details, display: item.message.display ?? false })),
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
    dir, storage, cwd, pi, commands, tools, messages, userMessages, notices, confirmations, execCalls, modelChanges, thinkingChanges, eventHandlers, behavior, ctx,
    command: context => commands.get('code-review').handler(context, ctx),
    tool: (context = '', signal) => tools.get('agentic_code_review').execute('call-1', { context }, signal, undefined, ctx),
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
  assert.equal(start.args[start.args.indexOf('--model') + 1], 'openai/gpt-test');
  assert.equal(start.args[start.args.indexOf('--thinking') + 1], 'medium');
  assert.ok(start.args.includes('--no-skills') && start.args.includes('--no-context-files'));
  const toolList = start.args[start.args.indexOf('--tools') + 1];
  assert.match(toolList, /spawn_swarm_agents/);
  assert.match(toolList, /get_agent_status/);
  assert.match(toolList, /agentic_code_review_read_prompt/);
  assert.doesNotMatch(toolList, /agentic_code_review_wave|spawn_agent,|report_and_exit|task_create|task_list|read-critical|read-analyze|agentic_code_review,/);

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

  writeFileSync(paths.review, JSON.stringify({ ...review, status: 'complete', completedAt: '2026-09-15T00:00:00Z', findings: [], commentDrafts: [] }));
  const completion = await harness.complete({ sessionId, runId, summary: 'Clean change.' });
  assert.equal(completion.terminate, true);
  await settleWatcher();
  const handoffs = harness.messages.filter(item => item.message.customType === 'agentic-code-review-complete');
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].options.triggerTurn, true);
  assert.equal(handoffs[0].message.details.runId, runId);
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

test('watchdog resumes an early-idle review session and delivers its completion marker', async t => {
  const harness = createReviewFixture(t);
  harness.pi.__disableAutoReviewWatchdog = false;
  const fallback = harness.behavior.execute.bind(harness.behavior);
  let resumed = 0;
  harness.behavior.execute = (command, args, options) => {
    if (command === 'herdr' && args[0] === 'agent' && args[1] === 'wait') {
      return { code: 0, stdout: JSON.stringify({ result: { agent: { agent_status: 'done' } } }), stderr: '' };
    }
    if (command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt' && String(args.at(-1)).startsWith('Resume the auto-review mission')) {
      resumed += 1;
      const session = join(harness.storage, 'session-1');
      const reviewName = readdirSync(session).find(name => name.endsWith('.review.json'));
      const runId = reviewName.replace('.review.json', '');
      writeFileSync(join(session, `${runId}.complete.json`), JSON.stringify({ sessionId: 'session-1', runId, status: 'complete', completedAt: '2026-09-15T00:00:00Z', summary: 'Recovered review completed.' }));
      return { code: 0, stdout: '{}', stderr: '' };
    }
    return fallback(command, args, options);
  };

  await harness.tool();
  await settleWatcher();
  assert.equal(resumed, 1);
  assert.equal(harness.messages.filter(item => item.message.customType === 'agentic-code-review-complete').length, 1);
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

test('workflow encodes one extended-teams batch and only the two low review tiers', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../prompts/workflow.md', import.meta.url)), 'utf8');
  const zone = readFileSync(fileURLToPath(new URL('../prompts/review-zone.md', import.meta.url)), 'utf8');
  const runtime = readFileSync(fileURLToPath(new URL('../src/runtime.ts', import.meta.url)), 'utf8');
  const presentation = readFileSync(fileURLToPath(new URL('../prompts/presentation.md', import.meta.url)), 'utf8');

  assert.match(workflow, /call `spawn_swarm_agents` from pi-extended-teams exactly once/);
  assert.match(workflow, /completion_group: \{ delivery: "all-settled" \}/);
  assert.match(workflow, /at most two `read-review` lanes plus at most one `read-collect`/);
  assert.match(workflow, /run `read-review` and `read-collect` at `medium`/);
  assert.match(workflow, /end the turn; the grouped report resumes this session/);
  assert.match(workflow, /Every lane prompt opens with a fixed header copied from the review JSON/);
  assert.match(workflow, /`prompts\.taste`, `prompts\.craft`, `prompts\.voice`/);
  assert.match(workflow, /then the `craft\.md` pass/);
  assert.match(workflow, /`vicinity above`\/`vicinity below`/);
  assert.match(workflow, /`file:` section is marked `no parser`/);
  assert.match(zone, /run the supplied `craft\.md` pass/);
  assert.match(zone, /One `craft` line/);
  assert.match(readFileSync(fileURLToPath(new URL('../prompts/pr-comments.md', import.meta.url)), 'utf8'), /A `fix` is a proposal, not a nit/);
  assert.match(workflow, /call `agentic_code_review_read_prompt` with its name; never search the filesystem/);
  assert.doesNotMatch(workflow, /Every prompt contains only/);
  assert.match(zone, /If a path is missing, call `agentic_code_review_read_prompt`/);
  assert.match(readFileSync(fileURLToPath(new URL('../prompts/collect.md', import.meta.url)), 'utf8'), /If a path is missing, call `agentic_code_review_read_prompt`/);
  assert.match(workflow, /The top-level review session takes those items and completes them directly/);
  assert.doesNotMatch(workflow, /agentic_code_review_wave|timeout_seconds|four minutes/);
  assert.match(workflow, /Timing is measurement for later optimization, never a work limit/);
  assert.match(workflow, /If the scan fails, record the reason and continue diff-only/);
  assert.match(workflow, /ask once with `ask_user`.*resume from the answer, and finish/s);
  assert.match(workflow, /Build `commentDrafts` with one exact full `pr-comments\.md` body per accepted finding/);
  assert.doesNotMatch(workflow, /read-critical|read-analyze/);
  assert.match(workflow, /no second batch/i);
  assert.match(zone, /never read the whole pack or whole diff/);
  assert.match(zone, /Stay under twelve direct file reads/);
  assert.match(runtime, /'spawn_swarm_agents'/);
  assert.doesNotMatch(runtime, /'spawn_agent'|'agentic_code_review_wave'|'task_create'|'task_list'/);
  assert.match(presentation, /render every accepted bug, question, nit and optional fix in full/);
  assert.match(presentation, /Do not paraphrase, group, truncate or replace comments with a count/);
  assert.match(presentation, /exact proposed comment blocks do not count toward that limit/i);

  const operational = [
    workflow,
    readFileSync(fileURLToPath(new URL('../prompts/session-launch.md', import.meta.url)), 'utf8'),
    readFileSync(fileURLToPath(new URL('../prompts/coordinator.md', import.meta.url)), 'utf8'),
    readFileSync(fileURLToPath(new URL('../prompts/launch.md', import.meta.url)), 'utf8'),
    readFileSync(fileURLToPath(new URL('../prompts/deep-collect.md', import.meta.url)), 'utf8'),
    readFileSync(fileURLToPath(new URL('../docs/runtime-v2.md', import.meta.url)), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(operational, /\b(?:replaced|formerly|no longer|we found)\b|\b(?:b05b|e4c20|9023)[a-z0-9-]*\b|\b(?:35m|19m|7m49)\b/i);
});

function exists(path) {
  try { statSync(path); return true; } catch { return false; }
}
