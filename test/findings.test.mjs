import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const load = () => createJiti(import.meta.url, { moduleCache: false, alias }).import('../src/findings.ts');
const runId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

function createFinding(kind = 'bug') {
  const finding = {
    kind,
    sourceIds: ['source-1'],
    requirementIds: ['requirement-1'],
    unitIds: ['unit-1'],
    repository: 'owner/repo',
    revision: 'abc123',
    location: {
      path: 'src/a.ts',
      symbol: 'work',
      startLine: 3,
      endLine: 4,
    },
    title: 'Fails safely',
    impact: 'Users lose their work.',
    suggestedFix: 'Guard the write.',
    humanReadable: 'A failed write drops the previous work. Keep it until the replacement succeeds.',
    rating: kind === 'bug' ? 'E' : 'B',
  };
  if (kind !== 'bug') return finding;

  return {
    ...finding,
    expected: 'Keep work.',
    actual: 'Drops work.',
    origin: 'introduced',
    blocks: true,
    verification: 'Add a focused regression.',
    evidence: [{
      source: 'test/a.ts:3',
      detail: 'Reproduces the loss.',
    }],
  };
}

function createFindingsFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'findings-'));
  const storage = join(dir, 'auto-review');
  const sessionId = 'session-1';
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const path = id => join(storage, sessionId, `${id}.bugs.json`);
  const prepare = (id = runId, status = 'prepared') => {
    mkdirSync(join(storage, sessionId), { recursive: true });
    const envelope = {
      schemaVersion: 1,
      presentationVersion: 1,
      runId: id,
      sessionId,
      cwd: '/private/project',
      context: 'request',
      createdAt: '2026-01-01T00:00:00.000Z',
      status,
      bugs: [],
    };
    writeFileSync(path(id), JSON.stringify(envelope) + '\n', { mode: 0o600 });
  };
  const register = async (ctx = {}) => {
    const { registerFindings } = await load();
    const tools = new Map();
    registerFindings({ registerTool: tool => tools.set(tool.name, tool) }, storage);

    const definition = tools.get('agentic_code_review_append_finding');
    const submit = (input, signal) => definition.execute('call', input, signal, undefined, ctx);
    submit.parameters = definition.parameters;
    return submit;
  };

  return { path, prepare, register, sessionId };
}

test('records confirmed bugs separately from nonblocking optional findings', async t => {
  const harness = createFindingsFixture(t);
  harness.prepare();
  const submit = await harness.register();

  const bug = await submit({ sessionId: harness.sessionId, runId, finding: createFinding() });
  await submit({ sessionId: harness.sessionId, runId, finding: createFinding('fix') });
  const saved = readJson(harness.path(runId));

  assert.equal(bug.details.artifactPath, harness.path(runId));
  assert.match(bug.details.id, /^finding-/);
  assert.equal(statSync(harness.path(runId)).mode & 0o777, 0o600);
  assert.equal(saved.bugs.length, 1);
  assert.equal(saved.bugs[0].status, 'open');
  assert.equal(saved.bugs[0].blocks, true);
  assert.equal(saved.findings.length, 1);
  assert.equal(saved.findings[0].kind, 'fix');
  assert.equal(saved.findings[0].blocks, false);
  assert.equal(saved.context, 'request');
  assert.equal(saved.cwd, '/private/project');
  assert.equal(saved.createdAt, '2026-01-01T00:00:00.000Z');
});

