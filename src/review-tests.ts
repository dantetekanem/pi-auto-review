import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

export type Target = { root: string; base: string; head: string; headState: 'commit' | 'working-tree' };
export type ChangedFile = {
  path: string; status: 'added' | 'modified' | 'deleted'; test: boolean; ranges: [number, number][];
  baseMode: string | null; baseBlob: string | null; headMode: string | null; headBlob: string | null;
};
export type Analysis = Target & { components: string[]; files: ChangedFile[] };
export type Kind = 'baseline' | 'revert' | 'break' | 'edge';
export type Raw = { srcMode: string; dstMode: string; srcBlob: string; dstBlob: string; status: string; path: string };

export const kinds: Kind[] = ['baseline', 'revert', 'break', 'edge'];
export const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
export const diffOptions = ['--no-ext-diff', '--no-color', '--no-textconv', '--no-renames', '--ignore-submodules=all'];
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const markers = ['component.yml', 'package.json', 'Gemfile', 'go.mod', 'Cargo.toml', 'pyproject.toml'];
const controlFlow = /\b(?:if|unless|elsif|while|until|return|raise|throw|case|when|nil|null|true|false)\b|&&|\|\||\?\?|[!=]==?|<=?|(?<![=-])>=?/;
const proseOrData = /\.(?:md|markdown|mdx|rst|txt|adoc|json|jsonl|lock|csv|tsv|svg)$/i;
export const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const nulList = (bytes: Buffer) => bytes.toString('utf8').split('\0').filter(Boolean);
export const isMarker = (name: string) => markers.includes(name) || name.endsWith('.gemspec');
export const modeOf = (stat: Stats) => stat.isSymbolicLink() ? '120000' : stat.mode & 0o100 ? '100755' : '100644';
export const canonicalPath = (path: unknown): path is string => typeof path === 'string' && path.length > 0 && path.length <= 4096
  && !/[\0\\]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');

export function isTestPath(path: string): boolean {
  const parts = path.split('/');
  const name = parts.pop() ?? '';
  return parts.some(part => ['test', 'tests', 'spec', '__tests__'].includes(part))
    || /(?:_test|_spec|\.test|\.spec)\./.test(name) || /^test_.*\.py$/.test(name);
}

export function gitEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'));
  return { ...Object.fromEntries(inherited), GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', ...extra };
}

/** Config that turns off every filter driver and config-defined hook the checkout configures; read on each call so one added mid-session is covered. */
function withoutDrivers(root: string): Record<string, string> {
  const result = spawnSync('git', ['-C', root, 'config', '-z', '--name-only', '--get-regexp', '^(filter|hook)\\.'], { env: gitEnvironment(), maxBuffer: 1 << 24 });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error(`git config failed: ${result.stderr.toString('utf8').trim().slice(0, 300)}`);
  const names = nulList(result.stdout);
  const named = (section: string) => new Set(names.filter(name => name.startsWith(`${section}.`)).map(name => name.slice(section.length + 1, name.lastIndexOf('.'))).filter(Boolean));
  // Empty commands disable a driver; required=false keeps git from dying because the disabled driver did not run.
  const entries = [...named('filter')].flatMap(driver => [['clean', ''], ['smudge', ''], ['process', ''], ['required', 'false']].map(([key, value]) => [`filter.${driver}.${key}`, value]))
    // core.hooksPath covers only the hooks directory; hooks defined in config (hook.<name>.command) need disabling one by one.
    .concat([...named('hook'), 'post-index-change'].map(hook => [`hook.${hook}.enabled`, 'false']));
  return Object.fromEntries([['GIT_CONFIG_COUNT', String(entries.length)], ...entries.flatMap(([key, value], position) => [[`GIT_CONFIG_KEY_${position}`, key], [`GIT_CONFIG_VALUE_${position}`, value]])]);
}

export function git(root: string, args: string[], options: { input?: string; index?: string; codes?: number[] } = {}): Buffer {
  const result = spawnSync('git', ['-C', root, '-c', 'core.quotePath=true', '-c', 'core.fsmonitor=false', '-c', 'core.splitIndex=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    input: options.input, env: gitEnvironment({ ...withoutDrivers(root), ...(options.index ? { GIT_INDEX_FILE: options.index } : {}) }), maxBuffer: 1 << 30,
  });
  if (result.error) throw result.error;
  if (!(options.codes ?? [0]).includes(result.status ?? -1)) throw new Error(`git ${args[0]} failed: ${result.stderr.toString('utf8').trim().slice(0, 300)}`);
  return result.stdout;
}

