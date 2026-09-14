import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
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
const runId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const topics = ['structure', 'design', 'framework'];

function createNotes(suffix) {
  return topics.map(topic => ({
    topic,
    content: `${topic} evidence ${suffix}`,
    sourceIds: [`learning-${topic}`],
  }));
}

function createLearningFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'codebase-learning-'));
  const storage = join(dir, 'auto-review');
  const repo = join(dir, 'checkout', 'actual repo');
  mkdirSync(repo, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const input = {
    sessionId: 'session-1',
    runId,
    repository: 'owner/repo',
    notes: createNotes('first'),
  };
  const directory = join(storage, 'codebases', 'actual repo');
  const prepare = (request = input, changes = {}) => {
    const session = join(storage, request.sessionId);
    mkdirSync(session, { recursive: true });
    const path = join(session, `${request.runId}.review.json`);
    const review = {
      schemaVersion: 1,
      sessionId: request.sessionId,
      runId: request.runId,
      cwd: '/invoking/directory',
      status: 'complete',
      completedAt: '2026-01-01T00:00:00.000Z',
      codebases: [{
        repository: request.repository,
        root: repo,
        revision: 'abc123',
      }],
      ...changes,
    };
    writeFileSync(path, JSON.stringify(review));
    return path;
  };
  const register = async () => {
    const { registerCodebaseLearning } = await createJiti(import.meta.url, {
      moduleCache: false,
      alias,
    }).import('../src/codebase.ts');
    const tools = new Map();
    registerCodebaseLearning({ registerTool: tool => tools.set(tool.name, tool) }, storage);

    const save = (request = input, signal) => tools.get('agentic_code_review_save_learning')
      .execute('call', request, signal, undefined, {});
    save.read = (request = { root: repo, repository: input.repository }) => tools.get('agentic_code_review_read_learning')
      .execute('call', request, undefined, undefined, {});
    return save;
  };

  return { dir, storage, repo, input, directory, prepare, register };
}

function readTopicFiles(directory) {
  return Object.fromEntries(readdirSync(directory).sort().map(name => [
    name,
    readFileSync(join(directory, name), 'utf8'),
  ]));
}

