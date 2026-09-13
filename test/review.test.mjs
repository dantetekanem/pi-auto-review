import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Reuse an installed Pi loader and its peers. This runner never installs packages.
const root = process.env.PI_PACKAGE_ROOT
  || resolve(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), '../..');
const require = createRequire(join(root, 'package.json'));
const { createJiti } = require('jiti');
const host = createJiti(join(root, 'package.json'));
const alias = Object.fromEntries(['@earendil-works/pi-coding-agent', 'typebox']
  .map(name => [name, fileURLToPath(host.esmResolve(name))]));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias });
const { registerReview } = await jiti.import('../src/index.ts');
const { createEventBus } = await import(join(root, 'dist/core/event-bus.js'));
const requestEvent = 'pi-extended-teams:orchestration-request';
const responseEvent = 'pi-extended-teams:orchestration-response';

function fixture(t, sessionId = 'session-1') {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-review-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const storage = join(dir, 'agent', 'auto-review'), cwd = join(dir, 'project');
  mkdirSync(cwd); writeFileSync(join(cwd, 'untouched.txt'), 'existing work');
  const commands = new Map(), tools = new Map(), messages = [], userMessages = [], notices = [], requests = [];
  const bus = createEventBus(), listeners = new Set(), active = ['spawn_agent'];
  const success = request => bus.emit(responseEvent, { requestId: request.requestId, type: request.type,
    ok: true, details: { name: request.params.name, role: 'write', queued: false } });
  const responder = { current: success };
  const events = {
    on(channel, listener) {
      const off = bus.on(channel, listener);
      if (channel === responseEvent) listeners.add(listener);
      return () => { listeners.delete(listener); off(); };
    },
    emit(channel, data) {
      if (channel === requestEvent) requests.push(data);
      bus.emit(channel, data);
    },
  };
  bus.on(requestEvent, request => responder.current?.(request));
  const pi = { on: () => {}, registerCommand: (name, definition) => commands.set(name, definition),
    registerTool: definition => tools.set(definition.name, definition), getActiveTools: () => active, events,
    sendMessage: (message, options) => messages.push({ message, options }),
    sendUserMessage: (content, options) => userMessages.push({ content, options }) };
  const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => sessionId },
    ui: { notify: (...args) => notices.push(args) } };
  registerReview(pi, storage);
  return { dir, storage, cwd, commands, tools, messages, userMessages, notices, active, ctx, requests, bus, listeners, responder, success,
    command: context => commands.get('code-review').handler(context, ctx),
    tool: (context = '', signal) => tools.get('agentic_code_review').execute('call-1', { context }, signal, undefined, ctx) };
}
const json = path => JSON.parse(readFileSync(path, 'utf8'));

test('installed Pi loader registers the review tools from a different cwd', async t => {
  const h = fixture(t);
  const { loadExtensions } = await import(join(root, 'dist/core/extensions/loader.js'));
  const loaded = await loadExtensions([fileURLToPath(new URL('../src/index.ts', import.meta.url))], h.cwd);
  assert.deepEqual(loaded.errors, []);
  assert.ok(loaded.extensions[0].commands.has('code-review'));
  assert.deepEqual([...loaded.extensions[0].tools.keys()].sort(), [
    'agentic_code_review', 'agentic_code_review_append_finding', 'agentic_code_review_save_learning',
  ]);
});

test('both entry points launch one nested-enabled coordinator with raw context and a short receipt', async t => {
  const h = fixture(t), context = '  https://example.test/pr/1\nFocus on "retries" and $ARGUMENTS.  ';
  await h.command(context);
  const result = await h.tool(context);
  assert.equal(h.requests.length, 2);
  for (const request of h.requests) {
    assert.equal(request.type, 'spawn_agent'); assert.equal(request.ctx, h.ctx);
    assert.equal(request.params.model_slot, 'write-critical');
    assert.equal(request.params.allow_nested_read_agents, true);
    const details = request.params.metadata;
    assert.equal(json(details.paths.review).context, context);
    assert.ok(request.params.prompt.includes(JSON.stringify(details.paths.review)));
    assert.ok(request.params.prompt.includes('coordinator.md'));
    assert.ok(request.params.prompt.length < 1500);
  }
  assert.equal(h.messages.length, 1); assert.equal(h.messages[0].options.triggerTurn, false);
  assert.equal(h.userMessages.length, 0);
  assert.equal(json(result.details.paths.review).context, context);
  assert.ok(result.content[0].text.length < 1500);
  assert.equal(h.listeners.size, 0);
});