export function withPrivateIndex<T>(root: string, use: (index: string) => T): T {
  const source = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).toString('utf8').trim();
  const directory = mkdtempSync(join(tmpdir(), 'review-tests-index-'));
  try {
    const index = join(directory, 'index');
    // git diff rewrites the index it reads after a stat refresh, even with GIT_OPTIONAL_LOCKS=0; a copy keeps the checkout untouched.
    copyFileSync(source, index, constants.COPYFILE_FICLONE);
    return use(index);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function parseRaw(bytes: Buffer): Raw[] {
  const parts = bytes.toString('utf8').split('\0');
  const entries: Raw[] = [];
  for (let position = 0; position + 1 < parts.length; position += 2) {
    const [srcMode, dstMode, srcBlob, dstBlob, status] = parts[position].slice(1).split(' ');
    entries.push({ srcMode, dstMode, srcBlob, dstBlob, status: status[0], path: parts[position + 1] });
  }
  return entries;
}

function unquote(name: string): string {
  if (!name.startsWith('"')) return name;
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const bytes: number[] = [];
  for (let position = 1; position < name.length - 1; position++) {
    if (name[position] !== '\\') bytes.push(name.charCodeAt(position));
    else if (/[0-7]/.test(name[position + 1])) { bytes.push(parseInt(name.slice(position + 1, position + 4), 8)); position += 3; }
    else bytes.push(escapes[name[++position]]);
  }
  return Buffer.from(bytes).toString('utf8');
}

export function parseRanges(patch: string): Map<string, [number, number][]> {
  const ranges = new Map<string, [number, number][]>();
  let current: [number, number][] | undefined;
  let pending = 0;
  for (const line of patch.split('\n')) {
    if (pending > 0 && /^[-+\\]/.test(line)) {
      if (line[0] !== '\\') pending--;
      continue;
    }
    pending = 0;
    if (line.startsWith('diff --git ')) current = undefined;
    else if (line.startsWith('+++ ')) {
      const name = unquote(line.slice(4).replace(/\t$/, ''));
      current = name === '/dev/null' ? undefined : [];
      if (current) ranges.set(name.replace(/^b\//, ''), current);
    } else {
      const hunk = line.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!hunk) continue;
      const removed = hunk[1] === undefined ? 1 : Number(hunk[1]);
      const added = hunk[3] === undefined ? 1 : Number(hunk[3]);
      pending = removed + added;
      if (added && current) current.push([Number(hunk[2]), Number(hunk[2]) + added - 1]);
    }
  }
  return ranges;
}

export function readObjects(root: string, names: string[]): Map<string, { type: string; bytes: Buffer } | null> {
  const objects = new Map<string, { type: string; bytes: Buffer } | null>();
  const unique = [...new Set(names)].filter(name => !name.includes('\n'));
  if (!unique.length) return objects;
  const output = git(root, ['cat-file', '--batch'], { input: unique.map(name => `${name}\n`).join('') });
  let offset = 0;
  for (const name of unique) {
    const end = output.indexOf(10, offset);
    const header = output.subarray(offset, end).toString('utf8').split(' ');
    offset = end + 1;
    if (header.length !== 3 || !/^\d+$/.test(header[2])) { objects.set(name, null); continue; }
    const size = Number(header[2]);
    objects.set(name, { type: header[1], bytes: output.subarray(offset, offset + size) });
    offset += size + 1;
  }
  return objects;
}

export function readRegular(path: string, limit = 4_194_304): Buffer | null {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat?.isFile() && stat.size <= limit ? readFileSync(path) : null;
}
export const textOf = (bytes: Buffer | null) => !bytes || bytes.subarray(0, 8000).includes(0) ? null : bytes.toString('utf8');

export function boundedRead(path: string, limit = 4_194_304): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error(`${basename(path)} must be a regular file of at most ${limit} bytes`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

export function removeTree(path: string): void {
  try { rmSync(path, { recursive: true, force: true }); return; } catch { /* Read-only directories and immutable flags have to go before the entries can. */ }
  if (lstatSync(path, { throwIfNoEntry: false })) spawnSync('/usr/bin/chflags', ['-R', '-P', 'nouchg,nouappnd', path]);
  const open = (directory: string) => {
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory)) if (lstatSync(join(directory, entry)).isDirectory()) open(join(directory, entry));
  };
  if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) open(path);
  rmSync(path, { recursive: true, force: true });
}

