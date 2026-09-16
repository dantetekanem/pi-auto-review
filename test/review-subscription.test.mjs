import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const piRoot =
  process.env.PI_PACKAGE_ROOT ||
  resolve(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), '../..');
const require = createRequire(join(piRoot, 'package.json'));
const { createJiti } = require('jiti');
const host = createJiti(join(piRoot, 'package.json'));
const alias = Object.fromEntries(
  ['@earendil-works/pi-coding-agent', 'typebox'].map((name) => [name, fileURLToPath(host.esmResolve(name))]),
);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias });
const { registerReviewSubscription } = await jiti.import('../src/review-subscription.ts');
const runId = '123e4567-e89b-42d3-a456-426614174000';

function review(sessionId, overrides = {}) {
  return {
    schemaVersion: 1,
    runId,
    sessionId,
    status: 'prepared',
    preflight: { target: 'https://github.com/owner/repo/pull/7', head: 'abcdef0123456789' },
    paths: {},
    ...overrides,
  };
}

function fixture(t, callerId = 'caller') {
  const directory = mkdtempSync(join(tmpdir(), 'review-subscription-test-'));
  const root = join(directory, 'auto-review');
  const tools = new Map();
  const handlers = new Map();
  const bus = new Map();
  const messages = [];
  const sessionFile = join(directory, `${callerId}.jsonl`);
  const pi = {
    registerTool: (definition) => tools.set(definition.name, definition),
    on: (event, handler) => handlers.set(event, handler),
    events: {
      on: (channel, handler) => {
        bus.set(channel, handler);
        return () => bus.delete(channel);
      },
    },
    sendMessage: (message, options) => messages.push({ message, options }),
  };
  const ctx = {
    sessionManager: {
      getSessionId: () => callerId,
      getSessionFile: () => sessionFile,
    },
  };
  registerReviewSubscription(pi, root);
  t.after(() => {
    handlers.get('session_shutdown')?.();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    root,
    tools,
    handlers,
    bus,
    messages,
    ctx,
    sessionFile,
    subscribe: (input, context = ctx) =>
      tools.get('agentic_code_review_subscribe').execute('subscription-1', input, undefined, undefined, context),
    writeReview: (sessionId, data = review(sessionId)) => {
      const path = join(root, sessionId);
      mkdirSync(path, { recursive: true, mode: 0o700 });
      writeFileSync(join(path, `${runId}.review.json`), JSON.stringify(data));
      return path;
    },
    probe: (sessionFile, id = runId) => {
      let reply;
      bus.get('agentic-code-review:wait-probe')?.({
        version: 1,
        sessionFile,
        runId: id,
        reply: (value) => {
          reply = value;
        },
      });
      return reply;
    },
  };
}

const input = {
  reviewSessionId: 'reviewer',
  runId,
  expectedTarget: 'https://github.com/owner/repo/pull/7',
  expectedHead: 'abcdef0123456789',
};

async function settle() {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
}

test('enrolls only a distinct valid external review and exposes an exact waiting probe', async (t) => {
  const harness = fixture(t);
  harness.writeReview('reviewer');
  const result = await harness.subscribe(input);

  assert.match(result.content[0].text, /waiting/i);
  const probe = harness.probe(harness.sessionFile);
  assert.deepEqual(
    { ...probe, deadline: Number.isFinite(probe.deadline) },
    {
      version: 1,
      runId,
      sessionFile: harness.sessionFile,
      status: 'waiting',
      deadline: true,
    },
  );
  assert.equal(harness.probe(`${harness.sessionFile}.other`), undefined);
  await assert.rejects(harness.subscribe(input), /already registered/i);
  await assert.rejects(harness.subscribe({ ...input, reviewSessionId: 'caller' }), /same Pi session/i);
});

test('rejects malformed, completed, mismatched, and arbitrary review identities', async (t) => {
  const harness = fixture(t);
  await assert.rejects(harness.subscribe(input), /artifact.*not readable/i);
  harness.writeReview('reviewer', review('reviewer', { schemaVersion: 2 }));
  await assert.rejects(harness.subscribe(input), /schema/i);
  harness.writeReview('reviewer', review('reviewer', { preflight: { target: input.expectedTarget, head: 'other' } }));
  await assert.rejects(harness.subscribe(input), /head does not match/i);
  harness.writeReview('reviewer', review('reviewer', { status: 'complete', completedAt: '2026-09-15T00:00:00.000Z' }));
  await assert.rejects(harness.subscribe(input), /already complete/i);
  await assert.rejects(harness.subscribe({ ...input, reviewSessionId: '../escape' }), /Invalid review session ID/i);
});

test('delivers one completed review after a filesystem watcher race and retains delivered probe state', async (t) => {
  const harness = fixture(t);
  const directory = harness.writeReview('reviewer');
  await harness.subscribe(input);
  writeFileSync(
    join(directory, `${runId}.review.json`),
    JSON.stringify(
      review('reviewer', {
        status: 'complete',
        completedAt: '2026-09-15T00:00:00.000Z',
      }),
    ),
  );
  await settle();
  assert.equal(harness.messages.length, 0);
  writeFileSync(
    join(directory, `${runId}.complete.json`),
    JSON.stringify({
      sessionId: 'reviewer',
      runId,
      status: 'complete',
      completedAt: '2026-09-15T00:00:00.000Z',
      summary: 'Reviewed.',
    }),
  );
  await settle();

  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].options.triggerTurn, true);
  assert.equal(harness.messages[0].options.deliverAs, 'followUp');
  assert.match(harness.messages[0].message.content, /\.review\.json/);
  assert.equal(harness.probe(harness.sessionFile).status, 'delivered');
  await settle();
  assert.equal(harness.messages.length, 1);
});

