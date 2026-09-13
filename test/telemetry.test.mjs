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
import { join, resolve } from 'node:path';
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
const { registerTelemetry } = await createJiti(import.meta.url, {
  moduleCache: false,
  alias,
}).import('../src/telemetry.ts');

function createTelemetryFixture(t, sharedRoot) {
  const storage = sharedRoot || mkdtempSync(join(tmpdir(), 'review-telemetry-'));
  if (!sharedRoot) {
    t.after(() => rmSync(storage, { recursive: true, force: true }));
  }
  const sessionId = 'invoking-session';
  const runId = '00000000-0000-4000-8000-000000000001';
  mkdirSync(join(storage, sessionId), { recursive: true });
  writeFileSync(
    join(storage, sessionId, `${runId}.review.json`),
    JSON.stringify({ sessionId, runId, status: 'prepared' }),
  );

  const handlers = new Map();
  const tools = new Map();
  let now = 1000;
  const ctx = {
    sessionManager: { getSessionId: () => 'child-session' },
    model: { id: 'test-model', provider: 'test' },
    thinkingLevel: 'high',
  };
  registerTelemetry({
    on: (name, fn) => handlers.set(name, fn),
    registerTool: tool => tools.set(tool.name, tool),
  }, storage, () => now);

  return {
    storage,
    ctx,
    sessionId,
    runId,
    setTime: value => {
      now = value;
    },
    emit: (type, event = {}) => handlers.get(type)?.({ type, ...event }, ctx),
    step: (phase, stage = 1, outcome, overrides = {}) => tools.get('agentic_code_review_step')
      .execute('step-call', {
        sessionId,
        runId,
        phase,
        stage,
        outcome,
        ...overrides,
      }, undefined, undefined, ctx),
    records: path => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse),
  };
}

test('records per-step model and overlapping tool timing without logging content', async t => {
  const harness = createTelemetryFixture(t);
  const receipt = await harness.step('start');
  const path = receipt.details.path;

  harness.setTime(1100);
  harness.emit('before_provider_request', { payload: { secret: 'DO_NOT_LOG' } });
  harness.setTime(1200);
  harness.emit('after_provider_response', {
    status: 200,
    headers: { authorization: 'DO_NOT_LOG' },
  });
  harness.setTime(1250);
  harness.emit('message_update', {
    assistantMessageEvent: { type: 'thinking_delta', delta: 'DO_NOT_LOG' },
  });
  harness.setTime(1300);
  harness.emit('message_update', {
    assistantMessageEvent: { type: 'text_delta', delta: 'DO_NOT_LOG' },
  });
  harness.setTime(1500);
  harness.emit('message_end', {
    message: {
      role: 'assistant',
      stopReason: 'toolUse',
      content: ['DO_NOT_LOG'],
      usage: {
        input: 100,
        output: 20,
        cacheRead: 50,
        cacheWrite: 0,
        totalTokens: 170,
        cost: { total: 0.01 },
        secret: 'DO_NOT_LOG',
      },
    },
  });

  harness.setTime(1600);
  harness.emit('tool_execution_start', {
    toolCallId: 'a',
    toolName: 'read',
    args: { secret: 'DO_NOT_LOG' },
  });
  harness.setTime(1620);
  harness.emit('tool_execution_start', {
    toolCallId: 'b',
    toolName: 'bash',
    args: { command: 'DO_NOT_LOG' },
  });
  harness.setTime(1700);
  harness.emit('tool_execution_end', {
    toolCallId: 'b',
    toolName: 'bash',
    isError: true,
    result: 'DO_NOT_LOG',
  });
  harness.setTime(1800);
  harness.emit('tool_execution_end', {
    toolCallId: 'a',
    toolName: 'read',
    isError: false,
  });
  harness.setTime(1900);
  await harness.step('end', 1, 'partial');

  const records = harness.records(path);
  const model = records.find(record => record.kind === 'model_end');
  assert.equal(model.durationMs, 400);
  assert.equal(model.timeToFirstDeltaMs, 150);
  assert.equal(model.timeToFirstTextMs, 200);
  assert.equal(model.outputTokensPerSecond, 50);
  assert.equal(model.usage.output, 20);
  assert.equal(model.usage.totalTokens, 170);
  assert.equal(model.model, 'test/test-model');
  assert.deepEqual(
    records.filter(record => record.kind === 'tool_end')
      .map(record => [record.toolCallId, record.durationMs, record.isError]),
    [['b', 80, true], ['a', 200, false]],
  );
  assert.equal(records.find(record => record.kind === 'step_end').durationMs, 900);
  assert.equal(records.find(record => record.kind === 'step_end').outcome, 'partial');
  assert.equal(records[0].agentSessionId, 'child-session');
  assert.equal(records[0].queueMs, null);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(!readFileSync(path, 'utf8').includes('DO_NOT_LOG'));
});

test('validates step transitions and run identity before writing; cannot rebind a session', async t => {
  const harness = createTelemetryFixture(t);
  await assert.rejects(harness.step('start', 1, undefined, { sessionId: '../escape' }), /identity/i);
  await assert.rejects(harness.step('start', 9), /stage/i);
  await assert.rejects(harness.step('end'), /active/i);

  const { details } = await harness.step('start');
  const before = readFileSync(details.path, 'utf8');

  await assert.rejects(harness.step('start', 2), /active/i);
  await assert.rejects(harness.step('end', 2, 'reviewed'), /active/i);
  await assert.rejects(harness.step('end', 1), /outcome/i);
  await assert.rejects(harness.step('start', 1, undefined, {
    runId: '00000000-0000-4000-8000-000000000000',
  }), /bound/i);
  assert.equal(readFileSync(details.path, 'utf8'), before);

  await harness.step('end', 1, 'reviewed');
  await harness.step('start', 2);
});

test('keeps missing provider metrics null and marks unfinished work at shutdown', async t => {
  const harness = createTelemetryFixture(t);
  const { details } = await harness.step('start', 5);

  harness.emit('message_end', {
    message: {
      role: 'assistant',
      stopReason: 'error',
      usage: { output: 0 },
    },
  });
  harness.emit('session_shutdown');

  const records = harness.records(details.path);
  const model = records.find(record => record.kind === 'model_end');
  assert.equal(model.durationMs, null);
  assert.equal(model.timeToFirstDeltaMs, null);
  assert.equal(model.outputTokensPerSecond, null);
  assert.equal(records.find(record => record.kind === 'step_end').outcome, 'interrupted');
  assert.equal(records.at(-1).kind, 'session_end');
});

test('separates writer sessions and surfaces telemetry storage failures', async t => {
  const harness = createTelemetryFixture(t);
  const first = (await harness.step('start')).details.path;
  const other = createTelemetryFixture(t, harness.storage);
  other.ctx.sessionManager.getSessionId = () => 'another-child';

  const second = (await other.step('start')).details.path;
  assert.notEqual(first, second);

  rmSync(first);
  mkdirSync(first);
  harness.emit('before_provider_request');
  await assert.rejects(harness.step('end', 1, 'unable'), /telemetry.*persist/i);
  assert.equal(readdirSync(first).length, 0);
});
