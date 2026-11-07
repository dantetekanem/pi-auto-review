import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statfsSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { canonicalPath, componentOf, diffOptions, git, gitEnvironment, isTestPath, nulList, parseRaw, readObjects, removeTree, textOf, withPrivateIndex, type Analysis, type Raw } from './review-tests.ts';

export type Entry = { kind: 'file' | 'symlink'; bytes: Buffer; permissions: number } | null;
export type Mutation = { path: string; line: number; before: string; after: string; safeguard: string };
export type EdgeTest = { path: string; content: string; codePath: string };
export type Execution = {
  status: 'completed' | 'timeout' | 'cancelled' | 'spawn_error'; exitCode: number | null; signal: string | null; error: string | null;
  stdout: Buffer; stderr: Buffer; tail: string; truncated: { stdout: boolean; stderr: boolean }; durationMs: number;
};
const secretName = /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|SESSION|COOKIE|AUTH|DSN|_KEY$|_PASS$|_PWD$|_PW$/i;
const deniedServices = ['com.apple.coreservices.launchservicesd', 'com.apple.coreservices.appleevents', 'com.apple.coreservices.sharedfilelistd.xpc', 'com.apple.pasteboard.1',
  'com.apple.coreservices.uauseractivitypasteboardclient.xpc', 'com.apple.SecurityServer', 'com.apple.securityd.xpc'];
const deniedServicePrefixes = ['com.apple.lsd.', 'com.apple.coreservices.uasharedpasteboard', 'com.apple.backgroundtaskmanagement'];
const gitLocation = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES)$/;
const depth = (path: string) => path ? path.split('/').length : 0;
const fromGit = (mode: string, bytes: Buffer): Entry => mode === '120000' ? { kind: 'symlink', bytes, permissions: 0o755 }
  : { kind: 'file', bytes, permissions: mode === '100755' ? 0o755 : 0o644 };
const exactKeys = (value: unknown, keys: string[], label: string) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error(`${label} needs exactly: ${keys.join(', ')}.`);
};

export function cloneProblem(root: string, directory: string): string | null {
  if (process.platform !== 'darwin') return 'Test workspaces need macOS: APFS copy-on-write clones and sandbox-exec.';
  let existing = directory;
  while (!existsSync(existing)) existing = dirname(existing);
  if (!relative(root, join(realpathSync(existing), relative(existing, directory))).startsWith('..')) return 'The review history lives inside the checkout; a workspace there would copy itself.';
  // statfs f_type 0x1a is APFS; /bin/cp -c silently falls back to a full copy on any other volume.
  if (statSync(root).dev !== statSync(existing).dev || statfsSync(root).type !== 0x1a) return 'The checkout and the review history must share one APFS volume for copy-on-write clones.';
  return null;
}

/** Every workspace write resolves here: no symlinked or escaping ancestor. `optional` returns null when a parent is missing. */
export function guardPath(workspace: string, path: string, parents: 'existing' | 'optional' | 'create' | 'replace', created: string[] = []): string | null {
  if (!canonicalPath(path)) throw new Error(`Unsafe workspace path: ${String(path)}`);
  const parts = path.split('/');
  let current = workspace;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isDirectory()) continue;
    if (!stat && parents === 'optional') return null;
    if (stat ? parents !== 'replace' : parents === 'existing') throw new Error(`Workspace path ${path} passes through a symlink, a file or a missing directory.`);
    if (stat) unlinkSync(current);
    mkdirSync(current, { mode: 0o755 });
    created.push(current);
  }
  if (realpathSync(current) !== current) throw new Error(`Workspace path ${path} resolves outside the workspace.`);
  return join(current, parts[parts.length - 1]);
}

export function readEntry(target: string): Entry {
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { kind: 'symlink', bytes: readlinkSync(target, { encoding: 'buffer' }), permissions: 0o755 };
  if (!stat.isFile()) throw new Error(`Workspace entry ${target} is not a file or symlink.`);
  return { kind: 'file', bytes: readFileSync(target), permissions: stat.mode & 0o7777 };
}

const sameEntry = (left: Entry, right: Entry) => left === right || (!!left && !!right && left.kind === right.kind
  && left.bytes.equals(right.bytes) && (left.kind === 'symlink' || left.permissions === right.permissions));

