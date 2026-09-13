import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = process.env.PI_PACKAGE_ROOT || resolve(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), '../..');
const require = createRequire(join(root, 'package.json'));
const { createJiti } = require('jiti'), host = createJiti(join(root, 'package.json'));
const alias = Object.fromEntries(['@earendil-works/pi-coding-agent', 'typebox'].map(name => [name, fileURLToPath(host.esmResolve(name))]));
const load = () => createJiti(import.meta.url, { moduleCache: false, alias }).import('../src/findings.ts');
const runId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const record = (kind = 'bug') => ({ kind, sourceIds: ['source-1'], requirementIds: ['requirement-1'], unitIds: ['unit-1'], repository: 'owner/repo', revision: 'abc123', location: { path: 'src/a.ts', symbol: 'work', startLine: 3, endLine: 4 }, title: 'Fails safely', impact: 'Users lose their work.', suggestedFix: 'Guard the write.', humanReadable: 'A failed write drops the previous work. Keep it until the replacement succeeds.', rating: kind === 'bug' ? 'E' : 'B', ...(kind === 'bug' ? { expected: 'Keep work.', actual: 'Drops work.', origin: 'introduced', blocks: true, verification: 'Add a focused regression.', evidence: [{ source: 'test/a.ts:3', detail: 'Reproduces the loss.' }] } : {}) });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'findings-')), storage = join(dir, 'auto-review'), sessionId = 'session-1';
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = id => join(storage, sessionId, `${id}.bugs.json`), prepare = (id = runId, status = 'prepared') => {
    mkdirSync(join(storage, sessionId), { recursive: true });
    writeFileSync(path(id), JSON.stringify({ schemaVersion: 1, presentationVersion: 1, runId: id, sessionId, cwd: '/private/project', context: 'request', createdAt: '2026-01-01T00:00:00.000Z', status, bugs: [] }) + '\n', { mode: 0o600 });
  };
  const register = async (ctx = {}) => {
    const { registerFindings } = await load(), tools = new Map();
    registerFindings({ registerTool: tool => tools.set(tool.name, tool) }, storage);
    const definition = tools.get('agentic_code_review_append_finding');
    const submit = (input, signal) => definition.execute('call', input, signal, undefined, ctx);
    submit.parameters = definition.parameters;
    return submit;
  };
  return { path, prepare, register, sessionId };
}
const json = path => JSON.parse(readFileSync(path, 'utf8'));

test('records confirmed bugs separately from nonblocking optional findings', async t => {
  const h = fixture(t); h.prepare(); const submit = await h.register();
  const bug = await submit({ sessionId: h.sessionId, runId, finding: record() });
  const fix = await submit({ sessionId: h.sessionId, runId, finding: record('fix') });
  const saved = json(h.path(runId));
  assert.equal(bug.details.artifactPath, h.path(runId)); assert.match(bug.details.id, /^finding-/); assert.equal(statSync(h.path(runId)).mode & 0o777, 0o600);
  assert.equal(saved.bugs.length, 1); assert.equal(saved.bugs[0].status, 'open'); assert.equal(saved.bugs[0].blocks, true);
  assert.equal(saved.findings.length, 1); assert.equal(saved.findings[0].kind, 'fix'); assert.equal(saved.findings[0].blocks, false);
  assert.equal(saved.context, 'request'); assert.equal(saved.cwd, '/private/project'); assert.equal(saved.createdAt, '2026-01-01T00:00:00.000Z');
});

test('separate registrations share Pi queue and preserve concurrent submissions and other runs', async t => {
  const h = fixture(t), other = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'; h.prepare(); h.prepare(other);
  const [left, right] = await Promise.all([h.register(), h.register()]);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? left : right)({ sessionId: h.sessionId, runId, finding: { ...record(i % 3 ? 'nit' : 'bug'), title: `Finding ${i}` } })));
  const saved = json(h.path(runId)), ids = [...saved.bugs, ...saved.findings].map(item => item.id);
  assert.equal(ids.length, 12); assert.equal(new Set(ids).size, 12); assert.deepEqual(new Set(ids), new Set(results.map(result => result.details.id)));
  assert.deepEqual(json(h.path(other)).bugs, []);
});