export function resolveTarget(preflight: unknown): Target {
  const { provider, base, head, checkout } = (preflight && typeof preflight === 'object' ? preflight : {}) as Record<string, unknown>;
  if (!['github', 'meteorite', 'local'].includes(String(provider)) || typeof checkout !== 'string' || !isAbsolute(checkout)) {
    throw new Error('The review preflight has no usable provider and checkout.');
  }
  const root = realpathSync(git(checkout, ['rev-parse', '--show-toplevel']).toString('utf8').trim());
  if (provider === 'local') {
    if (typeof head !== 'string' || !commitPattern.test(head)) throw new Error('The local review HEAD is unresolved in preflight.');
    const current = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).toString('utf8').trim();
    if (current !== head) throw new Error('HEAD moved since preflight.');
    return { root, base: current, head: current, headState: 'working-tree' };
  }
  if (typeof base !== 'string' || typeof head !== 'string' || !commitPattern.test(base) || !commitPattern.test(head)) {
    throw new Error('The PR base or head is unresolved in preflight.');
  }
  for (const [label, commit] of [['base', base], ['head', head]]) {
    if (!hasCommit(root, commit)) throw new Error(`The PR ${label} commit ${commit} is missing from the checkout.`);
  }
  const mergeBase = git(root, ['merge-base', base, head], { codes: [0, 1] }).toString('utf8').trim();
  if (!commitPattern.test(mergeBase)) throw new Error('The PR base and head share no merge base.');
  return { root, base: mergeBase, head, headState: 'commit' };
}
const hasCommit = (root: string, commit: string) => {
  try { git(root, ['cat-file', '-e', `${commit}^{commit}`]); return true; } catch { return false; }
};

function ancestors(path: string): string[] {
  const directories: string[] = [];
  for (let directory = dirname(path); directory !== '.'; directory = dirname(directory)) directories.push(directory);
  return [...directories, ''];
}

function componentsOf(target: Target, paths: string[]): string[] {
  const candidates = [...new Set(paths.flatMap(ancestors))];
  const listings = new Map<string, string[]>();
  if (target.headState === 'commit') {
    const name = (directory: string) => directory ? `${target.head}:${directory}` : `${target.head}^{tree}`;
    const objects = readObjects(target.root, candidates.map(name));
    const hashBytes = target.head.length / 2;
    for (const directory of candidates) {
      const tree = objects.get(name(directory));
      if (tree?.type !== 'tree') continue;
      const names: string[] = [];
      for (let offset = 0; offset < tree.bytes.length;) {
        const space = tree.bytes.indexOf(32, offset);
        const end = tree.bytes.indexOf(0, space);
        if (!['40000', '160000'].includes(tree.bytes.subarray(offset, space).toString())) names.push(tree.bytes.subarray(space + 1, end).toString('utf8'));
        offset = end + 1 + hashBytes;
      }
      listings.set(directory, names);
    }
  } else {
    for (const directory of candidates) {
      try { listings.set(directory, readdirSync(join(target.root, directory), { withFileTypes: true }).filter(entry => !entry.isDirectory()).map(entry => entry.name)); }
      catch { /* A changed path whose directory is gone has no marker here. */ }
    }
  }
  const nearest = [...new Set(paths.map(path => ancestors(path).find(directory => listings.get(directory)?.some(isMarker)) ?? ''))];
  return nearest.filter(directory => !nearest.some(other => other !== directory && (other === '' || directory.startsWith(`${other}/`)))).sort();
}