function writeEntry(target: string, entry: Entry, directories = false): void {
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    if (!directories) throw new Error(`Workspace entry ${target} is a directory.`);
    removeTree(target);
  } else if (stat) unlinkSync(target);
  if (!entry) return;
  if (entry.kind === 'symlink') return symlinkSync(entry.bytes, target);
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, entry.bytes); fchmodSync(fd, entry.permissions); } finally { closeSync(fd); }
}

function overlayHead(analysis: Analysis, workspace: string): void {
  const { root, head, components } = analysis;
  const specs = components.map(component => component || '.');
  const { raw, untracked } = withPrivateIndex(root, index => ({
    raw: parseRaw(git(root, ['diff', '--raw', '-z', '--no-abbrev', ...diffOptions, head, '--', ...specs], { index })),
    untracked: nulList(git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...specs], { index })),
  }));
  const remove = (path: string) => {
    const target = guardPath(workspace, path, 'optional');
    if (target) writeEntry(target, null, true);
  };
  untracked.forEach(path => remove(path.replace(/\/$/, '')));
  const writes: Raw[] = [];
  for (const entry of raw) {
    if (entry.srcMode === '160000' || entry.dstMode === '160000') continue;
    if (entry.status === 'A' || entry.srcMode === '000000') remove(entry.path);
    else writes.push(entry);
  }
  const blobs = readObjects(root, writes.map(entry => entry.srcBlob));
  for (const entry of writes) {
    const blob = blobs.get(entry.srcBlob);
    if (blob?.type !== 'blob') throw new Error(`The head blob for ${entry.path} is missing.`);
    writeEntry(guardPath(workspace, entry.path, 'replace')!, fromGit(entry.srcMode, blob.bytes), true);
  }
}

/** A workspace the tool may write to: a real directory still at its recorded canonical path. */
export const intactWorkspace = (path: string) => !!lstatSync(path, { throwIfNoEntry: false })?.isDirectory() && realpathSync(path) === path;

/** Processes that outlive a run keep write access to that run's path only, so the tool moves the workspace to a fresh one before touching it. */
export function rotateWorkspace(workspace: string): string | null {
  const next = join(dirname(workspace), randomUUID());
  try { renameSync(workspace, next); } catch { return null; }
  if (intactWorkspace(next)) return next;
  removeTree(next);
  return null;
}

/** Builds into a temporary sibling under `workspaces` and moves it into place only when complete, so a failed build leaves nothing a later run trusts. */
export function buildWorkspace(analysis: Analysis, workspaces: string): string {
  const problem = cloneProblem(analysis.root, workspaces);
  if (problem) throw new Error(problem);
  mkdirSync(workspaces, { recursive: true, mode: 0o700 });
  const name = randomUUID();
  const building = join(realpathSync(workspaces), `${name}.building`);
  mkdirSync(building, { mode: 0o700 });
  try {
    fill(analysis, building);
    const built = join(dirname(building), name);
    renameSync(building, built);
    return built;
  } catch (error) {
    removeTree(building);
    throw error;
  }
}