test('saves private topic notes for the actual codebase after assessment and makes identical retries harmless', async t => {
  const harness = createLearningFixture(t);
  const reviewPath = harness.prepare();
  const original = readFileSync(reviewPath, 'utf8');
  const save = await harness.register();
  harness.input.notes.push({
    topic: 'testing',
    content: 'Use the isolated contract fixture.',
    sourceIds: ['learning-tests'],
  });

  const result = await save();

  assert.equal(result.details.directory, harness.directory);
  assert.deepEqual(Object.keys(result.details.paths).sort(), ['design', 'framework', 'structure', 'testing']);
  for (const note of harness.input.notes) {
    const path = result.details.paths[note.topic];
    const body = readFileSync(path, 'utf8');
    assert.equal(path, join(harness.directory, `${note.topic}.md`));
    for (const evidence of [note.content, ...note.sourceIds, runId, 'abc123', 'owner/repo']) {
      assert.ok(body.includes(evidence));
    }
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  assert.equal(statSync(harness.directory).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(harness.repo), []);
  assert.equal(readFileSync(reviewPath, 'utf8'), original);

  const before = readTopicFiles(harness.directory);
  await save();
  assert.deepEqual(readTopicFiles(harness.directory), before);
  await assert.rejects(save({ ...harness.input, notes: createNotes('changed') }), /already saved/i);
  assert.deepEqual(readTopicFiles(harness.directory), before);
});

test('independent registrations preserve concurrent finished runs and sessions in the same topic files', async t => {
  const harness = createLearningFixture(t);
  const [left, right] = await Promise.all([harness.register(), harness.register()]);
  const requests = Array.from({ length: 6 }, (_, index) => ({
    ...harness.input,
    sessionId: `session-${index}`,
    runId: `${index}0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11`,
    notes: createNotes(`run-${index}`),
  }));
  for (const request of requests) {
    harness.prepare(request);
  }

  await Promise.all(requests.map((request, index) => (index % 2 ? left : right)(request)));

  for (const topic of topics) {
    const body = readFileSync(join(harness.directory, `${topic}.md`), 'utf8');
    for (const request of requests) {
      const note = request.notes.find(note => note.topic === topic);
      assert.ok(body.includes(request.runId) && body.includes(note.content));
    }
  }
  assert.deepEqual(readdirSync(harness.directory).sort(), topics.map(topic => `${topic}.md`).sort());
});

test('rejects unfinished or mismatched runs, traversal and invalid notes before saving', async t => {
  const harness = createLearningFixture(t);
  const save = await harness.register();
  harness.prepare(harness.input, { status: 'running' });
  await assert.rejects(save(), /finished/i);

  harness.prepare(harness.input, { completedAt: undefined });
  await assert.rejects(save(), /finished/i);
  harness.prepare(harness.input, { sessionId: 'other' });
  await assert.rejects(save(), /match/i);
  harness.prepare();
  const invalidRequests = [
    { ...harness.input, sessionId: '../escape' },
    { ...harness.input, runId: 'bad' },
    { ...harness.input, repository: 'another/repo' },
    { ...harness.input, notes: createNotes('').slice(1) },
    {
      ...harness.input,
      notes: [
        ...createNotes(''),
        { topic: '../escape', content: 'bad', sourceIds: ['source'] },
      ],
    },
    {
      ...harness.input,
      notes: createNotes('').map(note => ({ ...note, sourceIds: [] })),
    },
  ];

  for (const request of invalidRequests) {
    await assert.rejects(save(request));
  }
  await assert.rejects(save(harness.input, AbortSignal.abort()), /abort/i);
  assert.deepEqual(readdirSync(harness.storage), ['session-1']);
});

test('keeps unrelated repositories with the same folder name from sharing notes', async t => {
  const harness = createLearningFixture(t);
  const save = await harness.register();
  harness.prepare();
  harness.input.notes.push({
    topic: 'testing',
    content: 'Original repository tests.',
    sourceIds: ['learning-tests'],
  });
  await save();

  const before = readTopicFiles(harness.directory);
  const otherRoot = join(harness.dir, 'other', 'actual repo');
  mkdirSync(otherRoot, { recursive: true });
  const other = { ...harness.input, repository: 'other/repo' };
  harness.prepare(other, {
    codebases: [{ repository: other.repository, root: otherRoot, revision: 'def456' }],
  });

  await assert.rejects(save(other), /different repository/i);
  assert.deepEqual(readTopicFiles(harness.directory), before);

  // An interrupted save may have published only an optional topic.
  for (const topic of topics) {
    rmSync(join(harness.directory, `${topic}.md`));
  }
  const partial = readTopicFiles(harness.directory);
  await assert.rejects(save({ ...other, notes: createNotes('other repository') }), /different repository/i);
  assert.deepEqual(readTopicFiles(harness.directory), partial);
});

test('replaces the current block per topic, keeps the run history and reads back only the current blocks', async t => {
  const harness = createLearningFixture(t);
  const save = await harness.register();
  harness.prepare();

  const legacy = join(harness.directory, 'structure.md');
  mkdirSync(harness.directory, { recursive: true });
  writeFileSync(legacy, '<!-- repository: "owner/repo" -->\n# structure\n\n<!-- review: old/run 0000 -->\n## 2025-12-31T00:00:00.000Z | 00000000-0000-4000-8000-000000000000\n\nRevision: old123\nReview: /old\nMap: /old.map\nSources: S-old\n\nLegacy append-only entry.\n');

  const empty = await save.read();
  assert.match(empty.content[0].text, /no current block yet; 1 runs in history/);

  const first = {
    ...harness.input,
    notes: topics.map(topic => ({ topic, current: `${topic} current one`, delta: `${topic} delta one`, sourceIds: [`S-${topic}`] })),
  };
  const saved = await save(first);
  assert.equal(saved.details.current.structure.owner, 'session-1/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
  let structure = readFileSync(legacy, 'utf8');
  assert.ok(structure.startsWith('<!-- repository: "owner/repo" -->\n# structure\n\n<!-- current: session-1/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11 abc123 '));
  assert.ok(structure.includes('structure current one\n<!-- /current -->\n'));
  assert.ok(structure.includes('Legacy append-only entry.'), 'the legacy history survives');
  assert.ok(structure.includes('structure delta one'));

  const second = {
    ...first,
    sessionId: 'session-2',
    runId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    notes: [
      ...topics.map(topic => ({ topic, current: `${topic} current two`, delta: `${topic} delta two`, sourceIds: [`S-${topic}`] })),
      { topic: 'decisions', current: 'app/models/shop.rb#frozen? — frozen shops skip billing — settled by author reply — run two — accepted', delta: 'First decision recorded.', sourceIds: ['F-1'] },
    ],
  };
  harness.prepare(second, { revision: 'def456', codebases: [{ repository: second.repository, root: harness.repo, revision: 'def456' }] });
  await save(second);
  structure = readFileSync(legacy, 'utf8');
  assert.ok(structure.includes('<!-- current: session-2/b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11 def456 '));
  assert.ok(!structure.includes('structure current one'), 'the previous current block is replaced');
  assert.ok(structure.includes('structure delta one') && structure.includes('structure delta two'), 'history keeps both runs');
  assert.equal((structure.match(/<!-- current: /g) ?? []).length, 1);

  const before = readTopicFiles(harness.directory);
  await save(second);
  assert.deepEqual(readTopicFiles(harness.directory), before, 'an identical retry changes nothing');
  await assert.rejects(save({ ...second, notes: second.notes.map(note => ({ ...note, current: `${note.current} edited` })) }), /already saved/i);
  await save({ ...second, notes: second.notes.map(({ current, ...note }) => note) });
  assert.deepEqual(readTopicFiles(harness.directory), before, 'a retry without current blocks keeps the saved ones');

  const read = await save.read();
  assert.match(read.content[0].text, /## decisions \(current from session-2\/b0eebc99[^)]*def456; 1 runs in history\)\n\napp\/models\/shop\.rb#frozen\?/);
  assert.match(read.content[0].text, /## structure \(current from session-2[^)]*; 3 runs in history\)\n\nstructure current two\n/);
  assert.ok(!read.content[0].text.includes('delta'), 'history bodies stay out of the read');
  const summary = read.details.topics.find(item => item.topic === 'structure');
  assert.equal(summary.runs, 3);
  assert.equal(summary.latestRun.run, 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
  assert.equal(summary.current.revision, 'def456');

  const other = await save.read({ root: harness.repo, repository: 'someone/else' });
  assert.match(other.content[0].text, /holds notes for another repository/);
  assert.deepEqual(other.details.topics, []);
});

test('fails closed on a held lock, linked topic or storage inside the reviewed tree', async t => {
  const harness = createLearningFixture(t);
  const save = await harness.register();
  harness.prepare();
  mkdirSync(harness.directory, { recursive: true });

  const lock = join(harness.directory, '.write.lock');
  writeFileSync(lock, 'another writer');
  await assert.rejects(save(), /lock/i);
  assert.equal(readFileSync(lock, 'utf8'), 'another writer');
  rmSync(lock);

  const unrelated = join(harness.dir, 'unrelated');
  writeFileSync(unrelated, 'keep');
  symlinkSync(unrelated, join(harness.directory, 'structure.md'));
  await assert.rejects(save(), /regular file/i);
  assert.equal(readFileSync(unrelated, 'utf8'), 'keep');
  rmSync(join(harness.directory, 'structure.md'));

  harness.prepare(harness.input, {
    codebases: [{ repository: harness.input.repository, root: harness.dir, revision: 'abc123' }],
  });
  await assert.rejects(save(), /outside/i);
  assert.deepEqual(readdirSync(harness.directory), []);
});
