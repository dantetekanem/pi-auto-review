import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rm } from 'node:fs/promises';
import { isAbsolute, join, parse, sep } from 'node:path';
import { promisify } from 'node:util';
import { safeRelativePath, type PinnedFile, type RestrictedRequest } from './experiments-restricted-contract.ts';

const execute = promisify(execFile);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const digestPattern = /^[a-f0-9]{64}$/;
const sourceLimit = 8 * 1024 * 1024;
const dependencyLimit = 16 * 1024 * 1024;
const gitEnvironment = {
  PATH: '/usr/bin:/bin', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: '',
  GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '0',
};

function checkSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error('Materialization cancelled.');
}

/** Read one host-approved regular file, without following symlinks or allocating unbounded data. */
export async function readPinnedFile(pin: PinnedFile, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  if (!pin || typeof pin.path !== 'string' || !isAbsolute(pin.path) || !digestPattern.test(pin.sha256)
    || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid pinned file.');
  checkSignal(signal);
  let current = parse(pin.path).root;
  for (const part of pin.path.slice(current.length).split(sep)) {
    if (!part || part === '.' || part === '..') throw new Error('Unsafe pinned path.');
    current = join(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new Error('Pinned path contains a symlink.');
    if (current !== pin.path && !entry.isDirectory()) throw new Error('Pinned path has a non-directory parent.');
  }
  const handle = await open(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Pinned input must be a regular file.');
    if (before.size > maxBytes) throw new Error('Pinned input exceeds size limit.');
    const chunks: Buffer[] = [];
    let position = 0;
    while (position < before.size) {
      checkSignal(signal);
      const chunk = Buffer.allocUnsafe(Math.min(65536, before.size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) throw new Error('Pinned input changed during read.');
      chunks.push(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || after.ino !== before.ino || after.dev !== before.dev) throw new Error('Pinned input drifted during read.');
    const bytes = Buffer.concat(chunks, position);
    if (sha256(bytes) !== pin.sha256) throw new Error('Pinned input digest drift.');
    return bytes;
  } finally {
    await handle.close();
  }
}

type TreeEntry = { path: string; oid: string };
function validatePath(path: string): boolean {
  return safeRelativePath(path) && /^[\x20-\x7e]+$/.test(path)
    && !path.split('/').some(part => /^\.git$|^\.gitattributes$|^\.gitmodules$/i.test(part));
}

/** Git -z output is bytes, not a line-oriented or shell-escaped listing. */
export function parseRestrictedTree(bytes: Buffer): Map<string, TreeEntry> {
  if (bytes.length > 1048576 || (bytes.length && bytes.at(-1) !== 0)) throw new Error('Invalid or oversized Git tree.');
  const entries = new Map<string, TreeEntry>();
  const folded = new Set<string>();
  for (const record of bytes.subarray(0, bytes.length ? -1 : 0).toString('utf8').split('\0')) {
    if (!record) continue;
    const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/s.exec(record);
    if (!match || match[1] !== '100644' && match[1] !== '100755' || match[2] !== 'blob'
      || !validatePath(match[4])) throw new Error('Unsupported Git tree entry, path or mode.');
    const path = match[4];
    const key = path.toLowerCase();
    if (folded.has(key)) throw new Error('Case-colliding Git paths are unsupported.');
    folded.add(key);
    entries.set(path, { path, oid: match[3] });
  }
  return entries;
}

async function git(repository: string, args: string[], maxBuffer: number, signal?: AbortSignal): Promise<Buffer> {
  checkSignal(signal);
  const { stdout } = await execute('/usr/bin/git', ['-C', repository, ...args], {
    env: gitEnvironment, encoding: 'buffer', maxBuffer, signal,
  });
  return stdout as Buffer;
}

async function blob(repository: string, oid: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const size = Number((await git(repository, ['cat-file', '-s', oid], 100, signal)).toString('ascii').trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) throw new Error('Source blob exceeds size limit.');
  const bytes = await git(repository, ['cat-file', 'blob', oid], maxBytes + 1, signal);
  if (bytes.length !== size || bytes.subarray(0, 43).toString('ascii').startsWith('version https://git-lfs.github.com/spec/v1')) {
    throw new Error('Invalid source blob or unsupported LFS pointer.');
  }
  return bytes;
}

async function stage(root: string, path: string, bytes: Buffer): Promise<void> {
  const parts = path.split('/');
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    directory = join(directory, part);
    try {
      await mkdir(directory, { mode: 0o755 });
      await chmod(directory, 0o755);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await lstat(directory)).isDirectory()) throw error;
    }
  }
  const handle = await open(join(directory, parts.at(-1)!), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o444);
  } finally {
    await handle.close();
  }
}