test('records author questions and the taste lens that produced a finding', async t => {
  const harness = createFindingsFixture(t);
  harness.prepare();
  const submit = await harness.register();

  await submit({
    sessionId: harness.sessionId,
    runId,
    finding: { ...createFinding('question'), lens: 'failure_paths', rating: 'C' },
  });
  await submit({ sessionId: harness.sessionId, runId, finding: { ...createFinding(), lens: 'naming' } });
  const saved = readJson(harness.path(runId));

  assert.equal(saved.findings.length, 1);
  assert.equal(saved.findings[0].kind, 'question');
  assert.equal(saved.findings[0].blocks, false);
  assert.equal(saved.findings[0].lens, 'failure_paths');
  assert.equal(saved.bugs.length, 1);
  assert.equal(saved.bugs[0].lens, 'naming');

  const before = readFileSync(harness.path(runId), 'utf8');
  await assert.rejects(submit({
    sessionId: harness.sessionId,
    runId,
    finding: { ...createFinding('nit'), lens: 'vibes' },
  }), /lens/i);
  assert.equal(readFileSync(harness.path(runId), 'utf8'), before);

  const lens = submit.parameters.properties.finding.properties.lens;
  assert.ok(lens.enum.includes('ownership'));
  assert.ok(lens.enum.includes('tests_honesty'));
});

test('separate registrations share Pi queue and preserve concurrent submissions and other runs', async t => {
  const harness = createFindingsFixture(t);
  const otherRunId = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  harness.prepare();
  harness.prepare(otherRunId);
  const [left, right] = await Promise.all([harness.register(), harness.register()]);

  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => {
    const submit = index % 2 ? left : right;
    return submit({
      sessionId: harness.sessionId,
      runId,
      finding: {
        ...createFinding(index % 3 ? 'nit' : 'bug'),
        title: `Finding ${index}`,
      },
    });
  }));

  const saved = readJson(harness.path(runId));
  const ids = [...saved.bugs, ...saved.findings].map(finding => finding.id);
  assert.equal(ids.length, 12);
  assert.equal(new Set(ids).size, 12);
  assert.deepEqual(new Set(ids), new Set(results.map(result => result.details.id)));
  assert.deepEqual(readJson(harness.path(otherRunId)).bugs, []);
});

test('rejects malformed, sealed, mismatched, and aborted submissions without changing bytes', async t => {
  const harness = createFindingsFixture(t);
  harness.prepare();
  const submit = await harness.register();
  const path = harness.path(runId);
  const original = readFileSync(path, 'utf8');

  await assert.rejects(submit({ sessionId: '../escape', runId, finding: createFinding() }), /session/i);
  await assert.rejects(submit({ sessionId: harness.sessionId, runId: 'bad', finding: createFinding() }), /run/i);
  await assert.rejects(submit({
    sessionId: harness.sessionId,
    runId,
    finding: { ...createFinding(), title: '' },
  }), /title/i);
  await assert.rejects(submit({
    sessionId: harness.sessionId,
    runId,
    finding: createFinding(),
  }, AbortSignal.abort()), /abort/i);
  assert.equal(readFileSync(path, 'utf8'), original);

  harness.prepare(runId, 'complete');
  const sealed = readFileSync(path, 'utf8');
  await assert.rejects(submit({ sessionId: harness.sessionId, runId, finding: createFinding() }), /sealed/i);
  assert.equal(readFileSync(path, 'utf8'), sealed);

  const mismatch = JSON.stringify({ ...JSON.parse(original), sessionId: 'other-session' });
  writeFileSync(path, mismatch);
  await assert.rejects(submit({ sessionId: harness.sessionId, runId, finding: createFinding() }), /match/i);
  assert.equal(readFileSync(path, 'utf8'), mismatch);
});

test('rejects invalid confirmed-bug fields without changing artifact bytes', async t => {
  const harness = createFindingsFixture(t);
  harness.prepare();
  const submit = await harness.register();
  const path = harness.path(runId);
  const original = readFileSync(path, 'utf8');

  for (const [field, value, error] of [
    ['expected', '', /expected behavior/],
    ['actual', '', /actual behavior/],
    ['origin', 'unknown', /origin/],
    ['blocks', 'yes', /blocks flag/],
  ]) {
    await assert.rejects(submit({
      sessionId: harness.sessionId,
      runId,
      finding: { ...createFinding(), [field]: value },
    }), error);
    assert.equal(readFileSync(path, 'utf8'), original);
  }
});