/** Components are clones; their ancestors are real directories whose other entries link to the checkout. */
function fill(analysis: Analysis, real: string): void {
  const { root, components } = analysis;
  const clone = (sources: string[], target: string) => {
    const result = spawnSync('/bin/cp', ['-c', '-R', ...sources, target], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Copy-on-write clone failed: ${(result.stderr || String(result.error)).trim().slice(0, 300)}`);
  };
  if (components.includes('')) {
    const entries = readdirSync(root).filter(entry => entry !== '.git');
    if (entries.length) clone(entries.map(entry => join(root, entry)), real);
  } else {
    const ancestors = new Set<string>(['']);
    for (const component of components) for (let directory = dirname(component); directory !== '.'; directory = dirname(directory)) ancestors.add(directory);
    for (const directory of [...ancestors].sort((left, right) => depth(left) - depth(right))) {
      if (directory) mkdirSync(guardPath(real, directory, 'existing')!);
      if (!lstatSync(join(root, directory), { throwIfNoEntry: false })?.isDirectory()) continue;
      for (const entry of readdirSync(join(root, directory))) {
        const path = directory ? `${directory}/${entry}` : entry;
        if ((!directory && entry === '.git') || ancestors.has(path)) continue;
        const target = guardPath(real, path, 'existing')!;
        if (!components.includes(path)) symlinkSync(join(root, path), target);
        else if (lstatSync(join(root, path)).isDirectory()) clone([join(root, path)], target);
        else mkdirSync(target);
      }
    }
    for (const component of components) {
      const target = guardPath(real, component, 'existing')!;
      if (!lstatSync(target, { throwIfNoEntry: false })) mkdirSync(target);
    }
  }
  if (analysis.headState === 'commit') overlayHead(analysis, real);
}

function prepareBreak(workspace: string, analysis: Analysis, mutation: Mutation): Entry {
  exactKeys(mutation, ['path', 'line', 'before', 'after', 'safeguard'], 'A break');
  const { path, line, before, after, safeguard } = mutation;
  const file = analysis.files.find(item => item.path === path);
  if (!file || file.test || file.status === 'deleted') throw new Error('A break edits a changed non-test file that exists at head.');
  if (!Number.isInteger(line) || !file.ranges.some(([start, end]) => line >= start && line <= end)) throw new Error(`Line ${line} is outside the changed lines of ${path}.`);
  if (typeof before !== 'string' || typeof after !== 'string' || !before || before.length > 500 || after.length > 500
    || /[\r\n]/.test(before + after) || before === after) throw new Error('A break needs a different one-line "before" and "after", each at most 500 characters.');
  if (typeof safeguard !== 'string' || !safeguard.trim() || safeguard.length > 300) throw new Error('A break names the safeguard it turns off in 1-300 characters.');
  const entry = readEntry(guardPath(workspace, path, 'existing')!);
  const text = entry?.kind === 'file' ? textOf(entry.bytes) : null;
  if (!entry || text === null || !Buffer.from(text).equals(entry.bytes)) throw new Error(`${path} is not a UTF-8 text file in the workspace.`);
  const lines = text.split('\n');
  const original = lines[line - 1] ?? '';
  const first = original.indexOf(before);
  if (first < 0 || original.indexOf(before, first + 1) >= 0) throw new Error(`"before" must occur exactly once on line ${line} of ${path}.`);
  lines[line - 1] = original.slice(0, first) + after + original.slice(first + before.length);
  return { ...entry, bytes: Buffer.from(lines.join('\n')) };
}

function prepareEdge(workspace: string, analysis: Analysis, edge: EdgeTest): Entry {
  exactKeys(edge, ['path', 'content', 'codePath'], 'An edge test');
  const { path, content, codePath } = edge;
  if (!canonicalPath(path) || !isTestPath(path)) throw new Error('An edge test path must be a repository-relative test file path.');
  if (componentOf(analysis.components, path) === undefined || analysis.components.includes(path)) throw new Error(`${path} is outside the copied components.`);
  if (typeof content !== 'string' || Buffer.byteLength(content) > 65536) throw new Error('Edge test content is at most 64 KiB.');
  if (typeof codePath !== 'string' || !codePath.trim() || codePath.length > 300) throw new Error('An edge test names the code path it probes in 1-300 characters.');
  const target = guardPath(workspace, path, 'optional');
  if (target && lstatSync(target, { throwIfNoEntry: false })) throw new Error(`${path} already exists in the workspace; edge tests are new files.`);
  return { kind: 'file', bytes: Buffer.from(content), permissions: 0o644 };
}

/** Validates a change against the workspace without touching it, so a bad request never consumes a run. */
export function planChange(workspace: string, analysis: Analysis, kind: 'revert' | 'break' | 'edge', change: unknown): { path: string; after: Entry }[] {
  if (kind === 'break') return [{ path: (change as Mutation)?.path, after: prepareBreak(workspace, analysis, change as Mutation) }];
  if (kind === 'edge') return [{ path: (change as EdgeTest)?.path, after: prepareEdge(workspace, analysis, change as EdgeTest) }];
  const sources = analysis.files.filter(file => !file.test);
  if (!sources.length) throw new Error('The change has no source files to revert.');
  const blobs = readObjects(analysis.root, sources.flatMap(file => file.baseBlob ? [file.baseBlob] : []));
  return sources.map(file => {
    const blob = file.baseBlob ? blobs.get(file.baseBlob) : null;
    if (file.baseBlob && blob?.type !== 'blob') throw new Error(`The base blob for ${file.path} is missing.`);
    return { path: file.path, after: blob && file.baseMode ? fromGit(file.baseMode, blob.bytes) : null };
  });
}

function unifiedDiff(items: { path: string; before: Entry; after: Entry }[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'review-tests-diff-'));
  try {
    for (const [side, key] of [['a', 'before'], ['b', 'after']] as const) {
      mkdirSync(join(directory, side));
      for (const item of items) {
        if (!item[key]) continue;
        mkdirSync(dirname(join(directory, side, item.path)), { recursive: true });
        writeEntry(join(directory, side, item.path), item[key]);
      }
    }
    const result = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--no-index', '--src-prefix=', '--dst-prefix=', ...diffOptions, 'a', 'b'],
      { cwd: directory, env: gitEnvironment(), maxBuffer: 1 << 28 });
    if (result.status !== 0 && result.status !== 1) throw new Error(`git diff --no-index failed: ${result.stderr.toString('utf8').trim().slice(0, 300)}`);
    return result.stdout.toString('utf8');
  } finally { removeTree(directory); }
}

/** `restore` takes the workspace's current path: after a run the workspace has moved (see rotateWorkspace). */
export function applyChange(workspace: string, analysis: Analysis, kind: 'revert' | 'break' | 'edge', change: unknown): { diff: string; restore: (root?: string) => void } {
  const planned = planChange(workspace, analysis, kind, change);
  const created: string[] = [];
  const touched: { path: string; before: Entry; after: Entry }[] = [];
  // The tests ran in between and may have swapped a directory for a symlink, so every restore write is guarded again.
  const restore = (root = workspace) => {
    const directories = created.map(path => relative(workspace, path)).reverse();
    const at = (path: string) => guardPath(root, path, 'optional');
    for (const item of [...touched].reverse()) writeEntry(guardPath(root, item.path, 'create')!, item.before, true);
    for (const directory of directories) {
      const target = at(directory);
      if (target) writeEntry(target, null, true);
    }
    const current = (path: string) => {
      const target = at(path);
      return target ? readEntry(target) : null;
    };
    const present = (path: string) => {
      const target = at(path);
      return !!target && !!lstatSync(target, { throwIfNoEntry: false });
    };
    const wrong = [...touched.filter(item => !sameEntry(current(item.path), item.before)).map(item => item.path), ...directories.filter(present)];
    if (wrong.length) throw new Error(`Workspace restore failed for ${wrong.join(', ')}.`);
  };
  try {
    for (const { path, after } of planned) {
      const target = guardPath(workspace, path, 'create', created)!;
      const before = readEntry(target);
      if (kind === 'edge' && before) throw new Error(`${path} already exists in the workspace.`);
      touched.push({ path, before, after });
      writeEntry(target, after);
    }
    return { diff: unifiedDiff(touched), restore };
  } catch (error) {
    try { restore(); } catch { /* The original error explains the failed change. */ }
    throw error;
  }
}

export function resolveCwd(workspace: string, components: string[], cwd: string): string {
  const path = cwd === '.' ? '' : cwd;
  if (path && !canonicalPath(path)) throw new Error('cwd must be a repository-relative directory.');
  if (!components.some(component => component === '' || path === component || path.startsWith(`${component}/`))) {
    throw new Error(`cwd ${cwd} is outside the copied components: ${components.map(component => component || '.').join(', ')}.`);
  }
  let current = workspace;
  for (const part of path ? path.split('/') : []) {
    current = join(current, part);
    if (!lstatSync(current, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`cwd ${cwd} is not a real directory in the workspace.`);
  }
  return current;
}

export function resetTemporary(workspace: string): string {
  const target = guardPath(workspace, '.review-tmp', 'existing')!;
  writeEntry(target, null, true);
  mkdirSync(target, { mode: 0o700 });
  return target;
}

/** Later rules win. The literal deny keeps a test from removing or replacing the workspace root itself; the flags deny keeps it from making files the tool must remove immutable. */
export function sandboxProfile(workspace: string): string {
  const quoted = `"${realpathSync(workspace).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    `(allow network* (local unix-socket (subpath ${quoted})) (remote unix-socket (subpath ${quoted})))`,
    '(deny file-write*)',
    `(allow file-write* (subpath ${quoted}) (literal "/dev/null") (literal "/dev/zero")`
      + ' (regex #"^/dev/fd/[0-9]+$") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/dtracehelper"))',
    `(deny file-write* (literal ${quoted}))`,
    `(deny file-write-flags (subpath ${quoted}))`,
    '(deny lsopen appleevent-send job-creation user-preference-write)',
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    `(deny mach-lookup ${[...deniedServicePrefixes.map(name => `(global-name-prefix "${name}")`), ...deniedServices.map(name => `(global-name "${name}")`)].join(' ')})`,
  ].join('\n');
}

export function testEnvironment(workspace: string, cwd: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const temporary = join(workspace, '.review-tmp');
  // A nested `node --test` that inherits NODE_TEST_CONTEXT skips its files and exits 0.
  const kept = Object.entries(source).filter(([name, value]) => value !== undefined && !secretName.test(name) && !gitLocation.test(name) && name !== 'NODE_TEST_CONTEXT');
  // The workspace has no .git, so git in a test would otherwise find a repository above it, such as a home-directory one.
  return { ...Object.fromEntries(kept), TMPDIR: temporary, TMP: temporary, TEMP: temporary, PWD: cwd, GIT_CEILING_DIRECTORIES: dirname(workspace) };
}

function tailBuffer(limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk: Buffer) {
      chunks.push(chunk);
      size += chunk.length;
      while (size > limit) {
        const excess = size - limit;
        if (chunks[0].length <= excess) size -= chunks.shift()!.length;
        else { chunks[0] = chunks[0].subarray(excess); size -= excess; }
        truncated = true;
      }
    },
    bytes: () => Buffer.concat(chunks),
    truncated: () => truncated,
  };
}

