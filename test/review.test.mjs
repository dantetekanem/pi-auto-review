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

// Reuse an installed Pi loader and its peers. This runner never installs packages.
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
const { createEventBus } = await import(join(piRoot, 'dist/core/event-bus.js'));
const requestEvent = 'pi-extended-teams:orchestration-request';
const responseEvent = 'pi-extended-teams:orchestration-response';
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

function createReviewFixture(t, sessionId = 'session-1') {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-review-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const storage = join(dir, 'agent', 'auto-review');
  const cwd = join(dir, 'project');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'untouched.txt'), 'existing work');

  const commands = new Map();
  const tools = new Map();
  const messages = [];
  const userMessages = [];
  const notices = [];
  const requests = [];
  const bus = createEventBus();
  const listeners = new Set();
  const active = ['spawn_agent'];
  const success = request => bus.emit(responseEvent, {
    requestId: request.requestId,
    type: request.type,
    ok: true,
    details: {
      name: request.params.name,
      role: 'write',
      queued: false,
    },
  });
  const responder = { current: success };
  const events = {
    on(channel, listener) {
      const off = bus.on(channel, listener);
      if (channel === responseEvent) listeners.add(listener);

      return () => {
        listeners.delete(listener);
        off();
      };
    },
    emit(channel, data) {
      if (channel === requestEvent) requests.push(data);
      bus.emit(channel, data);
    },
  };
  bus.on(requestEvent, request => responder.current?.(request));

  const pi = {
    on: () => {},
    registerCommand: (name, definition) => commands.set(name, definition),
    registerTool: definition => tools.set(definition.name, definition),
    getActiveTools: () => active,
    events,
    sendMessage: (message, options) => messages.push({ message, options }),
    sendUserMessage: (content, options) => userMessages.push({ content, options }),
  };
  const ctx = {
    cwd,
    hasUI: true,
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify: (...args) => notices.push(args) },
  };
  registerReview(pi, storage);

  return {
    dir,
    storage,
    cwd,
    commands,
    tools,
    messages,
    userMessages,
    notices,
    active,
    ctx,
    requests,
    bus,
    listeners,
    responder,
    success,
    command: context => commands.get('code-review').handler(context, ctx),
    tool: (context = '', signal) => tools.get('agentic_code_review')
      .execute('call-1', { context }, signal, undefined, ctx),
  };
}

test('installed Pi loader registers the review tools from a different cwd', async t => {
  const harness = createReviewFixture(t);
  const { loadExtensions } = await import(join(piRoot, 'dist/core/extensions/loader.js'));

  const loaded = await loadExtensions(
    [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
    harness.cwd,
  );

  assert.deepEqual(loaded.errors, []);
  assert.ok(loaded.extensions[0].commands.has('code-review'));
  assert.deepEqual([...loaded.extensions[0].tools.keys()].sort(), [
    'agentic_code_review',
    'agentic_code_review_append_finding',
    'agentic_code_review_save_learning',
  ]);
});

test('both entry points launch one nested-enabled coordinator with raw context and a short receipt', async t => {
  const harness = createReviewFixture(t);
  const context = '  https://example.test/pr/1\nFocus on "retries" and $ARGUMENTS.  ';

  await harness.command(context);
  const result = await harness.tool(context);

  assert.equal(harness.requests.length, 2);
  for (const request of harness.requests) {
    assert.equal(request.type, 'spawn_agent');
    assert.equal(request.ctx, harness.ctx);
    assert.equal(request.params.model_slot, 'write-critical');
    assert.equal(request.params.allow_nested_read_agents, true);

    const details = request.params.metadata;
    assert.equal(readJson(details.paths.review).context, context);
    assert.ok(request.params.prompt.includes(JSON.stringify(details.paths.review)));
    assert.ok(request.params.prompt.includes('coordinator.md'));
    assert.ok(request.params.prompt.length < 1500);
  }
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].options.triggerTurn, false);
  assert.equal(harness.userMessages.length, 0);
  assert.equal(readJson(result.details.paths.review).context, context);
  assert.ok(result.content[0].text.length < 1500);
  assert.equal(harness.listeners.size, 0);
});

test('prepared artifacts are private, readable, session-scoped and outside the project', async t => {
  const harness = createReviewFixture(t);

  const result = await harness.tool();
  const { paths, runId, sessionId } = result.details;

  assert.equal(sessionId, 'session-1');
  for (const path of Object.values(paths)) {
    assert.equal(dirname(path), join(harness.storage, sessionId));
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }

  const review = readJson(paths.review);
  const bugs = readJson(paths.bugs);
  assert.equal(review.runId, runId);
  assert.equal(review.cwd, harness.cwd);
  assert.equal(review.status, 'prepared');
  assert.equal(bugs.status, 'prepared');
  assert.equal(review.presentationVersion, 1);
  assert.equal(bugs.presentationVersion, 1);
  assert.equal(
    review.prompts.presentation,
    fileURLToPath(new URL('../prompts/presentation.md', import.meta.url)),
  );
  assert.equal(review.historyRoot, harness.storage);
  assert.equal(review.codebasesRoot, join(harness.storage, 'codebases'));
  for (const path of Object.values(review.prompts)) {
    assert.ok(readFileSync(path, 'utf8').length > 0);
  }
  assert.deepEqual(review.grades, { merge: null, deploy: null });
  assert.deepEqual(bugs.bugs, []);
  assert.deepEqual(bugs.findings, []);

  const record = JSON.parse(readFileSync(paths.map, 'utf8').trim());
  assert.equal(record.kind, 'run');
  assert.equal(record.runId, runId);
  assert.equal(record.repository, null);
  assert.equal(record.revision, null);
  assert.deepEqual(record.sources, []);
  assert.deepEqual(readdirSync(harness.cwd), ['untouched.txt']);
  assert.equal(readFileSync(join(harness.cwd, 'untouched.txt'), 'utf8'), 'existing work');
});