export function analyzeTarget(target: Target): Analysis {
  const { root, base, head, headState } = target;
  const range = headState === 'commit' ? [base, head] : [base];
  const read = (index?: string) => ({
    raw: parseRaw(git(root, ['diff', '--raw', '-z', '--no-abbrev', ...diffOptions, ...range], { index })),
    ranges: parseRanges(git(root, ['diff', '-U0', '--inter-hunk-context=0', '--src-prefix=a/', '--dst-prefix=b/', ...diffOptions, ...range], { index }).toString('utf8')),
    untracked: index ? nulList(git(root, ['ls-files', '--others', '--exclude-standard', '-z'], { index })).filter(path => !path.endsWith('/')) : [],
  });
  const { raw, ranges, untracked } = headState === 'commit' ? read() : withPrivateIndex(root, read);
  const files = new Map<string, ChangedFile>();
  for (const entry of raw) {
    if (entry.srcMode === '160000' || entry.dstMode === '160000') continue;
    const status = entry.status === 'A' ? 'added' : entry.status === 'D' ? 'deleted' : 'modified';
    files.set(entry.path, {
      path: entry.path, status, test: isTestPath(entry.path), ranges: ranges.get(entry.path) ?? [],
      baseMode: status === 'added' ? null : entry.srcMode, baseBlob: status === 'added' ? null : entry.srcBlob,
      headMode: status === 'deleted' ? null : entry.dstMode, headBlob: status === 'deleted' || headState !== 'commit' ? null : entry.dstBlob,
    });
  }
  for (const path of untracked) {
    const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
    if (!stat) continue;
    const prior = files.get(path);
    const text = textOf(readRegular(join(root, path)));
    const lines = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
    files.set(path, { path, status: prior ? 'modified' : 'added', test: isTestPath(path), ranges: lines ? [[1, lines]] : [],
      baseMode: prior?.baseMode ?? null, baseBlob: prior?.baseBlob ?? null, headMode: modeOf(stat), headBlob: null });
  }
  const changed = [...files.values()].sort((left, right) => left.path < right.path ? -1 : 1);
  return { ...target, components: changed.length ? componentsOf(target, changed.map(file => file.path)) : [], files: changed };
}

export const componentOf = (components: string[], path: string) => components.find(component => !component || path === component || path.startsWith(`${component}/`));

export function suggestTests(analysis: Analysis): string[] {
  const { root, head, headState, components, files } = analysis;
  const stem = (path: string) => basename(path).replace(/^\.+/, '').split('.')[0].toLowerCase();
  const changed = files.filter(file => file.test && file.status !== 'deleted').map(file => file.path);
  const stems = [...new Set(files.filter(file => !file.test).map(file => stem(file.path)).filter(value => value.length >= 3))];
  if (!components.length || !stems.length) return changed.slice(0, 20);
  const specs = components.map(component => component || '.');
  const tracked = nulList(headState === 'commit' ? git(root, ['ls-tree', '-r', '--name-only', '-z', head, '--', ...specs]) : git(root, ['ls-files', '-z', '--', ...specs]));
  const seen = new Set(changed);
  const related = tracked.filter(path => isTestPath(path) && !seen.has(path) && stems.some(value => stem(path).includes(value))).sort();
  return [...changed, ...related].slice(0, 20);
}

/** PR reviews read head blobs; local reviews read the workspace copy once it exists, else the checkout. */
export function headReader(analysis: Analysis, workspace?: string): (file: ChangedFile) => Buffer | null {
  if (analysis.headState === 'working-tree') {
    const from = workspace && existsSync(workspace) ? workspace : analysis.root;
    return file => readRegular(join(from, file.path));
  }
  const blobs = readObjects(analysis.root, analysis.files.filter(file => file.headBlob && !file.test && file.ranges.length).map(file => file.headBlob!));
  return file => file.headBlob ? blobs.get(file.headBlob)?.bytes ?? null : null;
}

export function breakCandidates(analysis: Analysis, read: (file: ChangedFile) => Buffer | null): { path: string; line: number; text: string }[] {
  const candidates: { path: string; line: number; text: string }[] = [];
  for (const file of analysis.files) {
    if (file.test || file.status === 'deleted' || !file.ranges.length || file.headMode === '120000' || proseOrData.test(file.path)) continue;
    const text = textOf(read(file));
    if (text === null) continue;
    const lines = text.split('\n');
    for (const [start, end] of file.ranges) {
      for (let line = start; line <= end; line++) {
        const value = (lines[line - 1] ?? '').trim();
        if (!controlFlow.test(value)) continue;
        candidates.push({ path: file.path, line, text: value.slice(0, 200) });
        if (candidates.length === 40) return candidates;
      }
    }
  }
  return candidates;
}