export function executable(program: string, cwd: string, path = ''): string | null {
  const candidates = program.includes('/') ? [resolve(cwd, program)] : path.split(':').filter(Boolean).map(directory => resolve(cwd, directory, program));
  return candidates.find(candidate => {
    try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile(); } catch { return false; }
  }) ?? null;
}

export function runCommand(options: {
  command: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; profile: string | null;
  signal?: AbortSignal; killAfterMs?: number; limit?: number; onSpawn?: (group: number) => void;
}): Promise<Execution> {
  const { command, cwd, env, profile, signal, killAfterMs = 5000, limit = 1_048_576 } = options;
  const started = performance.now();
  const output = { stdout: tailBuffer(limit), stderr: tailBuffer(limit) };
  const combined = tailBuffer(65536);
  const finish = (status: Execution['status'], exitCode: number | null, signalName: string | null, error: string | null): Execution => ({
    status, exitCode, signal: signalName, error, stdout: output.stdout.bytes(), stderr: output.stderr.bytes(),
    tail: combined.bytes().toString('utf8').replace(/\n$/, '').split('\n').slice(-40).join('\n').slice(-4000),
    truncated: { stdout: output.stdout.truncated(), stderr: output.stderr.truncated() }, durationMs: Math.ceil(performance.now() - started),
  });
  const program = executable(command[0], cwd, env.PATH);
  if (!program) return Promise.resolve(finish('spawn_error', null, null, `${command[0]} is not an executable file or on PATH.`));
  if (signal?.aborted) return Promise.resolve(finish('cancelled', null, null, null));
  const argv = profile ? ['/usr/bin/sandbox-exec', '-p', profile, program, ...command.slice(1)] : [program, ...command.slice(1)];
  return new Promise(settlePromise => {
    let status: Execution['status'] = 'completed';
    let exited = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid) options.onSpawn?.(child.pid);
    const group = (name: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, name); } catch { /* The group already exited. */ }
    };
    const sweep = () => group('SIGKILL');
    const stop = (reason: Execution['status']) => {
      if (status !== 'completed' || exited) return;
      status = reason;
      group('SIGTERM');
      timers.push(setTimeout(sweep, killAfterMs));
    };
    const abort = () => stop('cancelled');
    const settle = (result: Execution) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      signal?.removeEventListener('abort', abort);
      process.removeListener('exit', sweep);
      settlePromise(result);
    };
    timers.push(setTimeout(() => stop('timeout'), options.timeoutMs));
    signal?.addEventListener('abort', abort, { once: true });
    process.once('exit', sweep);
    for (const name of ['stdout', 'stderr'] as const) child[name].on('data', (chunk: Buffer) => { output[name].push(chunk); combined.push(chunk); });
    child.once('error', error => { if (!child.pid) settle(finish('spawn_error', null, null, error.message)); });
    child.once('exit', () => {
      exited = true;
      // Background processes left in the group would keep writing into the workspace between runs.
      sweep();
      timers.push(setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 2000));
    });
    child.once('close', (code, name) => settle(finish(status, code, name, null)));
  });
}