test('ends once for present non-object completion JSON instead of treating it as absent', async (t) => {
  for (const marker of [null, false, 0, '', [], 'invalid']) {
    const harness = fixture(t);
    const directory = harness.writeReview('reviewer');
    await harness.subscribe(input);
    harness.writeReview(
      'reviewer',
      review('reviewer', { status: 'complete', completedAt: '2026-09-15T00:00:00.000Z' }),
    );
    writeFileSync(join(directory, `${runId}.complete.json`), JSON.stringify(marker));
    assert.equal(harness.probe(harness.sessionFile).status, 'ended');
    assert.equal(harness.messages.length, 1);
    assert.equal(harness.probe(harness.sessionFile).status, 'ended');
    assert.equal(harness.messages.length, 1);
  }
});

test('accepts the legacy running state used by findings and clears each lifecycle boundary', async (t) => {
  for (const event of ['session_start', 'session_tree', 'session_shutdown']) {
    const harness = fixture(t);
    harness.writeReview('reviewer', review('reviewer', { status: 'running' }));
    await harness.subscribe(input);
    assert.equal(harness.probe(harness.sessionFile).status, 'waiting');
    harness.handlers.get(event)();
    assert.equal(harness.probe(harness.sessionFile), undefined);
    assert.equal(harness.messages.length, 0);
  }
});

test('fails once at its deadline and clears registrations on lifecycle replacement', async (t) => {
  const harness = fixture(t);
  harness.writeReview('reviewer');
  await harness.subscribe({ ...input, timeoutMinutes: 1 });
  const deadline = harness.probe(harness.sessionFile).deadline;
  const clock = Date.now;
  Date.now = () => deadline + 1;
  try {
    harness.probe(harness.sessionFile);
  } finally {
    Date.now = clock;
  }
  await settle();
  assert.equal(harness.messages.length, 1);
  assert.match(harness.messages[0].message.content, /timed out/i);
  assert.equal(harness.probe(harness.sessionFile).status, 'ended');

  harness.handlers.get('session_tree')?.();
  assert.equal(harness.probe(harness.sessionFile), undefined);
  assert.equal(harness.messages.length, 1);
});
