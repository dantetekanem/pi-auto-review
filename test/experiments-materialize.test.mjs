import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, symlink, stat, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { materializeRestrictedInputs, readPinnedFile, parseRestrictedTree } from '../src/experiments-materialize.ts';

const repository = resolve('.');
const revisions = ['87bc85e61121be57051b8b341cb3653eb0d26270', 'c3bca5ff8623dedb11d956cc8f2199f2aac7b766'];
const paths = ['package.json', 'src/findings.ts', 'prompts/finding.md'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: repository, env: { PATH: '/usr/bin:/bin', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: '' } });
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'materialize-'));
  const dependency = join(root, 'module.js');
  await writeFile(dependency, 'export const value = 1;');
  const manifest = join(root, 'manifest.json');
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, files: [{ path: dependency, destination: 'node_modules/sample/module.js', sha256: sha(await readFile(dependency)) }] }));
  await writeFile(manifest, bytes);
  return { root, dependency, manifest, request: revision => ({ source: { repository, revision, paths }, dependencies: { path: manifest, sha256: sha(bytes) } }) };
}

test('stages exact selected Git objects from both real commits, with pinned installed dependency bytes', async t => {
  const f = await fixture();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(f.root, { recursive: true, force: true })); });
  for (const [index, revision] of revisions.entries()) {
    const bundle = join(f.root, `bundle-${index}`);
    await mkdir(bundle, { mode: 0o700 });
    const receipt = await materializeRestrictedInputs(f.request(revision), bundle);
    assert.equal(receipt.source.revision, revision);
    assert.deepEqual(receipt.source.files.map(file => file.path), paths);
    for (const file of receipt.source.files) {
      const expected = git('cat-file', 'blob', file.oid);
      const actual = await readFile(join(bundle, 'source', file.path));
      assert.deepEqual(actual, expected);
      assert.equal(file.sha256, sha(expected));
      assert.equal(file.bytes, actual.length);
      assert.equal(file.oid, git('rev-parse', `${revision}:${file.path}`).toString().trim());
      assert.equal((await stat(join(bundle, 'source', file.path))).mode & 0o777, 0o444);
    }
    assert.equal(receipt.dependencies.manifestSha256, f.request(revision).dependencies.sha256);
    assert.deepEqual(await readFile(join(bundle, 'deps/node_modules/sample/module.js')), await readFile(f.dependency));
    assert.equal((await stat(join(bundle, 'deps/node_modules/sample/module.js'))).mode & 0o777, 0o444);
  }
});

test('single labeled sensitivity mutation changes only the staged file and records original object', async t => {
  const f = await fixture();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(f.root, { recursive: true, force: true })); });
  const bundle = join(f.root, 'mutated'); await mkdir(bundle);
  const request = f.request(revisions[1]);
  request.source = { ...request.source, mutation: { label: 'sensitivity-control', path: 'package.json', before: '"private": true', after: '"private": false' } };
  const receipt = await materializeRestrictedInputs(request, bundle);
  const changed = receipt.source.files.find(file => file.path === 'package.json');
  assert.equal(changed.mutation, 'sensitivity-control');
  assert.equal(changed.oid, git('rev-parse', `${revisions[1]}:package.json`).toString().trim());
  assert.equal(changed.sha256, sha(await readFile(join(bundle, 'source/package.json'))));
  assert.match((await readFile(join(bundle, 'source/package.json'), 'utf8')), /"private": false/);
  assert.match(git('cat-file', 'blob', changed.oid).toString(), /"private": true/);
});

test('pinned reader refuses symlink, special file, drift and size before materialization', async t => {
  const f = await fixture();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(f.root, { recursive: true, force: true })); });
  const pin = { path: f.dependency, sha256: sha(await readFile(f.dependency)) };
  assert.deepEqual(await readPinnedFile(pin, 1024), await readFile(f.dependency));
  await assert.rejects(readPinnedFile(pin, 1), /size|large|limit/i);
  await writeFile(f.dependency, 'changed');
  await assert.rejects(readPinnedFile(pin, 1024), /digest|drift|pin/i);
  const link = join(f.root, 'link'); await symlink(f.dependency, link);
  await assert.rejects(readPinnedFile({ ...pin, path: link }, 1024), /symlink|regular|path/i);
  await assert.rejects(readPinnedFile({ ...pin, path: '/dev/null' }, 1024), /regular|path/i);
});

test('rejects missing source, malformed manifest, path escape and dependency drift; removes owned partial staging', async t => {
  const f = await fixture();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(f.root, { recursive: true, force: true })); });
  async function reject(request, suffix) {
    const bundle = join(f.root, suffix); await mkdir(bundle);
    await assert.rejects(materializeRestrictedInputs(request, bundle));
    assert.deepEqual(await readdir(bundle), []);
  }
  await reject({ ...f.request(revisions[0]), source: { repository, revision: revisions[0], paths: ['not-a-real-file'] } }, 'missing');
  await reject({ ...f.request(revisions[0]), source: { repository, revision: revisions[0], paths: ['../package.json'] } }, 'escape');
  await reject({ ...f.request(revisions[0]), source: { repository, revision: 'a'.repeat(40), paths } }, 'missing-commit');
  await reject({ ...f.request(revisions[0]), source: { repository, revision: revisions[0], paths, mutation: { label: 'sensitivity-control', path: 'package.json', before: '"', after: 'X' } } }, 'ambiguous-mutation');
  const request = f.request(revisions[0]);
  await writeFile(f.dependency, 'drift');
  await reject(request, 'drift');
  const invalid = join(f.root, 'invalid.json'); await writeFile(invalid, JSON.stringify({ schemaVersion: 1, files: [{ path: '/dev/null', destination: '../escape', sha256: 'a'.repeat(64) }] }));
  await reject({ ...request, dependencies: { path: invalid, sha256: sha(await readFile(invalid)) } }, 'invalid');
});

test('raw tree refuses symlinks, gitlinks, metadata controls, collisions and malformed entries', () => {
  const oid = 'a'.repeat(40);
  const record = (mode, kind, path) => `${mode} ${kind} ${oid}\t${path}\0`;
  for (const tree of [
    record('120000', 'blob', 'link'), record('160000', 'commit', 'child'),
    record('100644', 'blob', '.gitattributes'), record('100644', 'blob', 'nested/.gitmodules'),
    record('100644', 'blob', '../escape'), record('100644', 'blob', 'café'),
    record('100644', 'blob', 'a') + record('100644', 'blob', 'A'),
    record('100644', 'blob', 'ok').slice(0, -1),
  ]) assert.throws(() => parseRestrictedTree(Buffer.from(tree)));
  assert.equal(parseRestrictedTree(Buffer.from(record('100644', 'blob', 'src/findings.ts'))).get('src/findings.ts').oid, oid);
});

test('never removes caller-owned bundle entries on a failed fresh staging attempt', async t => {
  const f = await fixture();
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(f.root, { recursive: true, force: true })); });
  const bundle = join(f.root, 'occupied'); await mkdir(bundle);
  const deps = join(bundle, 'deps'); await mkdir(deps);
  await writeFile(join(deps, 'keep'), 'caller-owned');
  await assert.rejects(materializeRestrictedInputs(f.request(revisions[0]), bundle));
  assert.deepEqual(await readdir(bundle), ['deps']);
  assert.equal(await readFile(join(deps, 'keep'), 'utf8'), 'caller-owned');
});