test('offers a portable string enum and persists only declared location fields', async t => {
  const harness = createFindingsFixture(t);
  harness.prepare();
  const submit = await harness.register();
  const kind = submit.parameters.properties.finding.properties.kind;
  assert.equal(kind.type, 'string');
  assert.deepEqual(kind.enum, ['bug', 'fix', 'nit', 'question']);

  const finding = createFinding('nit');
  await submit({
    sessionId: harness.sessionId,
    runId,
    finding: {
      ...finding,
      location: { ...finding.location, unrelated: 'not review evidence' },
    },
  });

  assert.deepEqual(readJson(harness.path(runId)).findings[0].location, finding.location);
});

test('persists human summaries and ratings with runtime provenance, never caller attribution', async t => {
  const harness = createFindingsFixture(t);
  harness.prepare();
  const ctx = {
    model: { provider: 'provider', id: 'model' },
    thinkingLevel: 'high',
  };
  const submit = await harness.register(ctx);
  const finding = createFinding();

  const result = await submit({
    sessionId: harness.sessionId,
    runId,
    finding: {
      ...finding,
      reviewer: { model: 'forged', thinkingLevel: 'max' },
    },
  });

  const saved = readJson(harness.path(runId)).bugs[0];
  assert.equal(saved.humanReadable, finding.humanReadable);
  assert.equal(saved.rating, finding.rating);
  assert.deepEqual(saved.reviewer, { model: 'provider/model', thinkingLevel: 'high' });
  assert.deepEqual(result.details.reviewer, saved.reviewer);

  const anonymous = await harness.register();
  await anonymous({
    sessionId: harness.sessionId,
    runId,
    finding: { ...createFinding('nit'), rating: 'C', blocks: true },
  });

  const nit = readJson(harness.path(runId)).findings[0];
  assert.deepEqual(nit.reviewer, { model: null, thinkingLevel: null });
  assert.equal(nit.blocks, false);
  const properties = submit.parameters.properties.finding.properties;
  assert.equal(properties.rating.type, 'string');
  assert.deepEqual(properties.rating.enum, ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.equal(properties.humanReadable.maxLength, 400);
});

test('new runs require bounded summaries and A–F ratings before any artifact mutation', async t => {
  const harness = createFindingsFixture(t);
  harness.prepare();
  const submit = await harness.register();
  const path = harness.path(runId);
  const original = readFileSync(path, 'utf8');
  const invalidFields = [
    { humanReadable: undefined, rating: undefined },
    { humanReadable: '' },
    { humanReadable: 'x'.repeat(401) },
    { humanReadable: undefined },
    { rating: undefined },
    { rating: 'C3' },
    { rating: 'a' },
    { rating: 'G' },
  ];

  for (const changes of invalidFields) {
    await assert.rejects(submit({
      sessionId: harness.sessionId,
      runId,
      finding: { ...createFinding(), ...changes },
    }), /human|rating|presentation/i);
    assert.equal(readFileSync(path, 'utf8'), original);
  }
});

test('legacy runs accept old submissions and retain history without invented summaries or ratings', async t => {
  const harness = createFindingsFixture(t);
  harness.prepare();
  const path = harness.path(runId);
  const legacy = readJson(path);
  delete legacy.presentationVersion;
  const { humanReadable, rating, ...oldFinding } = createFinding();
  const historical = { ...oldFinding, id: 'historical-id', status: 'open' };
  legacy.bugs.push(historical);
  writeFileSync(path, JSON.stringify(legacy));
  const submit = await harness.register();

  await submit({ sessionId: harness.sessionId, runId, finding: oldFinding });
  await submit({ sessionId: harness.sessionId, runId, finding: createFinding() });

  const saved = readJson(path);
  assert.deepEqual(saved.bugs[0], historical);
  assert.equal(saved.bugs[1].humanReadable, undefined);
  assert.equal(saved.bugs[1].rating, undefined);
  assert.equal(saved.bugs[2].humanReadable, humanReadable);
  assert.equal(saved.bugs[2].rating, rating);
});