type Manifest = { schemaVersion: 1; files: { path: string; destination: string; sha256: string }[] };
function parseManifest(bytes: Buffer): Manifest {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid dependency manifest.');
  const manifest = value as Manifest;
  if (Object.keys(manifest).sort().join(',') !== 'files,schemaVersion' || manifest.schemaVersion !== 1
    || !Array.isArray(manifest.files) || manifest.files.length > 1024) throw new Error('Invalid dependency manifest.');
  const destinations = new Set<string>();
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)
      || Object.keys(file).sort().join(',') !== 'destination,path,sha256'
      || typeof file.path !== 'string' || !isAbsolute(file.path)
      || !validatePath(file.destination) || !digestPattern.test(file.sha256)
      || destinations.has(file.destination.toLowerCase())) throw new Error('Unsafe dependency manifest entry.');
    destinations.add(file.destination.toLowerCase());
  }
  return manifest;
}

export async function materializeRestrictedInputs(
  request: RestrictedRequest, bundleRoot: string, signal?: AbortSignal,
): Promise<{
  source: { revision: string; tree?: string; files: { path: string; oid: string; sha256: string; bytes: number; mutation?: 'sensitivity-control' }[] };
  dependencies: { manifestSha256: string; files: { destination: string; sha256: string; bytes: number }[] };
}> {
  const { source, dependencies } = request;
  if (!source || !isAbsolute(source.repository) || !oidPattern.test(source.revision)
    || !Array.isArray(source.paths) || !source.paths.length || source.paths.length > 64
    || new Set(source.paths).size !== source.paths.length || !source.paths.every(validatePath)
    || !isAbsolute(bundleRoot)) throw new Error('Invalid materialization request.');
  if (source.mutation && (source.mutation.label !== 'sensitivity-control'
    || !source.paths.includes(source.mutation.path)
    || typeof source.mutation.before !== 'string' || typeof source.mutation.after !== 'string'
    || !source.mutation.before || !source.mutation.after
    || source.mutation.before.length > 1024 || source.mutation.after.length > 1024
    || source.mutation.before === source.mutation.after)) throw new Error('Invalid source mutation.');
  const root = await lstat(bundleRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Bundle root must be a fresh directory.');
  const kind = (await git(source.repository, ['cat-file', '-t', source.revision], 100, signal)).toString('ascii').trim();
  if (kind !== 'commit') throw new Error('Source revision is not a commit.');
  const commit = await git(source.repository, ['cat-file', 'commit', source.revision], 1048576, signal);
  const tree = /^tree ([a-f0-9]{40}|[a-f0-9]{64})\n/.exec(commit.toString('ascii'))?.[1];
  if (!tree) throw new Error('Invalid committed tree.');
  const entries = parseRestrictedTree(await git(source.repository, ['ls-tree', '-rz', tree], 1048576, signal));
  const manifest = parseManifest(await readPinnedFile(dependencies, 1048576, signal));
  const selected = source.paths.map(path => {
    const entry = entries.get(path);
    if (!entry) throw new Error(`Selected committed source is missing: ${path}`);
    return entry;
  });
  let sourceOwned = false;
  let depsOwned = false;
  const sourceFiles: { path: string; oid: string; sha256: string; bytes: number; mutation?: 'sensitivity-control' }[] = [];
  const dependencyFiles: { destination: string; sha256: string; bytes: number }[] = [];
  try {
    await mkdir(join(bundleRoot, 'source'), { mode: 0o755 });
    sourceOwned = true;
    await chmod(join(bundleRoot, 'source'), 0o755);
    await mkdir(join(bundleRoot, 'deps'), { mode: 0o755 });
    depsOwned = true;
    await chmod(join(bundleRoot, 'deps'), 0o755);
    let total = 0;
    for (const entry of selected) {
      const original = await blob(source.repository, entry.oid, sourceLimit - total, signal);
      total += original.length;
      let bytes = original;
      let mutation: 'sensitivity-control' | undefined;
      if (source.mutation?.path === entry.path) {
        const before = Buffer.from(source.mutation.before);
        const first = bytes.indexOf(before);
        if (first < 0 || bytes.indexOf(before, first + 1) !== -1) throw new Error('Mutation requires exactly one original occurrence.');
        bytes = Buffer.concat([bytes.subarray(0, first), Buffer.from(source.mutation.after), bytes.subarray(first + before.length)]);
        total += bytes.length - original.length;
        if (total > sourceLimit) throw new Error('Mutated source exceeds size limit.');
        mutation = 'sensitivity-control';
      }
      checkSignal(signal);
      await stage(join(bundleRoot, 'source'), entry.path, bytes);
      sourceFiles.push({ path: entry.path, oid: entry.oid, sha256: sha256(bytes), bytes: bytes.length, ...(mutation && { mutation }) });
    }
    total = 0;
    for (const file of manifest.files) {
      const bytes = await readPinnedFile({ path: file.path, sha256: file.sha256 }, dependencyLimit - total, signal);
      total += bytes.length;
      await stage(join(bundleRoot, 'deps'), file.destination, bytes);
      dependencyFiles.push({ destination: file.destination, sha256: sha256(bytes), bytes: bytes.length });
    }
    return { source: { revision: source.revision, tree, files: sourceFiles },
      dependencies: { manifestSha256: dependencies.sha256, files: dependencyFiles } };
  } catch (error) {
    if (sourceOwned) await rm(join(bundleRoot, 'source'), { recursive: true, force: true });
    if (depsOwned) await rm(join(bundleRoot, 'deps'), { recursive: true, force: true });
    throw error;
  }
}