test('later runs and sessions preserve prior evidence', async t => {
  const harness = createReviewFixture(t);
  const first = (await harness.tool('first')).details;
  writeFileSync(first.paths.map, '{"kind":"learning","claim":"fixture"}\n');

  const second = (await harness.tool('second')).details;

  assert.notEqual(first.runId, second.runId);
  assert.equal(readJson(first.paths.review).context, 'first');
  assert.equal(JSON.parse(readFileSync(first.paths.map, 'utf8')).claim, 'fixture');
  assert.equal(readdirSync(join(harness.storage, 'session-1')).length, 6);

  harness.ctx.sessionManager.getSessionId = () => 'session-2';
  assert.equal(dirname((await harness.tool()).details.paths.map), join(harness.storage, 'session-2'));
});

test('missing teams tools and invalid or pre-aborted input fail before preparation', async t => {
  const harness = createReviewFixture(t);
  harness.active.length = 0;

  await assert.rejects(harness.tool(), /pi-extended-teams/);
  await harness.command('request');
  assert.equal(harness.notices.at(-1)[1], 'error');

  harness.active.push('spawn_swarm_agents');
  await assert.rejects(harness.tool('', AbortSignal.abort()), /abort/i);
  await assert.rejects(harness.tool('x'.repeat(8001)), /context/i);
  for (const sessionId of ['../escape', '', '/absolute', 'bad\n']) {
    harness.ctx.sessionManager.getSessionId = () => sessionId;
    await assert.rejects(harness.tool(), /session/i);
  }
  assert.equal(harness.requests.length, 0);
  assert.deepEqual(readdirSync(harness.dir), ['project']);
});

test('correlates concurrent responses and preserves coordinator writes made before acknowledgement', async t => {
  const harness = createReviewFixture(t);
  const pending = [];
  harness.responder.current = request => pending.push(request);

  const first = harness.tool('first');
  const second = harness.tool('second');
  harness.bus.emit(responseEvent, {
    requestId: 'unrelated',
    type: 'spawn_agent',
    ok: false,
    error: 'wrong run',
  });
  for (const request of pending.toReversed()) {
    const path = request.params.metadata.paths.review;
    writeFileSync(path, JSON.stringify({
      ...readJson(path),
      status: 'running',
      coordinatorEvidence: 'already started',
    }));
    harness.success(request);
  }
  const results = await Promise.all([first, second]);

  assert.deepEqual(results.map(result => readJson(result.details.paths.review).context), ['first', 'second']);
  for (const result of results) {
    assert.equal(readJson(result.details.paths.review).coordinatorEvidence, 'already started');
  }
  assert.equal(harness.listeners.size, 0);
});

test('reports queued admission or launch failure without retrying or claiming review completion', async t => {
  const harness = createReviewFixture(t);
  harness.responder.current = request => harness.bus.emit(responseEvent, {
    requestId: request.requestId,
    type: request.type,
    ok: true,
    details: { name: request.params.name, queued: true },
  });

  const queued = await harness.tool();

  assert.equal(queued.details.coordinator.queued, true);
  assert.equal(readJson(queued.details.paths.review).status, 'prepared');

  harness.responder.current = request => harness.bus.emit(responseEvent, {
    requestId: request.requestId,
    type: request.type,
    ok: false,
    error: 'admission failed',
  });
  await assert.rejects(harness.tool(), /admission failed/);
  assert.equal(harness.requests.length, 2);
  assert.equal(harness.listeners.size, 0);
});

test('unacknowledged and interrupted dispatches release listeners and never resend', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const harness = createReviewFixture(t);
  harness.responder.current = undefined;

  const timedOut = assert.rejects(harness.tool(), /acknowledg.*do not retry/i);
  t.mock.timers.tick(30_000);
  await timedOut;

  const controller = new AbortController();
  const interrupted = assert.rejects(harness.tool('', controller.signal), /do not retry/i);
  controller.abort();
  await interrupted;

  assert.equal(harness.requests.length, 2);
  assert.equal(harness.listeners.size, 0);
  harness.success(harness.requests[0]);
  assert.equal(harness.requests.length, 2);
});

test('storage failure is reported before requesting a coordinator', async t => {
  const harness = createReviewFixture(t);
  mkdirSync(dirname(harness.storage), { recursive: true });
  writeFileSync(harness.storage, 'occupied');

  await assert.rejects(harness.tool(), /ENOTDIR|EEXIST/);
  await harness.command('request');

  assert.equal(harness.requests.length, 0);
  assert.equal(harness.messages.length, 0);
  assert.equal(harness.notices.at(-1)[1], 'error');
  assert.equal(readFileSync(harness.storage, 'utf8'), 'occupied');

  harness.ctx.hasUI = false;
  await assert.rejects(harness.command('request'), /ENOTDIR|EEXIST/);
});