export function gradeRun(kind: Kind, status: string, exitCode: number | null): { outcome: string; grade: string } {
  if (status !== 'completed') return { outcome: 'unknown', grade: 'unknown' };
  const zero = exitCode === 0;
  const [outcome, grade] = {
    baseline: zero ? ['passed', 'pass'] : ['failed', 'fail'],
    revert: zero ? ['passed-without-change', 'fail'] : ['failed-without-change', 'pass'],
    break: zero ? ['survived', 'fail'] : ['killed', 'pass'],
    edge: zero ? ['holds', 'pass'] : ['breaks', 'counterexample'],
  }[kind];
  return { outcome, grade };
}

export function verifyTestRuns(directory: string, runId: string): { summary: null | { path: string; runs: number; sandbox: boolean; outcomes: Record<string, Record<string, number>>; receipts: string[] }; problems: string[] } {
  if (!idPattern.test(runId)) throw new Error('Invalid test-run identity.');
  const path = join(directory, `${runId}.tests.json`);
  if (!existsSync(path)) return { summary: null, problems: [] };
  const problems = existsSync(join(directory, `${runId}.tests.active`)) ? [`A test run is still in flight (${runId}.tests.active); finish or recover it before completion.`] : [];
  let index;
  try { index = JSON.parse(boundedRead(path).toString('utf8')); } catch (error) {
    return { summary: null, problems: [...problems, `${runId}.tests.json is unreadable: ${error instanceof Error ? error.message : String(error)}.`] };
  }
  if (index?.schemaVersion !== 1 || index.runId !== runId || !Array.isArray(index.runs)) return { summary: null, problems: [...problems, `${runId}.tests.json has the wrong identity.`] };
  const outcomes: Record<string, Record<string, number>> = {};
  const receipts: string[] = [];
  index.runs.forEach((run: { index?: unknown; kind?: string; outcome?: string; grade?: string; receipt?: { path?: unknown; sha256?: unknown } }, position: number) => {
    const label = `Test run ${position + 1}`;
    const reference = typeof run?.receipt?.path === 'string' ? run.receipt.path.match(new RegExp(`^${runId}\\.tests/${position + 1}-(baseline|revert|break|edge)/receipt\\.json$`)) : null;
    if (!reference || run.index !== position + 1 || reference[1] !== run.kind || typeof run.outcome !== 'string') { problems.push(`${label} has an invalid receipt reference.`); return; }
    outcomes[run.kind] ??= {};
    outcomes[run.kind][run.outcome] = (outcomes[run.kind][run.outcome] ?? 0) + 1;
    const receiptPath = join(directory, reference[0]);
    try {
      const bytes = boundedRead(receiptPath);
      if (digest(bytes) !== run.receipt?.sha256) throw new Error('receipt.json changed');
      const receipt = JSON.parse(bytes.toString('utf8'));
      if (receipt.schemaVersion !== 1 || receipt.runId !== runId || receipt.index !== run.index || receipt.kind !== run.kind
        || receipt.outcome !== run.outcome || receipt.grade !== run.grade) throw new Error('receipt identity does not match the index');
      for (const [file, key] of [['stdout.txt', 'stdoutSha256'], ['stderr.txt', 'stderrSha256'], ['change.diff', 'changeSha256']]) {
        if (digest(boundedRead(join(dirname(receiptPath), file))) !== receipt[key]) throw new Error(`${file} changed`);
      }
      receipts.push(receiptPath);
    } catch (error) { problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}.`); }
  });
  return { summary: { path, runs: index.runs.length, sandbox: index.settings?.sandbox === true, outcomes, receipts }, problems };
}

/** Moving the folder first puts every path a run's sandbox named out of reach of processes that outlived it before the tree is walked. */
export function removeTestWorkspace(directory: string, runId: string): void {
  if (!idPattern.test(runId)) throw new Error('Invalid test-run identity.');
  const folder = join(directory, `${runId}.tests`);
  for (const name of ['workspaces', 'workspace']) {
    if (!lstatSync(join(folder, name), { throwIfNoEntry: false })) continue;
    const removing = join(folder, `.removing-${randomUUID()}`);
    renameSync(join(folder, name), removing);
    removeTree(removing);
  }
}
