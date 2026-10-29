import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { digestBytes } from '../src/experiments-contract.ts';
import { materializeRestrictedInputs, parseRestrictedTree, readPinnedFile } from '../src/experiments-materialize.ts';
import { safeRelativePath } from '../src/experiments-restricted-contract.ts';

const execute = promisify(execFile);
const maxPacketBytes = 2 * 1024 * 1024;
const gitEnvironment = {
  PATH: '/usr/bin:/bin', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: '',
  GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '0',
};
const isText = value => typeof value === 'string' && value.length > 0 && value.length <= 4000;
const isRevision = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

function requireFields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error('Unexpected public corpus fields.');
}
function validateCorpus(corpus, repositories) {
  requireFields(corpus, ['schemaVersion', 'corpusId', 'purpose', 'cases']);
  if (corpus.schemaVersion !== 1 || !isText(corpus.corpusId) || !isText(corpus.purpose)
    || !Array.isArray(corpus.cases) || !corpus.cases.length || corpus.cases.length > 4) throw new Error('Invalid public corpus.');
  const ids = new Set();
  for (const item of corpus.cases) {
    requireFields(item, ['id', 'repository', 'base', 'head', 'scope', 'request', 'criteria']);
    if (typeof item.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.id)
      || ['manifest', 'empty-dependencies'].includes(item.id) || ids.has(item.id)
      || !isText(item.request) || !isRevision(item.base) || !isRevision(item.head)) throw new Error('Invalid public case.');
    ids.add(item.id);
    if (!isText(item.repository) || !Object.hasOwn(repositories, item.repository)
      || typeof repositories[item.repository] !== 'string' || !isAbsolute(repositories[item.repository])) throw new Error('Unapproved case repository.');
    if (!Array.isArray(item.scope) || !item.scope.length || item.scope.length > 64
      || new Set(item.scope).size !== item.scope.length || !item.scope.every(safeRelativePath)) throw new Error('Invalid source scope paths.');
    if (!Array.isArray(item.criteria) || !item.criteria.length || item.criteria.length > 32) throw new Error('Invalid public criteria.');
    for (const criterion of item.criteria) {
      requireFields(criterion, ['id', 'statement']);
      if (!isText(criterion.id) || !isText(criterion.statement)) throw new Error('Invalid public criterion.');
    }
  }
}
async function git(repository, args, signal) {
  const { stdout } = await execute('/usr/bin/git', ['--literal-pathspecs', '-C', repository, ...args], {
    env: gitEnvironment, encoding: 'buffer', maxBuffer: maxPacketBytes, timeout: 10000, signal,
  });
  return stdout;
}

/** Prepares data only. It does not execute historical code, launch reviewers or grant execution authority. */
export async function prepareBenchmark(directory, { corpus: corpusPin, repositories }, signal) {
  signal?.throwIfAborted();
  const corpus = JSON.parse(decode(await readPinnedFile(corpusPin, 1048576, signal)));
  validateCorpus(corpus, repositories);
  if (!isAbsolute(directory)) throw new Error('An absolute fresh output directory is required.');
  const roots = new Map();
  for (const item of corpus.cases) {
    roots.set(item.repository, await realpath(repositories[item.repository]));
  }

  await mkdir(directory, { mode: 0o700 });
  const root = await realpath(directory);
  const dependencyBytes = JSON.stringify({ schemaVersion: 1, files: [] });
  const dependencies = { path: join(root, 'empty-dependencies.json'), sha256: digestBytes(dependencyBytes) };
  await writeFile(dependencies.path, dependencyBytes, { flag: 'wx', mode: 0o600 });
  const packets = [];
  for (const item of corpus.cases) {
    signal?.throwIfAborted();
    const repository = roots.get(item.repository);
    await mkdir(join(root, item.id), { mode: 0o700 });
    const snapshots = {};
    for (const side of ['base', 'head']) {
      const selected = parseRestrictedTree(await git(repository, ['ls-tree', '-rz', item[side], '--', ...item.scope], signal));
      if (!selected.size || [...selected.keys()].some(path => !item.scope.includes(path))) {
        throw new Error('Source scope must name existing files, not directories.');
      }
      const bundle = join(root, item.id, side);
      await mkdir(bundle, { mode: 0o700 });
      const { source } = await materializeRestrictedInputs({
        source: { repository, revision: item[side], paths: [...selected.keys()] }, dependencies,
      }, bundle, signal);
      const files = [];
      for (const file of source.files) {
        const bytes = await readPinnedFile({ path: join(bundle, 'source', file.path), sha256: file.sha256 }, maxPacketBytes, signal);
        if (bytes.includes(0)) throw new Error('Binary source is unsupported.');
        files.push({ path: file.path, oid: file.oid, sha256: file.sha256, text: decode(bytes) });
      }
      snapshots[side] = { revision: source.revision, tree: source.tree, files };
    }
    if (item.scope.some(path => !['base', 'head'].some(side => snapshots[side].files.some(file => file.path === path)))) {
      throw new Error('A declared source path is absent from both revisions.');
    }
    const diff = decode(await git(repository, [
      'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color',
      item.base, item.head, '--', ...item.scope,
    ], signal));
    const bytes = JSON.stringify({ schemaVersion: 1, case: item, diff, snapshots }) + '\n';
    if (Buffer.byteLength(bytes) > maxPacketBytes) throw new Error('Reviewer packet exceeds its byte limit.');
    const path = `${item.id}.json`;
    await writeFile(join(root, path), bytes, { flag: 'wx', mode: 0o600 });
    packets.push({ caseId: item.id, path, sha256: digestBytes(bytes), bytes: Buffer.byteLength(bytes) });
  }
  const manifest = {
    schemaVersion: 1,
    phase: 'prepared-inputs',
    corpusId: corpus.corpusId,
    publicCorpusSha256: corpusPin.sha256,
    modelCalls: 0,
    executionAttempts: 0,
    packets,
    limitations: [
      'Only declared source paths are included; this is not full dependency coverage.',
      'No author records, repair revisions, replay outputs or evaluator are reviewer inputs.',
      'Original corpus labels were exposed to the lead; this does not create a fresh holdout.',
      'Input preparation is not a frozen evaluation plan, launch authority or model result.'],
  };
  const bytes = JSON.stringify(manifest, null, 2) + '\n';
  const path = join(root, 'manifest.json');
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  return { path, sha256: digestBytes(bytes) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: node evaluation/prepare-benchmark.mjs ABSOLUTE_OUTPUT ABSOLUTE_TEAMS_REPOSITORY');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const seal = JSON.parse(await readFile(join(root, 'evaluation/corpus/seal.json'), 'utf8'));
  const entry = seal.files.find(file => file.path === 'evaluation/corpus/public.json');
  if (!entry) throw new Error('Public corpus seal is missing.');
  console.log(JSON.stringify(await prepareBenchmark(process.argv[2], {
    corpus: { path: await realpath(join(root, entry.path)), sha256: entry.sha256 },
    repositories: { 'https://github.com/dantetekanem/pi-auto-review': root,
      'https://github.com/dantetekanem/pi-extended-teams': process.argv[3] },
  }), null, 2));
}
