import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { analyzeTarget, breakCandidates, gradeRun, headReader, isTestPath, parseRanges, removeTestWorkspace, removeTree, resolveTarget, suggestTests } from '../src/review-tests.ts';
import { applyChange, buildWorkspace, guardPath, resetTemporary, resolveCwd, rotateWorkspace, runCommand, sandboxProfile, testEnvironment } from '../src/review-tests-workspace.ts';

const darwin = process.platform === 'darwin';
const developer = darwin ? spawnSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' }).stdout?.trim() : '';
// /usr/bin/python3 is a shim that offers to install the developer tools when they are missing, so only real interpreters count.
const python = [developer && join(developer, 'usr/bin/python3'), '/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find(path => path && existsSync(path));
const settings = ['-c', 'user.name=Review Tests', '-c', 'user.email=review-tests@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
const git = (cwd, ...args) => execFileSync('git', [...settings, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const alive = pid => !['', 'Z'].includes(spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim().slice(0, 1));

function temporary(t, prefix) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) { rmSync(join(root, path), { force: true }); continue; }
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function fingerprint(root) {
  const lines = [];
  const visit = relative => {
    const path = relative ? join(root, relative) : root;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) lines.push(`${relative} -> ${readlinkSync(path)}`);
    else if (stat.isDirectory()) {
      lines.push(`${relative}/ ${stat.mode & 0o7777}`);
      for (const entry of readdirSync(path).sort()) visit(relative ? `${relative}/${entry}` : entry);
    } else lines.push(`${relative} ${stat.mode & 0o7777} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
  };
  visit('');
  return lines.join('\n');
}

const baseFiles = {
  'package.json': '{"name":"fixture"}\n',
  '.gitignore': 'node_modules/\n',
  'README.md': 'fixture\n',
  'packages/limits/package.json': '{"name":"limits","type":"module"}\n',
  'packages/limits/src/limit.js': 'export function clamp(value, max) {\n  return value;\n}\n',
  'packages/limits/src/old.js': 'export const old = true;\n',
  'packages/limits/test/limit.test.js': '// base test\n',
  'packages/limits/test/limit_edge.test.js': '// edge test\n',
  'packages/limits/vendor/sub/package.json': '{}\n',
  'packages/limits/vendor/sub/index.js': 'module.exports = 1;\n',
  'packages/other/package.json': '{}\n',
  'packages/other/test/limit.test.js': '// other\n',
};
const headLimit = "export function clamp(value, max) {\n  if (value > max) return max;\n  if (value == null) throw new Error('value');\n  return value;\n}\n";
const headFiles = {
  'packages/limits/src/limit.js': headLimit,
  'packages/limits/src/guard.js': 'export const guard = value => value ?? 0;\n',
  'packages/limits/src/old.js': null,
  'packages/limits/src/odd "name".js': 'if (ready) start();\n',
  'packages/limits/test/limit.test.js': '// head test\n',
  'packages/limits/test/guard.test.js': '// guard test\n',
  'packages/limits/vendor/sub/index.js': 'module.exports = 2;\n',
  'packages/limits/run.sh': '#!/bin/sh\necho run\n',
  'packages/limits/NOTES.md': 'if the limit is null, return early\n',
};

function repository(t) {
  const base = temporary(t, 'review-tests-repo-');
  const repo = join(base, 'repo');
  const outside = join(base, 'outside');
  const history = join(base, 'history');
  for (const path of [repo, outside, history]) mkdirSync(path);
  git(repo, 'init', '-q', '-b', 'main');
  writeFiles(repo, baseFiles);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const baseCommit = git(repo, 'rev-parse', 'HEAD');
  writeFiles(repo, headFiles);
  chmodSync(join(repo, 'packages/limits/run.sh'), 0o755);
  symlinkSync(outside, join(repo, 'packages/limits/escape'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'head');
  const head = git(repo, 'rev-parse', 'HEAD');
  return { repo, outside, history, base: baseCommit, head, preflight: { provider: 'github', base: baseCommit, head, checkout: repo } };
}

test('the test-file rule matches test directories and framework file names only', () => {
  for (const path of ['test/a.js', 'src/__tests__/a.js', 'spec/models/user.rb', 'pkg/tests/x.py', 'a/user_test.rb', 'a/user_spec.rb', 'a/limit.test.mjs', 'a/limit.spec.ts', 'test_user.py', 'x/test_user.py']) {
    assert.equal(isTestPath(path), true, path);
  }
  for (const path of ['src/limit.js', 'bin/test', 'src/testing.js', 'src/latest.js', 'contest/a.js', 'test_user.rb', 'src/spectrum.js']) assert.equal(isTestPath(path), false, path);
});

test('head ranges survive added lines that look like diff headers and quoted paths', () => {
  const patch = [
    'diff --git a/x.js b/x.js', '--- a/x.js', '+++ b/x.js', '@@ -1,0 +2,2 @@', '++++ b/fake.js', '+@@ -9 +9 @@',
    'diff --git "a/odd \\"name\\".js" "b/odd \\"name\\".js"', '--- "a/odd \\"name\\".js"', '+++ "b/odd \\"name\\".js"', '@@ -3 +3 @@', '-a', '+b',
    'diff --git a/caf\\303\\251.js b/caf\\303\\251.js', '--- "a/caf\\303\\251.js"', '+++ "b/caf\\303\\251.js"', '@@ -1,2 +0,0 @@', '-a', '-b', '@@ -5 +4,3 @@', '-c', '+d', '+e', '+f',
    'diff --git a/gone.js b/gone.js', '--- a/gone.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-x',
  ].join('\n');
  assert.deepEqual(Object.fromEntries(parseRanges(patch)), { 'x.js': [[2, 3]], 'odd "name".js': [[3, 3]], 'café.js': [[4, 6]] });
});

test('a PR review lists changed files, head ranges, the outermost component, suggested tests and break candidates', t => {
  const f = repository(t);
  git(f.repo, 'checkout', '-q', '-b', 'side', f.base);
  writeFiles(f.repo, { 'README.md': 'base moved on\n' });
  git(f.repo, 'commit', '-q', '-am', 'side');
  const analysis = analyzeTarget(resolveTarget({ ...f.preflight, base: git(f.repo, 'rev-parse', 'HEAD') }));
  assert.deepEqual({ base: analysis.base, head: analysis.head, headState: analysis.headState, components: analysis.components },
    { base: f.base, head: f.head, headState: 'commit', components: ['packages/limits'] });
  assert.deepEqual(Object.fromEntries(analysis.files.map(file => [file.path, [file.status, file.test, file.ranges]])), {
    'packages/limits/NOTES.md': ['added', false, [[1, 1]]],
    'packages/limits/escape': ['added', false, [[1, 1]]],
    'packages/limits/run.sh': ['added', false, [[1, 2]]],
    'packages/limits/src/guard.js': ['added', false, [[1, 1]]],
    'packages/limits/src/limit.js': ['modified', false, [[2, 3]]],
    'packages/limits/src/odd "name".js': ['added', false, [[1, 1]]],
    'packages/limits/src/old.js': ['deleted', false, []],
    'packages/limits/test/guard.test.js': ['added', true, [[1, 1]]],
    'packages/limits/test/limit.test.js': ['modified', true, [[1, 1]]],
    'packages/limits/vendor/sub/index.js': ['modified', false, [[1, 1]]],
  });
  assert.deepEqual(suggestTests(analysis), ['packages/limits/test/guard.test.js', 'packages/limits/test/limit.test.js', 'packages/limits/test/limit_edge.test.js']);
  assert.deepEqual(breakCandidates(analysis, headReader(analysis)), [
    { path: 'packages/limits/src/guard.js', line: 1, text: 'export const guard = value => value ?? 0;' },
    { path: 'packages/limits/src/limit.js', line: 2, text: 'if (value > max) return max;' },
    { path: 'packages/limits/src/limit.js', line: 3, text: "if (value == null) throw new Error('value');" },
    { path: 'packages/limits/src/odd "name".js', line: 1, text: 'if (ready) start();' },
  ]);
  assert.throws(() => resolveTarget({ ...f.preflight, base: 'unresolved' }), /unresolved in preflight/);
  assert.throws(() => resolveTarget({ ...f.preflight, head: 'f'.repeat(40) }), /head commit f+ is missing from the checkout/);
  assert.throws(() => resolveTarget({ ...f.preflight, provider: 'gitlab' }), /no usable provider/);
});

test('a local review covers the working tree against HEAD, untracked files included, without touching the index', t => {
  const f = repository(t);
  git(f.repo, 'checkout', '-q', '--detach', f.base);
  writeFiles(f.repo, {
    'packages/limits/src/limit.js': headLimit, 'packages/limits/src/guard.js': 'export const guard = value => value ?? 0;\n',
    'packages/limits/src/old.js': null, 'packages/limits/test/guard.test.js': '// guard test\n', 'packages/limits/node_modules/dep/index.js': 'dep\n',
  });
  utimesSync(join(f.repo, 'README.md'), new Date(), new Date(Date.now() + 60000));
  const before = fingerprint(f.repo);
  const preflight = { provider: 'local', base: 'HEAD', head: f.base, checkout: join(f.repo, 'packages') };
  const analysis = analyzeTarget(resolveTarget(preflight));
  assert.deepEqual({ base: analysis.base, head: analysis.head, headState: analysis.headState, components: analysis.components },
    { base: f.base, head: f.base, headState: 'working-tree', components: ['packages/limits'] });
  assert.deepEqual(Object.fromEntries(analysis.files.map(file => [file.path, [file.status, file.test, file.ranges]])), {
    'packages/limits/src/guard.js': ['added', false, [[1, 1]]],
    'packages/limits/src/limit.js': ['modified', false, [[2, 3]]],
    'packages/limits/src/old.js': ['deleted', false, []],
    'packages/limits/test/guard.test.js': ['added', true, [[1, 1]]],
  });
  const workspace = buildWorkspace(analysis, join(f.history, 'local.tests', 'workspaces'));
  assert.equal(readFileSync(join(workspace, 'packages/limits/src/guard.js'), 'utf8'), 'export const guard = value => value ?? 0;\n');
  assert.equal(readFileSync(join(workspace, 'packages/limits/node_modules/dep/index.js'), 'utf8'), 'dep\n');
  assert.equal(existsSync(join(workspace, 'packages/limits/src/old.js')), false);
  assert.equal(fingerprint(f.repo), before, 'Analysis and the workspace build must not write to the checkout or its index.');
  git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'later');
  assert.throws(() => resolveTarget(preflight), /HEAD moved since preflight/);
});

test('a PR workspace clones components, links siblings, drops .git and overlays head over a checkout at base', t => {
  const f = repository(t);
  git(f.repo, 'checkout', '-q', '--detach', f.base);
  writeFiles(f.repo, {
    'packages/limits/src/limit.js': 'junk edit\n', 'packages/limits/src/junk.js': 'junk\n',
    'packages/limits/node_modules/dep/index.js': 'dep\n', 'packages/other/untracked.txt': 'untracked\n',
  });
  const before = fingerprint(f.repo);
  const analysis = analyzeTarget(resolveTarget(f.preflight));
  const workspace = buildWorkspace(analysis, join(f.history, 'run.tests', 'workspaces'));
  assert.deepEqual(readdirSync(join(f.history, 'run.tests', 'workspaces')), [workspace.split('/').pop()]);
  assert.equal(existsSync(join(workspace, '.git')), false);
  for (const entry of ['README.md', 'package.json', '.gitignore', 'packages/other']) {
    assert.equal(readlinkSync(join(workspace, entry)), join(f.repo, entry), entry);
  }
  assert.ok(lstatSync(join(workspace, 'packages')).isDirectory() && lstatSync(join(workspace, 'packages/limits')).isDirectory());
  for (const [path, content] of Object.entries(headFiles)) {
    if (content === null) assert.equal(existsSync(join(workspace, path)), false, path);
    else assert.equal(readFileSync(join(workspace, path), 'utf8'), content, path);
  }
  assert.equal(readFileSync(join(workspace, 'packages/limits/test/limit_edge.test.js'), 'utf8'), '// edge test\n');
  assert.equal(existsSync(join(workspace, 'packages/limits/src/junk.js')), false);
  assert.equal(readFileSync(join(workspace, 'packages/limits/node_modules/dep/index.js'), 'utf8'), 'dep\n');
  assert.equal(lstatSync(join(workspace, 'packages/limits/run.sh')).mode & 0o777, 0o755);
  assert.equal(readlinkSync(join(workspace, 'packages/limits/escape')), f.outside);
  assert.equal(fingerprint(f.repo), before);
});

test('a component that exists only at head is created and filled from head blobs', t => {
  const f = repository(t);
  writeFiles(f.repo, { 'packages/fresh/package.json': '{}\n', 'packages/fresh/src/start.js': 'if (ready) start();\n' });
  git(f.repo, 'add', '-A');
  git(f.repo, 'commit', '-q', '-m', 'fresh');
  const head = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'checkout', '-q', '--detach', f.base);
  const before = fingerprint(f.repo);
  const analysis = analyzeTarget(resolveTarget({ ...f.preflight, head }));
  assert.deepEqual(analysis.components, ['packages/fresh', 'packages/limits']);
  const workspace = buildWorkspace(analysis, join(f.history, 'fresh.tests', 'workspaces'));
  assert.ok(lstatSync(join(workspace, 'packages/fresh')).isDirectory());
  assert.equal(readFileSync(join(workspace, 'packages/fresh/src/start.js'), 'utf8'), 'if (ready) start();\n');
  assert.equal(readFileSync(join(workspace, 'packages/limits/src/limit.js'), 'utf8'), headLimit);
  assert.equal(readlinkSync(join(workspace, 'packages/other')), join(f.repo, 'packages/other'));
  assert.equal(resolveCwd(workspace, analysis.components, 'packages/fresh/src'), join(workspace, 'packages/fresh/src'));
  assert.throws(() => resolveCwd(workspace, analysis.components, '.'), /outside the copied components/);
  assert.throws(() => resolveCwd(workspace, analysis.components, 'packages/other'), /outside the copied components/);
  assert.equal(fingerprint(f.repo), before);
});

test('a tracked symlink cannot redirect a workspace write into the checkout or outside', t => {
  const f = repository(t);
  const analysis = analyzeTarget(resolveTarget(f.preflight));
  const workspace = buildWorkspace(analysis, join(f.history, 'run.tests', 'workspaces'));
  const before = fingerprint(f.repo);
  for (const parents of ['existing', 'optional', 'create']) {
    assert.throws(() => guardPath(workspace, 'packages/limits/escape/pwned.txt', parents), /passes through a symlink/);
    assert.throws(() => guardPath(workspace, 'packages/other/pwned.txt', parents), /passes through a symlink/);
  }
  for (const path of ['../pwned.txt', '/tmp/pwned.txt', 'packages/./limits/x', 'packages//x', 'a\\b', '']) assert.throws(() => guardPath(workspace, path, 'create'), /Unsafe workspace path/);
  assert.throws(() => applyChange(workspace, analysis, 'edge', { path: 'packages/limits/escape/pwned.test.js', content: 'x', codePath: 'escape' }), /passes through a symlink/);
  assert.deepEqual(readdirSync(f.outside), []);
  const broken = applyChange(workspace, analysis, 'break', { path: 'packages/limits/src/limit.js', line: 2, before: 'value > max', after: 'false', safeguard: 'upper clamp' });
  const decoy = join(f.outside, 'src');
  mkdirSync(decoy);
  writeFileSync(join(decoy, 'limit.js'), 'decoy\n');
  rmSync(join(workspace, 'packages/limits/src'), { recursive: true });
  symlinkSync(decoy, join(workspace, 'packages/limits/src'));
  assert.throws(() => broken.restore(), /passes through a symlink/);
  assert.equal(readFileSync(join(decoy, 'limit.js'), 'utf8'), 'decoy\n');
  assert.equal(fingerprint(f.repo), before);
  removeTestWorkspace(f.history, 'run');
  assert.deepEqual(readdirSync(join(f.history, 'run.tests')), []);
  assert.equal(readFileSync(join(decoy, 'limit.js'), 'utf8'), 'decoy\n');
  assert.equal(fingerprint(f.repo), before, 'Removing the workspace must not follow its links into the checkout.');
});

test('git reads run no filter driver or hook the checkout configures', t => {
  const f = repository(t);
  const markers = join(dirname(f.repo), 'markers');
  mkdirSync(markers);
  const mark = name => `sh -c 'touch "${markers}/${name}"; cat'`;
  writeFiles(f.repo, { '.gitattributes': '*.js filter=mark\n*.md filter=dotted.name\n' });
  git(f.repo, 'config', 'filter.mark.clean', mark('clean'));
  git(f.repo, 'config', 'filter.mark.smudge', mark('smudge'));
  git(f.repo, 'config', 'filter.mark.required', 'true');
  git(f.repo, 'config', 'filter.dotted.name.process', `sh -c 'touch "${markers}/process"; exit 1'`);
  git(f.repo, 'config', 'core.hooksPath', join(f.repo, '.git/hooks'));
  mkdirSync(join(f.repo, '.git/hooks'), { recursive: true });
  writeFileSync(join(f.repo, '.git/hooks/post-index-change'), `#!/bin/sh\ntouch "${markers}/hook"\n`, { mode: 0o755 });
  git(f.repo, 'config', 'hook.mark.event', 'post-index-change');
  git(f.repo, 'config', 'hook.mark.command', `touch "${markers}/config-hook"`);
  const later = new Date(Date.now() + 120000);
  for (const path of ['README.md', 'package.json', 'packages/limits/src/limit.js']) utimesSync(join(f.repo, path), later, later);
  const pr = analyzeTarget(resolveTarget(f.preflight));
  suggestTests(pr);
  breakCandidates(pr, headReader(pr));
  buildWorkspace(pr, join(f.history, 'pr.tests', 'workspaces'));
  writeFiles(f.repo, { 'packages/limits/src/limit.js': 'export const limit = 1;\n', 'packages/limits/NOTES.md': 'changed\n' });
  const local = analyzeTarget(resolveTarget({ provider: 'local', base: 'HEAD', head: f.head, checkout: f.repo }));
  assert.deepEqual(local.files.map(file => file.path), ['.gitattributes', 'packages/limits/NOTES.md', 'packages/limits/src/limit.js']);
  suggestTests(local);
  breakCandidates(local, headReader(local));
  buildWorkspace(local, join(f.history, 'local.tests', 'workspaces'));
  assert.deepEqual(readdirSync(markers), [], 'Analysis and workspace builds must not run filters or hooks from the checkout.');
});

test('git reads never fetch missing objects into a partial clone', t => {
  const f = repository(t);
  git(f.repo, 'config', 'uploadpack.allowFilter', 'true');
  git(f.repo, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const clone = join(dirname(f.repo), 'partial');
  git(dirname(f.repo), 'clone', '-q', '--no-local', '--filter=blob:none', '--no-checkout', `file://${f.repo}`, clone);
  const before = fingerprint(join(clone, '.git'));
  assert.throws(() => analyzeTarget(resolveTarget({ ...f.preflight, checkout: clone })), /could not fetch [0-9a-f]+ from promisor remote/);
  assert.equal(fingerprint(join(clone, '.git')), before);
});

test('revert, break and edge changes are validated, written only to the workspace and restored exactly', t => {
  const f = repository(t);
  const before = fingerprint(f.repo);
  const analysis = analyzeTarget(resolveTarget(f.preflight));
  const workspace = buildWorkspace(analysis, join(f.history, 'run.tests', 'workspace'));
  const component = () => fingerprint(join(workspace, 'packages/limits'));
  const pristine = component();
  const read = path => readFileSync(join(workspace, path), 'utf8');

  const revert = applyChange(workspace, analysis, 'revert', null);
  assert.equal(read('packages/limits/src/limit.js'), baseFiles['packages/limits/src/limit.js']);
  assert.equal(read('packages/limits/src/old.js'), baseFiles['packages/limits/src/old.js']);
  assert.equal(read('packages/limits/vendor/sub/index.js'), baseFiles['packages/limits/vendor/sub/index.js']);
  for (const path of ['packages/limits/src/guard.js', 'packages/limits/run.sh', 'packages/limits/escape']) assert.equal(lstatSync(join(workspace, path), { throwIfNoEntry: false }), undefined, path);
  assert.equal(read('packages/limits/test/limit.test.js'), '// head test\n');
  assert.match(revert.diff, /^diff --git a\/packages\/limits\/src\/limit\.js b\/packages\/limits\/src\/limit\.js$/m);
  assert.match(revert.diff, /^-  if \(value > max\) return max;$/m);
  assert.match(revert.diff, /^deleted file mode 100755$/m);
  revert.restore();
  assert.equal(component(), pristine);

  const mutation = { path: 'packages/limits/src/limit.js', line: 2, before: 'value > max', after: 'false', safeguard: 'the upper clamp' };
  const broken = applyChange(workspace, analysis, 'break', mutation);
  assert.equal(read('packages/limits/src/limit.js'), headLimit.replace('value > max', 'false'));
  assert.match(broken.diff, /^-  if \(value > max\) return max;\n\+  if \(false\) return max;$/m);
  broken.restore();
  assert.equal(component(), pristine);
  const rejected = [
    [{ ...mutation, line: 1 }, /outside the changed lines/],
    [{ ...mutation, before: 'absent' }, /exactly once/],
    [{ ...mutation, line: 3, before: 'value' }, /exactly once/],
    [{ ...mutation, after: 'value > max' }, /different one-line/],
    [{ ...mutation, after: 'a\nb' }, /different one-line/],
    [{ ...mutation, before: 'x'.repeat(501) }, /at most 500/],
    [{ ...mutation, path: 'packages/limits/test/limit.test.js', line: 1, before: 'head' }, /non-test file/],
    [{ ...mutation, path: 'packages/limits/src/old.js', line: 1, before: 'old' }, /exists at head/],
    [{ ...mutation, safeguard: ' ' }, /safeguard/],
    [{ ...mutation, extra: true }, /needs exactly/],
  ];
  for (const [change, pattern] of rejected) assert.throws(() => applyChange(workspace, analysis, 'break', change), pattern, JSON.stringify(change));

  const edge = { path: 'packages/limits/test/edge/clamp.test.js', content: 'probe\n', codePath: 'clamp upper bound' };
  const probe = applyChange(workspace, analysis, 'edge', edge);
  assert.equal(read(edge.path), 'probe\n');
  assert.match(probe.diff, /^new file mode 100644$/m);
  probe.restore();
  assert.equal(existsSync(join(workspace, 'packages/limits/test/edge')), false);
  assert.equal(component(), pristine);
  for (const [change, pattern] of [
    [{ ...edge, path: 'packages/limits/test/limit.test.js' }, /already exists/],
    [{ ...edge, path: 'packages/limits/src/probe.js' }, /test file path/],
    [{ ...edge, path: 'packages/other/test/probe.test.js' }, /outside the copied components/],
    [{ ...edge, content: 'x'.repeat(65537) }, /64 KiB/],
    [{ ...edge, codePath: '' }, /code path/],
  ]) assert.throws(() => applyChange(workspace, analysis, 'edge', change), pattern, change.path);
  assert.equal(component(), pristine);
  assert.equal(fingerprint(f.repo), before);
});

test('grades follow the check contract and anything but a completed run is unknown', () => {
  const table = [
    ['baseline', 0, 'passed', 'pass'], ['baseline', 1, 'failed', 'fail'],
    ['revert', 1, 'failed-without-change', 'pass'], ['revert', 0, 'passed-without-change', 'fail'],
    ['break', 1, 'killed', 'pass'], ['break', 0, 'survived', 'fail'], ['break', null, 'killed', 'pass'],
    ['edge', 0, 'holds', 'pass'], ['edge', 1, 'breaks', 'counterexample'],
  ];
  for (const [kind, exitCode, outcome, grade] of table) assert.deepEqual(gradeRun(kind, 'completed', exitCode), { outcome, grade }, `${kind} ${exitCode}`);
  for (const status of ['timeout', 'cancelled', 'spawn_error', 'interrupted']) assert.deepEqual(gradeRun('break', status, 0), { outcome: 'unknown', grade: 'unknown' });
});

test('the runner kills the whole process group on timeout and escalates to SIGKILL', async t => {
  const directory = temporary(t, 'review-tests-run-');
  const pidFile = join(directory, 'pid');
  const result = await runCommand({ command: ['/bin/sh', '-c', `trap '' TERM; sleep 30 & echo $! > '${pidFile}'; wait`], cwd: directory,
    env: process.env, timeoutMs: 300, killAfterMs: 300, profile: null });
  assert.equal(result.status, 'timeout');
  assert.ok(result.durationMs >= 550 && result.durationMs < 10000, String(result.durationMs));
  assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false);
});

test('the runner sweeps background processes when the leader exits and reports spawn errors and cancellation', async t => {
  const directory = temporary(t, 'review-tests-run-');
  const pidFile = join(directory, 'pid');
  const leftover = await runCommand({ command: ['/bin/sh', '-c', `sleep 30 & echo $! > '${pidFile}'; echo started`], cwd: directory, env: process.env, timeoutMs: 20000, profile: null });
  assert.deepEqual([leftover.status, leftover.exitCode, leftover.tail], ['completed', 0, 'started']);
  assert.ok(leftover.durationMs < 10000, String(leftover.durationMs));
  assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false);
  const missing = await runCommand({ command: ['review-tests-no-such-program'], cwd: directory, env: process.env, timeoutMs: 1000, profile: null });
  assert.deepEqual([missing.status, missing.exitCode], ['spawn_error', null]);
  const controller = new AbortController();
  const pending = runCommand({ command: ['/bin/sleep', '30'], cwd: directory, env: process.env, timeoutMs: 20000, profile: null, signal: controller.signal });
  setImmediate(() => controller.abort());
  assert.equal((await pending).status, 'cancelled');
});

test('the runner keeps only the last MiB of each stream and the last 40 lines of output', async t => {
  const directory = temporary(t, 'review-tests-run-');
  const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}\n`).join('');
  const script = `process.stdout.write('a'.repeat(1048576) + ${JSON.stringify(lines)})`;
  const result = await runCommand({ command: [process.execPath, '-e', script], cwd: directory, env: process.env, timeoutMs: 20000, profile: null });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, 1048576);
  assert.equal(result.stdout.toString(), 'a'.repeat(1048576 - lines.length) + lines);
  assert.deepEqual(result.truncated, { stdout: true, stderr: false });
  assert.equal(result.tail, lines.trim().split('\n').slice(-40).join('\n'));
});

test('removing a tree clears immutable flags and closed permissions a test left behind', { skip: !darwin && 'chflags is macOS only' }, t => {
  const base = temporary(t, 'rt-remove-');
  const tree = join(base, 'tree');
  mkdirSync(join(tree, 'closed'), { recursive: true });
  writeFileSync(join(tree, 'pinned'), 'x');
  writeFileSync(join(tree, 'closed', 'inner'), 'x');
  execFileSync('/usr/bin/chflags', ['uchg', join(tree, 'pinned')]);
  chmodSync(join(tree, 'closed'), 0o000);
  removeTree(tree);
  assert.equal(existsSync(tree), false);
});

test('the test environment drops secret-looking and git-location names and keeps git inside the workspace', () => {
  const env = testEnvironment('/runs/ws', '/runs/ws/pkg', {
    PATH: '/bin', HOME: '/home/dev', LANG: 'C', GITHUB_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'x', DB_PASSWORD: 'x', PASSWD: 'x', NPM_AUTH: 'x',
    MY_API_KEY: 'x', APIKEY: 'x', SSH_AUTH_SOCK: 'x', TERM_SESSION_ID: 'x', GCP_CREDENTIALS: 'x', PRIVATEKEY: 'x', ACCESS_KEY_ID: 'x', COOKIE_JAR: 'x',
    SMTP_PASS: 'x', mysql_pwd: 'x', REDIS_PWD: 'x', PWD: '/home/dev', OLDPWD: '/home', PASSENGER_ROOT: '/opt/passenger',
    RAILS_MASTER_KEY: 'x', STRIPE_KEY: 'x', GPG_PASSPHRASE: 'x', SENTRY_DSN: 'x', DB_PW: 'x', KEYBOARD_LAYOUT: 'us',
    NODE_TEST_CONTEXT: 'child-v8', GIT_DIR: '/home/dev/.git', GIT_WORK_TREE: '/home/dev', GIT_CEILING_DIRECTORIES: '/', GIT_PAGER: 'cat',
  });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/dev', LANG: 'C', OLDPWD: '/home', PASSENGER_ROOT: '/opt/passenger', KEYBOARD_LAYOUT: 'us', GIT_PAGER: 'cat',
    TMPDIR: '/runs/ws/.review-tmp', TMP: '/runs/ws/.review-tmp', TEMP: '/runs/ws/.review-tmp', PWD: '/runs/ws/pkg', GIT_CEILING_DIRECTORIES: '/runs' });
});

test('the sandbox profile lets a run write only inside its workspace and reach no launcher, pasteboard, keychain or other process', t => {
  const workspace = temporary(t, 'rt-profile-');
  const quoted = JSON.stringify(workspace);
  assert.equal(sandboxProfile(workspace), [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    `(allow network* (local unix-socket (subpath ${quoted})) (remote unix-socket (subpath ${quoted})))`,
    '(deny file-write*)',
    `(allow file-write* (subpath ${quoted}) (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/fd/[0-9]+$") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/dtracehelper"))`,
    `(deny file-write* (literal ${quoted}))`,
    `(deny file-write-flags (subpath ${quoted}))`,
    '(deny lsopen appleevent-send job-creation user-preference-write)',
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    '(deny mach-lookup (global-name-prefix "com.apple.lsd.") (global-name-prefix "com.apple.coreservices.uasharedpasteboard") (global-name-prefix "com.apple.backgroundtaskmanagement")'
      + ' (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.coreservices.appleevents") (global-name "com.apple.coreservices.sharedfilelistd.xpc")'
      + ' (global-name "com.apple.pasteboard.1") (global-name "com.apple.coreservices.uauseractivitypasteboardclient.xpc") (global-name "com.apple.SecurityServer")'
      + ' (global-name "com.apple.securityd.xpc"))',
  ].join('\n'));
});

test('sandbox_check inside the profile denies launching, Apple events, jobs, preferences, pasteboard, keychain and the root, and allows the workspace',
  { skip: (!darwin && 'macOS sandbox only') || (!python && 'no python3 for sandbox_check') }, async t => {
    const base = temporary(t, 'rt-sbx-check-');
    const workspace = join(base, 'ws');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'inside.txt'), 'ok\n');
    writeFileSync(join(base, 'outside.txt'), 'original\n');
    const checks = [
      ['lsopen', 'none'], ['appleevent-send', 'appleevent-destination', 'com.apple.Terminal'], ['appleevent-send', 'appleevent-destination', 'com.apple.finder'],
      ['job-creation', 'none'], ['signal', 'none'], ['user-preference-write', 'none'], ['user-preference-write', 'preference-domain', 'com.apple.Terminal'],
      ...['com.apple.coreservices.launchservicesd', 'com.apple.lsd.open', 'com.apple.lsd.mapdb', 'com.apple.lsd.modifydb', 'com.apple.coreservices.appleevents',
        'com.apple.coreservices.sharedfilelistd.xpc', 'com.apple.backgroundtaskmanagement', 'com.apple.backgroundtaskmanagement.sfl', 'com.apple.pasteboard.1',
        'com.apple.coreservices.uauseractivitypasteboardclient.xpc', 'com.apple.coreservices.uasharedpasteboardmanager.xpc', 'com.apple.SecurityServer', 'com.apple.securityd.xpc',
      ].map(name => ['mach-lookup', 'global-name', name]),
      ['file-write-data', 'path', '/dev/tty'], ['file-write-data', 'path', join(base, 'outside.txt')], ['file-write-unlink', 'path', workspace], ['file-write-mode', 'path', workspace],
    ];
    const allowed = [['file-write-data', 'path', join(workspace, 'inside.txt')], ['mach-lookup', 'global-name', 'com.apple.system.opendirectoryd.api'],
      ['user-preference-read', 'preference-domain', 'com.apple.Terminal']];
    const script = [
      'import ctypes, json, os, sys',
      "system = ctypes.CDLL('/usr/lib/libSystem.B.dylib')",
      'check = system.sandbox_check',
      'check.restype = ctypes.c_int',
      // sandbox_check is variadic: fixed argument types make ctypes pass the filter argument the way the arm64 ABI expects.
      'check.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]',
      "quiet = ctypes.c_int.in_dll(system, 'SANDBOX_CHECK_NO_REPORT').value",
      "kinds = {'none': 0, 'path': 1, 'global-name': 2, 'appleevent-destination': 4, 'preference-domain': 6}",
      'print(json.dumps([check(os.getpid(), op.encode(), kinds[kind] | quiet, *[ctypes.c_char_p(value.encode()) for value in rest]) for op, kind, *rest in json.loads(sys.argv[1])]))',
    ].join('\n');
    const result = await runCommand({ command: [python, '-c', script, JSON.stringify([...checks, ...allowed])], cwd: workspace, env: testEnvironment(workspace, workspace),
      timeoutMs: 20000, profile: sandboxProfile(workspace) });
    assert.equal(result.exitCode, 0, result.tail);
    const answers = JSON.parse(result.stdout.toString());
    assert.deepEqual(Object.fromEntries([...checks, ...allowed].map((check, position) => [check.join(' '), answers[position]])),
      Object.fromEntries([...checks.map(check => [check.join(' '), 1]), ...allowed.map(check => [check.join(' '), 0])]));
  });

test('under the profile a test cannot signal or replace what is outside its sandbox, and node --test with a nested child still runs', { skip: !darwin && 'macOS sandbox only' }, async t => {
  const base = temporary(t, 'rt-sbx-signal-');
  const workspace = join(base, 'ws');
  mkdirSync(join(workspace, 'test'), { recursive: true });
  writeFileSync(join(workspace, 'test/nested.test.mjs'), "import assert from 'node:assert/strict';\nimport { spawnSync } from 'node:child_process';\nimport test from 'node:test';\n\n"
    + "test('a nested node child runs', () => assert.equal(spawnSync(process.execPath, ['-p', '40 + 2'], { encoding: 'utf8' }).stdout.trim(), '42'));\n");
  resetTemporary(workspace);
  const outside = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  t.after(() => outside.kill('SIGKILL'));
  const profile = sandboxProfile(workspace);
  const script = `const fs = require('fs'); const { spawn } = require('child_process'); const results = [];
const attempt = (label, act) => { try { act(); results.push(label + ' ok'); } catch (error) { results.push(label + ' ' + error.code); } };
attempt('signal outside', () => process.kill(${outside.pid}, 'SIGTERM'));
attempt('probe outside', () => process.kill(${outside.pid}, 0));
attempt('remove root', () => fs.rmdirSync(process.cwd()));
attempt('rename root', () => fs.renameSync(process.cwd(), process.cwd() + '-moved'));
attempt('write file in root', () => fs.writeFileSync('created.txt', 'ok'));
attempt('lock file', () => { if (require('child_process').spawnSync('/usr/bin/chflags', ['uchg', 'created.txt']).status !== 0) throw Object.assign(new Error('chflags'), { code: 'EPERM' }); });
attempt('write tty', () => fs.writeFileSync('/dev/tty', 'x'));
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
child.once('spawn', () => attempt('signal own child', () => child.kill('SIGTERM')));
child.once('exit', (code, signal) => { results.push('child ' + signal); console.log(results.join('\\n')); });`;
  const probe = await runCommand({ command: [process.execPath, '-e', script], cwd: workspace, env: testEnvironment(workspace, workspace), timeoutMs: 20000, profile });
  assert.deepEqual(probe.stdout.toString().trim().split('\n'), ['signal outside EPERM', 'probe outside EPERM', 'remove root EPERM', 'rename root EPERM',
    'write file in root ok', 'lock file EPERM', 'write tty EPERM', 'signal own child ok', 'child SIGTERM']);
  assert.equal(outside.exitCode, null);
  assert.equal(outside.signalCode, null);
  const suite = await runCommand({ command: [process.execPath, '--test', 'test/nested.test.mjs'], cwd: workspace, env: testEnvironment(workspace, workspace), timeoutMs: 60000, profile });
  assert.deepEqual([suite.status, suite.exitCode], ['completed', 0], suite.tail);
  const stuck = await runCommand({ command: ['/bin/sleep', '30'], cwd: workspace, env: testEnvironment(workspace, workspace), timeoutMs: 300, killAfterMs: 300, profile });
  assert.deepEqual([stuck.status, stuck.durationMs < 10000], ['timeout', true], 'The runner still stops a sandboxed group.');
});

test('a moved workspace is out of reach for a process that outlived its run', { skip: !darwin && 'macOS sandbox only' }, async t => {
  const base = temporary(t, 'rt-rotate-');
  const workspace = join(base, 'workspaces', 'used');
  const outside = join(base, 'outside');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(workspace, 'src/limit.js'), 'limit\n');
  const script = `const fs = require('fs'); const [root, outside] = process.argv.slice(1); const results = [];
const attempt = (label, act) => { try { act(); results.push(label + ' ok'); } catch (error) { results.push(label + ' ' + error.code); } };
process.stdout.write('ready\\n');
process.stdin.once('data', () => {
  attempt('create in cwd', () => fs.writeFileSync('new.txt', 'x'));
  attempt('replace file in cwd', () => fs.unlinkSync('limit.js'));
  attempt('link in cwd', () => fs.symlinkSync(outside, 'link'));
  attempt('recreate root', () => fs.mkdirSync(root));
  attempt('link root', () => fs.symlinkSync(outside, root));
  console.log(results.join('\\n'));
  process.exit(0);
});`;
  const survivor = spawn('/usr/bin/sandbox-exec', ['-p', sandboxProfile(workspace), process.execPath, '-e', script, workspace, outside], { cwd: join(workspace, 'src'), stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => survivor.kill('SIGKILL'));
  let output = '';
  survivor.stdout.on('data', chunk => { output += chunk; });
  while (!output.includes('ready')) await once(survivor.stdout, 'data');
  const moved = rotateWorkspace(workspace);
  survivor.stdin.end('go\n');
  await once(survivor, 'exit');
  assert.deepEqual(output.trim().split('\n'), ['ready', 'create in cwd EPERM', 'replace file in cwd EPERM', 'link in cwd EPERM', 'recreate root EPERM', 'link root EPERM']);
  assert.equal(existsSync(workspace), false);
  assert.equal(readFileSync(join(moved, 'src/limit.js'), 'utf8'), 'limit\n');
  assert.deepEqual(readdirSync(outside), []);
  rmSync(moved, { recursive: true });
  symlinkSync(outside, moved);
  assert.equal(rotateWorkspace(moved), null, 'A root replaced by a symlink is not a workspace.');
  assert.deepEqual(readdirSync(join(base, 'workspaces')), []);
  assert.ok(lstatSync(outside).isDirectory());
});

test('the sandbox denies writes outside the workspace and TCP to localhost, and allows writes and unix sockets inside', { skip: !darwin && 'macOS sandbox only' }, async t => {
  const base = temporary(t, 'rt-sbx-');
  const workspace = join(base, 'ws');
  const outside = join(base, 'out');
  mkdirSync(workspace);
  mkdirSync(outside);
  writeFileSync(join(outside, 'target.txt'), 'original\n');
  symlinkSync(join(outside, 'target.txt'), join(workspace, 'linked.txt'));
  resetTemporary(workspace);
  const server = createServer(socket => socket.end('hello')).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const profile = sandboxProfile(workspace);
  const probe = async body => {
    const result = await runCommand({ command: [process.execPath, '-e', `const fs = require('fs'); const net = require('net'); ${body}`],
      cwd: workspace, env: testEnvironment(workspace, workspace), timeoutMs: 20000, profile });
    return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}`.trim() };
  };
  const failure = 'catch (error) { console.log(error.code); process.exit(3); }';
  assert.deepEqual(await probe(`fs.writeFileSync('inside.txt', 'ok'); fs.writeFileSync(require('path').join(require('os').tmpdir(), 't'), 'ok'); console.log('wrote')`), { exitCode: 0, output: 'wrote' });
  assert.equal(readFileSync(join(workspace, 'inside.txt'), 'utf8'), 'ok');
  assert.deepEqual(await probe(`try { fs.writeFileSync(${JSON.stringify(join(outside, 'x.txt'))}, 'no'); } ${failure}`), { exitCode: 3, output: 'EPERM' });
  assert.deepEqual(await probe(`try { fs.appendFileSync('linked.txt', 'no'); } ${failure}`), { exitCode: 3, output: 'EPERM' });
  assert.deepEqual(await probe(`try { fs.mkdirSync(${JSON.stringify(join(outside, 'dir'))}); } ${failure}`), { exitCode: 3, output: 'EPERM' });
  assert.deepEqual(await probe(`net.connect(${server.address().port}, '127.0.0.1').on('connect', () => process.exit(0)).on('error', error => { console.log(error.code); process.exit(3); })`), { exitCode: 3, output: 'EPERM' });
  assert.deepEqual(await probe("const s = net.createServer(c => c.end('ok')).listen('s.sock', () => net.connect('s.sock').on('data', d => { console.log(String(d)); process.exit(0); }))"), { exitCode: 0, output: 'ok' });
  assert.equal(readFileSync(join(outside, 'target.txt'), 'utf8'), 'original\n');
  assert.deepEqual(readdirSync(outside), ['target.txt']);
});
