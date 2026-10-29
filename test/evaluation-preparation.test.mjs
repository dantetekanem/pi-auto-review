import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareBenchmark } from '../evaluation/prepare-benchmark.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const repository = fileURLToPath(new URL('..', import.meta.url));
const publicCorpus = JSON.parse(await readFile(new URL('../evaluation/corpus/public.json', import.meta.url)));

async function fixture(t, change = value => value) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'review-benchmark-inputs-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const corpus = change({ ...publicCorpus, cases: [{ ...publicCorpus.cases[1], scope: ['src/runtime.ts'] }] });
  const path = join(root, 'public.json');
  const bytes = JSON.stringify(corpus);
  await writeFile(path, bytes);
  await writeFile(join(root, 'author.json'), JSON.stringify({ privateDiagnosis: 'not reviewer input' }));
  return {
    root,
    corpus,
    directory: join(root, 'prepared'),
    options: {
      corpus: { path, sha256: sha256(bytes) },
      repositories: { [corpus.cases[0].repository]: repository },
    },
  };
}

test('pins actual historical source and public criteria without copying author-side records', async t => {
  const f = await fixture(t);
  const prepared = await prepareBenchmark(f.directory, f.options);

  const manifestBytes = await readFile(prepared.path);
  assert.equal(sha256(manifestBytes), prepared.sha256);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.publicCorpusSha256, f.options.corpus.sha256);
  assert.equal(manifest.phase, 'prepared-inputs');
  assert.equal(manifest.modelCalls, 0);
  assert.equal(manifest.packets.length, 1);

  const reference = manifest.packets[0];
  const packetBytes = await readFile(join(f.directory, reference.path));
  assert.equal(sha256(packetBytes), reference.sha256);
  assert.equal(packetBytes.length, reference.bytes);
  const packet = JSON.parse(packetBytes);
  assert.deepEqual(Object.keys(packet).sort(), ['case', 'diff', 'schemaVersion', 'snapshots']);
  assert.deepEqual(packet.case, f.corpus.cases[0]);
  assert.ok(packet.diff.includes('src/runtime.ts'));

  for (const side of ['base', 'head']) {
    const snapshot = packet.snapshots[side];
    assert.equal(snapshot.revision, packet.case[side]);
    assert.deepEqual(snapshot.files.map(file => file.path), ['src/runtime.ts']);
    for (const file of snapshot.files) {
      assert.equal(sha256(file.text), file.sha256);
      assert.equal(file.text, await readFile(join(f.directory, 'dispatch', side, 'source', file.path), 'utf8'));
    }
  }
  assert.deepEqual((await readdir(f.directory)).sort(), ['dispatch', 'dispatch.json', 'empty-dependencies.json', 'manifest.json']);
  await assert.rejects(prepareBenchmark(f.directory, f.options), /EEXIST/);
  assert.equal(sha256(await readFile(prepared.path)), prepared.sha256);
});

test('rejects corpus drift and private fields before creating reviewer output', async t => {
  const drift = await fixture(t);
  await writeFile(drift.options.corpus.path, '{}');
  await assert.rejects(prepareBenchmark(drift.directory, drift.options), /digest/);
  await assert.rejects(readdir(drift.directory), /ENOENT/);

  for (const extra of [{ knownDefects: ['private'] }, { repair: 'a'.repeat(40) }]) {
    const f = await fixture(t, value => ({ ...value, cases: [{ ...value.cases[0], ...extra }] }));
    await assert.rejects(prepareBenchmark(f.directory, f.options), /public|fields/i);
    await assert.rejects(readdir(f.directory), /ENOENT/);
  }
});

test('rejects unapproved repositories, unsafe paths and cancellation without preparing inputs', async t => {
  const absent = await fixture(t);
  await assert.rejects(prepareBenchmark(absent.directory, { ...absent.options, repositories: {} }), /repository/i);
  const unsafe = await fixture(t, value => ({ ...value, cases: [{ ...value.cases[0], scope: ['../author.json'] }] }));
  await assert.rejects(prepareBenchmark(unsafe.directory, unsafe.options), /scope|path/i);
  const cancelled = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareBenchmark(cancelled.directory, cancelled.options, controller.signal));
  for (const f of [absent, unsafe, cancelled]) {
    await assert.rejects(readdir(f.directory), /ENOENT/);
  }
});
