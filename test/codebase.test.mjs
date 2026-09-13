import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const piRoot = process.env.PI_PACKAGE_ROOT || resolve(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), '../..');
const require = createRequire(join(piRoot, 'package.json'));
const { createJiti } = require('jiti'), host = createJiti(join(piRoot, 'package.json'));
const alias = Object.fromEntries(['@earendil-works/pi-coding-agent', 'typebox'].map(name => [name, fileURLToPath(host.esmResolve(name))]));
const runId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const topics = ['structure', 'design', 'framework'];
const notes = suffix => topics.map(topic => ({ topic, content: `${topic} evidence ${suffix}`, sourceIds: [`learning-${topic}`] }));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'codebase-learning-')), storage = join(dir, 'auto-review');
  const repo = join(dir, 'checkout', 'actual repo'); mkdirSync(repo, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = { sessionId: 'session-1', runId, repository: 'owner/repo', notes: notes('first') };
  const directory = join(storage, 'codebases', 'actual repo');
  const prepare = (request = input, changes = {}) => {
    const session = join(storage, request.sessionId); mkdirSync(session, { recursive: true });
    const path = join(session, `${request.runId}.review.json`);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, sessionId: request.sessionId, runId: request.runId,
      cwd: '/invoking/directory', status: 'complete', completedAt: '2026-01-01T00:00:00.000Z',
      codebases: [{ repository: request.repository, root: repo, revision: 'abc123' }], ...changes }));
    return path;
  };
  const register = async () => {
    const { registerCodebaseLearning } = await createJiti(import.meta.url, { moduleCache: false, alias }).import('../src/codebase.ts');
    const tools = new Map(); registerCodebaseLearning({ registerTool: tool => tools.set(tool.name, tool) }, storage);
    return (request = input, signal) => tools.get('agentic_code_review_save_learning').execute('call', request, signal, undefined, {});
  };
  return { dir, storage, repo, input, directory, prepare, register };
}
const snapshot = directory => Object.fromEntries(readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name), 'utf8')]));

test('saves private topic notes for the actual codebase after assessment and makes identical retries harmless', async t => {
  const h = fixture(t), reviewPath = h.prepare(), original = readFileSync(reviewPath, 'utf8'), save = await h.register();
  h.input.notes.push({ topic: 'testing', content: 'Use the isolated contract fixture.', sourceIds: ['learning-tests'] });
  const result = await save();
  assert.equal(result.details.directory, h.directory);
  assert.deepEqual(Object.keys(result.details.paths).sort(), ['design', 'framework', 'structure', 'testing']);
  for (const note of h.input.notes) {
    const path = result.details.paths[note.topic], body = readFileSync(path, 'utf8');
    assert.equal(path, join(h.directory, `${note.topic}.md`));
    for (const evidence of [note.content, ...note.sourceIds, runId, 'abc123', 'owner/repo']) assert.ok(body.includes(evidence));
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  assert.equal(statSync(h.directory).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(h.repo), []); assert.equal(readFileSync(reviewPath, 'utf8'), original);
  const before = snapshot(h.directory); await save(); assert.deepEqual(snapshot(h.directory), before);
  await assert.rejects(save({ ...h.input, notes: notes('changed') }), /already saved/i);
  assert.deepEqual(snapshot(h.directory), before);
});

test('independent registrations preserve concurrent finished runs and sessions in the same topic files', async t => {
  const h = fixture(t), [left, right] = await Promise.all([h.register(), h.register()]);
  const requests = Array.from({ length: 6 }, (_, i) => ({ ...h.input, sessionId: `session-${i}`, runId: `${i}0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11`, notes: notes(`run-${i}`) }));
  for (const request of requests) h.prepare(request);
  await Promise.all(requests.map((request, i) => (i % 2 ? left : right)(request)));
  for (const topic of topics) {
    const body = readFileSync(join(h.directory, `${topic}.md`), 'utf8');
    for (const request of requests) assert.ok(body.includes(request.runId) && body.includes(request.notes.find(note => note.topic === topic).content));
  }
  assert.deepEqual(readdirSync(h.directory).sort(), topics.map(topic => `${topic}.md`).sort());
});

test('rejects unfinished or mismatched runs, traversal and invalid notes before saving', async t => {
  const h = fixture(t), save = await h.register(); h.prepare(h.input, { status: 'running' });
  await assert.rejects(save(), /finished/i);
  h.prepare(h.input, { completedAt: undefined }); await assert.rejects(save(), /finished/i);
  h.prepare(h.input, { sessionId: 'other' }); await assert.rejects(save(), /match/i);
  h.prepare();
  for (const request of [{ ...h.input, sessionId: '../escape' }, { ...h.input, runId: 'bad' },
    { ...h.input, repository: 'another/repo' }, { ...h.input, notes: notes('').slice(1) },
    { ...h.input, notes: [...notes(''), { topic: '../escape', content: 'bad', sourceIds: ['source'] }] },
    { ...h.input, notes: notes('').map(note => ({ ...note, sourceIds: [] })) }]) await assert.rejects(save(request));
  await assert.rejects(save(h.input, AbortSignal.abort()), /abort/i);
  assert.deepEqual(readdirSync(h.storage), ['session-1']);
});

test('keeps unrelated repositories with the same folder name from sharing notes', async t => {
  const h = fixture(t), save = await h.register(); h.prepare();
  h.input.notes.push({ topic: 'testing', content: 'Original repository tests.', sourceIds: ['learning-tests'] });
  await save();
  const before = snapshot(h.directory), otherRoot = join(h.dir, 'other', 'actual repo'); mkdirSync(otherRoot, { recursive: true });
  const other = { ...h.input, repository: 'other/repo' };
  h.prepare(other, { codebases: [{ repository: other.repository, root: otherRoot, revision: 'def456' }] });
  await assert.rejects(save(other), /different repository/i);
  assert.deepEqual(snapshot(h.directory), before);
  // An interrupted save may have published only an optional topic.
  for (const topic of topics) rmSync(join(h.directory, `${topic}.md`));
  const partial = snapshot(h.directory);
  await assert.rejects(save({ ...other, notes: notes('other repository') }), /different repository/i);
  assert.deepEqual(snapshot(h.directory), partial);
});

test('fails closed on a held lock, linked topic or storage inside the reviewed tree', async t => {
  const h = fixture(t), save = await h.register(); h.prepare(); mkdirSync(h.directory, { recursive: true });
  const lock = join(h.directory, '.write.lock'); writeFileSync(lock, 'another writer');
  await assert.rejects(save(), /lock/i); assert.equal(readFileSync(lock, 'utf8'), 'another writer'); rmSync(lock);
  const unrelated = join(h.dir, 'unrelated'); writeFileSync(unrelated, 'keep');
  symlinkSync(unrelated, join(h.directory, 'structure.md'));
  await assert.rejects(save(), /regular file/i); assert.equal(readFileSync(unrelated, 'utf8'), 'keep');
  rmSync(join(h.directory, 'structure.md'));
  h.prepare(h.input, { codebases: [{ repository: h.input.repository, root: h.dir, revision: 'abc123' }] });
  await assert.rejects(save(), /outside/i); assert.deepEqual(readdirSync(h.directory), []);
});