test('prepared artifacts are private, readable, session-scoped and outside the project', async t => {
  const h = fixture(t), result = await h.tool();
  const { paths, runId, sessionId } = result.details;
  assert.equal(sessionId, 'session-1');
  for (const path of Object.values(paths)) {
    assert.equal(dirname(path), join(h.storage, sessionId));
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  const review = json(paths.review), bugs = json(paths.bugs);
  assert.equal(review.runId, runId); assert.equal(review.cwd, h.cwd);
  assert.equal(review.status, 'prepared'); assert.equal(bugs.status, 'prepared');
  assert.equal(review.presentationVersion, 1); assert.equal(bugs.presentationVersion, 1);
  assert.equal(review.prompts.presentation, fileURLToPath(new URL('../prompts/presentation.md', import.meta.url)));
  assert.equal(review.historyRoot, h.storage);
  assert.equal(review.codebasesRoot, join(h.storage, 'codebases'));
  for (const path of Object.values(review.prompts)) assert.ok(readFileSync(path, 'utf8').length > 0);
  assert.deepEqual(review.grades, { merge: null, deploy: null });
  assert.deepEqual(bugs.bugs, []); assert.deepEqual(bugs.findings, []);
  const record = JSON.parse(readFileSync(paths.map, 'utf8').trim());
  assert.equal(record.kind, 'run'); assert.equal(record.runId, runId);
  assert.equal(record.repository, null); assert.equal(record.revision, null);
  assert.deepEqual(record.sources, []);
  assert.deepEqual(readdirSync(h.cwd), ['untouched.txt']);
  assert.equal(readFileSync(join(h.cwd, 'untouched.txt'), 'utf8'), 'existing work');
});

test('later runs and sessions preserve prior evidence', async t => {
  const h = fixture(t), first = (await h.tool('first')).details;
  writeFileSync(first.paths.map, '{"kind":"learning","claim":"fixture"}\n');
  const second = (await h.tool('second')).details;
  assert.notEqual(first.runId, second.runId);
  assert.equal(json(first.paths.review).context, 'first');
  assert.equal(JSON.parse(readFileSync(first.paths.map, 'utf8')).claim, 'fixture');
  assert.equal(readdirSync(join(h.storage, 'session-1')).length, 6);
  h.ctx.sessionManager.getSessionId = () => 'session-2';
  assert.equal(dirname((await h.tool()).details.paths.map), join(h.storage, 'session-2'));
});

test('missing teams tools and invalid or pre-aborted input fail before preparation', async t => {
  const h = fixture(t); h.active.length = 0;
  await assert.rejects(h.tool(), /pi-extended-teams/);
  await h.command('request'); assert.equal(h.notices.at(-1)[1], 'error');
  h.active.push('spawn_swarm_agents');
  await assert.rejects(h.tool('', AbortSignal.abort()), /abort/i);
  await assert.rejects(h.tool('x'.repeat(8001)), /context/i);
  for (const sessionId of ['../escape', '', '/absolute', 'bad\n']) {
    h.ctx.sessionManager.getSessionId = () => sessionId;
    await assert.rejects(h.tool(), /session/i);
  }
  assert.equal(h.requests.length, 0); assert.deepEqual(readdirSync(h.dir), ['project']);
});

test('correlates concurrent responses and preserves coordinator writes made before acknowledgement', async t => {
  const h = fixture(t), pending = [];
  h.responder.current = request => pending.push(request);
  const first = h.tool('first'), second = h.tool('second');
  h.bus.emit(responseEvent, { requestId: 'unrelated', type: 'spawn_agent', ok: false, error: 'wrong run' });
  for (const request of pending.toReversed()) {
    const path = request.params.metadata.paths.review;
    writeFileSync(path, JSON.stringify({ ...json(path), status: 'running', coordinatorEvidence: 'already started' }));
    h.success(request);
  }
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => json(result.details.paths.review).context), ['first', 'second']);
  for (const result of results) assert.equal(json(result.details.paths.review).coordinatorEvidence, 'already started');
  assert.equal(h.listeners.size, 0);
});

test('reports queued admission or launch failure without retrying or claiming review completion', async t => {
  const h = fixture(t);
  h.responder.current = request => h.bus.emit(responseEvent, { requestId: request.requestId, type: request.type,
    ok: true, details: { name: request.params.name, queued: true } });
  const queued = await h.tool();
  assert.equal(queued.details.coordinator.queued, true); assert.equal(json(queued.details.paths.review).status, 'prepared');
  h.responder.current = request => h.bus.emit(responseEvent, { requestId: request.requestId, type: request.type, ok: false, error: 'admission failed' });
  await assert.rejects(h.tool(), /admission failed/);
  assert.equal(h.requests.length, 2); assert.equal(h.listeners.size, 0);
});

test('unacknowledged and interrupted dispatches release listeners and never resend', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fixture(t); h.responder.current = undefined;
  const timedOut = assert.rejects(h.tool(), /acknowledg.*do not retry/i);
  t.mock.timers.tick(30_000); await timedOut;
  const controller = new AbortController();
  const interrupted = assert.rejects(h.tool('', controller.signal), /do not retry/i);
  controller.abort(); await interrupted;
  assert.equal(h.requests.length, 2); assert.equal(h.listeners.size, 0);
  h.success(h.requests[0]);
  assert.equal(h.requests.length, 2);
});

test('storage failure is reported before requesting a coordinator', async t => {
  const h = fixture(t);
  mkdirSync(dirname(h.storage), { recursive: true }); writeFileSync(h.storage, 'occupied');
  await assert.rejects(h.tool(), /ENOTDIR|EEXIST/);
  await h.command('request');
  assert.equal(h.requests.length, 0); assert.equal(h.messages.length, 0); assert.equal(h.notices.at(-1)[1], 'error');
  assert.equal(readFileSync(h.storage, 'utf8'), 'occupied');
  h.ctx.hasUI = false;
  await assert.rejects(h.command('request'), /ENOTDIR|EEXIST/);
});
