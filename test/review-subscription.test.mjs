import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
    discover: (input = {}) => tools.get('agentic_code_review_list').execute('list-1', input),
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

test('discovers recorded states without telemetry or writes and supplies subscription inputs', async (t) => {
  const harness = fixture(t);
  const createdAt = '2026-09-15T00:00:00.000Z';
  for (const status of ['complete', 'prepared', 'running', 'failed']) {
    harness.writeReview(status, review(status, {
      status, createdAt, ...(status === 'complete' ? { completedAt: createdAt } : {}),
      prompts: { secret: 'private prompt' }, source: 'private source', paths: { review: '/untrusted' },
    }));
  }
  const snapshot = () => readdirSync(harness.root, { recursive: true }).sort().map((name) => {
    const path = join(harness.root, name);
    const stat = statSync(path);
    return [name, stat.mtimeMs, stat.isFile() ? readFileSync(path, 'utf8') : null];
  });
  const before = snapshot();
  const { details } = await harness.discover();
  assert.equal(details.truncated, false);
  assert.deepEqual(details.gaps, []);
  assert.deepEqual(details.reviews.map((r) => r.recordedStatus).sort(), ['complete', 'failed', 'prepared', 'running']);
  for (const entry of details.reviews) {
    assert.deepEqual(Object.keys(entry).sort(),
      ['reviewSessionId', 'runId', 'expectedTarget', 'expectedHead', 'recordedStatus', 'createdAt', 'completedAt', 'paths'].sort());
    assert.equal(entry.createdAt, createdAt);
    assert.equal(entry.completedAt, entry.recordedStatus === 'complete' ? createdAt : null);
    assert.equal(entry.paths.review, join(harness.root, entry.reviewSessionId, `${runId}.review.json`));
  }
  assert.deepEqual(snapshot(), before);
  assert.equal(harness.messages.length, 0);
  assert.equal(harness.probe(harness.sessionFile), undefined);
  const { reviewSessionId, runId: discoveredRun, expectedTarget, expectedHead } = details.reviews.find((r) => r.recordedStatus === 'prepared');
  await harness.subscribe({ reviewSessionId, runId: discoveredRun, expectedTarget, expectedHead });
  assert.equal(harness.probe(harness.sessionFile).status, 'waiting');
});

test('lists an absent root without creating it and reports invalid roots', async (t) => {
  const harness = fixture(t);
  assert.deepEqual((await harness.discover()).details.reviews, []);
  assert.throws(() => statSync(harness.root), /ENOENT/);
  writeFileSync(harness.root, 'not a directory');
  const { details } = await harness.discover();
  assert.equal(details.reviews.length, 0);
  assert.equal(details.gaps.length, 1);
});

test('reports malformed, mismatched and unsafe artifacts as gaps', async (t) => {
  const harness = fixture(t);
  const invalid = [
    { sessionId: 'other' }, { runId: 'other' }, { schemaVersion: 2 }, { status: 'unknown' },
    { preflight: { target: '', head: input.expectedHead } }, { preflight: { target: input.expectedTarget } },
    { createdAt: 'not a date' },
  ];
  invalid.forEach((overrides, i) => harness.writeReview(`invalid-${i}`, review(`invalid-${i}`, overrides)));
  const malformed = harness.writeReview('malformed');
  writeFileSync(join(malformed, `${runId}.review.json`), '{private broken JSON');
  const oversized = harness.writeReview('oversized');
  writeFileSync(join(oversized, `${runId}.review.json`), ' '.repeat(200001));
  const valid = harness.writeReview('valid');
  symlinkSync(valid, join(harness.root, 'linked-session'));
  const linked = join(harness.root, 'linked-file');
  mkdirSync(linked);
  symlinkSync(join(valid, `${runId}.review.json`), join(linked, `${runId}.review.json`));
  const { details } = await harness.discover({ limit: 100 });
  assert.deepEqual(details.reviews.map((r) => r.reviewSessionId), ['valid']);
  assert.equal(details.gaps.length, invalid.length + 4);
  assert.equal(details.truncated, false);
  assert.equal(JSON.stringify(details).includes('private broken JSON'), false);
  assert.equal(details.reviews[0].createdAt, null);
});

test('filters exact targets and bounds results and scanned directory entries', async (t) => {
  const harness = fixture(t);
  for (let i = 0; i < 22; i++) harness.writeReview(`session-${i}`);
  assert.equal((await harness.discover()).details.reviews.length, 20);
  assert.equal((await harness.discover({ limit: 2 })).details.reviews.length, 2);
  assert.equal((await harness.discover({ limit: 2 })).details.truncated, true);
  assert.equal((await harness.discover({ target: input.expectedTarget })).details.reviews.length, 20);
  assert.equal((await harness.discover({ target: input.expectedTarget + '/extra' })).details.reviews.length, 0);
  for (const limit of [0, 101, 1.5, NaN]) await assert.rejects(harness.discover({ limit }), /limit/i);
  for (const target of ['', 4, 'x'.repeat(4001)]) await assert.rejects(harness.discover({ target }), /target/i);
  const directory = join(harness.root, 'many-files');
  mkdirSync(directory);
  for (let i = 0; i < 2100; i++) writeFileSync(join(directory, `${i}.unrelated`), '');
  const { details } = await harness.discover({ target: 'no-match' });
  assert.equal(details.truncated, true);
  assert.equal(details.scannedEntries, 2000);
});

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