test('rejects malformed, sealed, mismatched, and aborted submissions without changing bytes', async t => {
  const h = fixture(t); h.prepare(); const submit = await h.register(), path = h.path(runId), original = readFileSync(path, 'utf8');
  await assert.rejects(submit({ sessionId: '../escape', runId, finding: record() }), /session/i);
  await assert.rejects(submit({ sessionId: h.sessionId, runId: 'bad', finding: record() }), /run/i);
  await assert.rejects(submit({ sessionId: h.sessionId, runId, finding: { ...record(), title: '' } }), /title/i);
  await assert.rejects(submit({ sessionId: h.sessionId, runId, finding: record() }, AbortSignal.abort()), /abort/i);
  assert.equal(readFileSync(path, 'utf8'), original);
  h.prepare(runId, 'complete'); const sealed = readFileSync(path, 'utf8');
  await assert.rejects(submit({ sessionId: h.sessionId, runId, finding: record() }), /sealed/i);
  assert.equal(readFileSync(path, 'utf8'), sealed);
  const mismatch = JSON.stringify({ ...JSON.parse(original), sessionId: 'other-session' });
  writeFileSync(path, mismatch);
  await assert.rejects(submit({ sessionId: h.sessionId, runId, finding: record() }), /match/i);
  assert.equal(readFileSync(path, 'utf8'), mismatch);
});

test('offers a portable string enum and persists only declared location fields', async t => {
  const h = fixture(t); h.prepare(); const submit = await h.register();
  const kind = submit.parameters.properties.finding.properties.kind;
  assert.equal(kind.type, 'string');
  assert.deepEqual(kind.enum, ['bug', 'fix', 'nit']);
  const finding = record('nit');
  await submit({ sessionId: h.sessionId, runId, finding: { ...finding, location: { ...finding.location, unrelated: 'not review evidence' } } });
  assert.deepEqual(json(h.path(runId)).findings[0].location, finding.location);
});

test('persists human summaries and ratings with runtime provenance, never caller attribution', async t => {
  const h = fixture(t); h.prepare();
  const ctx = { model: { provider: 'provider', id: 'model' }, thinkingLevel: 'high' };
  const submit = await h.register(ctx), finding = record();
  const result = await submit({ sessionId: h.sessionId, runId, finding: { ...finding, reviewer: { model: 'forged', thinkingLevel: 'max' } } });
  const saved = json(h.path(runId)).bugs[0];
  assert.equal(saved.humanReadable, finding.humanReadable); assert.equal(saved.rating, finding.rating);
  assert.deepEqual(saved.reviewer, { model: 'provider/model', thinkingLevel: 'high' });
  assert.deepEqual(result.details.reviewer, saved.reviewer);
  const anonymous = await h.register();
  await anonymous({ sessionId: h.sessionId, runId, finding: { ...record('nit'), rating: 'C', blocks: true } });
  const nit = json(h.path(runId)).findings[0];
  assert.deepEqual(nit.reviewer, { model: null, thinkingLevel: null }); assert.equal(nit.blocks, false);
  const properties = submit.parameters.properties.finding.properties;
  assert.equal(properties.rating.type, 'string'); assert.deepEqual(properties.rating.enum, ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.equal(properties.humanReadable.maxLength, 400);
});

test('new runs require bounded summaries and A–F ratings before any artifact mutation', async t => {
  const h = fixture(t); h.prepare(); const submit = await h.register(), path = h.path(runId), original = readFileSync(path, 'utf8');
  for (const changes of [{ humanReadable: undefined, rating: undefined }, { humanReadable: '' }, { humanReadable: 'x'.repeat(401) }, { humanReadable: undefined }, { rating: undefined }, { rating: 'C3' }, { rating: 'a' }, { rating: 'G' }]) {
    await assert.rejects(submit({ sessionId: h.sessionId, runId, finding: { ...record(), ...changes } }), /human|rating|presentation/i);
    assert.equal(readFileSync(path, 'utf8'), original);
  }
});

test('legacy runs accept old submissions and retain history without invented summaries or ratings', async t => {
  const h = fixture(t); h.prepare(); const path = h.path(runId), legacy = json(path);
  delete legacy.presentationVersion;
  const { humanReadable, rating, ...oldFinding } = record();
  const historical = { ...oldFinding, id: 'historical-id', status: 'open' };
  legacy.bugs.push(historical); writeFileSync(path, JSON.stringify(legacy));
  const submit = await h.register();
  await submit({ sessionId: h.sessionId, runId, finding: oldFinding });
  await submit({ sessionId: h.sessionId, runId, finding: record() });
  const saved = json(path);
  assert.deepEqual(saved.bugs[0], historical);
  assert.equal(saved.bugs[1].humanReadable, undefined); assert.equal(saved.bugs[1].rating, undefined);
  assert.equal(saved.bugs[2].humanReadable, humanReadable); assert.equal(saved.bugs[2].rating, rating);
});
