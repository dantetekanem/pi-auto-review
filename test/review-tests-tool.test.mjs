import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { registerReviewTests } from '../src/review-tests-tool.ts';
import { removeTestWorkspace, verifyTestRuns } from '../src/review-tests.ts';

const darwin = process.platform === 'darwin';
const macOnly = { skip: !darwin && 'test runs need macOS' };
const sessionId = 'review-tests-session';
const runId = '33333333-3333-4333-8333-333333333333';
const limitTest = [process.execPath, '--test', 'test/limit.test.mjs'];
const suite = [process.execPath, 'scripts/run-tests.mjs', 'test'];
const settings = ['-c', 'user.name=Review Tests', '-c', 'user.email=review-tests@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
const git = (cwd, ...args) => execFileSync('git', [...settings, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const alive = pid => !['', 'Z'].includes(spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim().slice(0, 1));
const pick = result => result && { index: result.index, kind: result.kind, outcome: result.outcome, grade: result.grade, status: result.status, exitCode: result.exitCode };
const noUI = 'Only the top-level review session runs tests, and this session has no UI';

const baseLimit = 'export function limit(value, max) {\n  return value;\n}\n';
const headLimit = 'export function limit(value, max) {\n  if (value > max) return max;\n  if (value < 0) return 0;\n  return value;\n}\n';
const limitTestSource = "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { limit } from '../src/limit.mjs';\n\n"
  + "test('limit caps values at max', () => {\n  assert.equal(limit(5, 3), 3);\n  assert.equal(limit(2, 3), 2);\n});\n";
// node --test does not run the files of a directory argument, so the fixture brings a runner that does.
const runnerSource = "import { spawnSync } from 'node:child_process';\nimport { readdirSync } from 'node:fs';\nimport { join } from 'node:path';\n\n"
  + "const directory = process.argv[2];\nconst files = readdirSync(directory, { recursive: true }).filter(name => name.endsWith('.test.mjs')).map(name => join(directory, name)).sort();\n"
  + "process.exit(spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' }).status ?? 1);\n";
const edgeTest = (name, assertion) => ({ path: `test/${name}.test.mjs`, codePath: 'limit(value, max) bounds',
  content: `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { limit } from '../src/limit.mjs';\n\ntest('${name}', () => { ${assertion} });\n` });
const upperBreak = { path: 'src/limit.mjs', line: 2, before: 'value > max', after: 'false', safeguard: 'the upper clamp' };

function fingerprint(root) {
  const lines = [];
  const visit = relative => {
    const path = relative ? join(root, relative) : root;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) lines.push(`${relative} -> ${readlinkSync(path)}`);
    else if (stat.isDirectory()) {
      lines.push(`${relative}/ ${stat.mode & 0o7777}`);
      for (const entry of readdirSync(path).sort()) visit(relative ? `${relative}/${entry}` : entry);
    } else lines.push(`${relative} ${stat.mode & 0o7777} ${sha256(readFileSync(path))}`);
  };
  visit('');
  return lines.join('\n');
}

function setup(t, { provider = 'github', tests } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'review-tests-tool-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'history');
  const repo = join(base, 'repo');
  const directory = join(root, sessionId);
  mkdirSync(directory, { recursive: true });
  mkdirSync(repo);
  if (tests) writeFileSync(join(root, 'settings.json'), JSON.stringify({ tests }));
  const write = files => Object.entries(files).forEach(([path, content]) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  });
  git(repo, 'init', '-q', '-b', 'main');
  write({ 'package.json': '{"name":"limit","private":true,"type":"module"}\n', 'src/limit.mjs': baseLimit, 'scripts/run-tests.mjs': runnerSource, 'README.md': 'limit\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const baseCommit = git(repo, 'rev-parse', 'HEAD');
  write({ 'src/limit.mjs': headLimit, 'test/limit.test.mjs': limitTestSource });
  let head = baseCommit;
  if (provider !== 'local') {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'head');
    head = git(repo, 'rev-parse', 'HEAD');
  }
  const preflight = provider === 'local'
    ? { target: 'local working tree', provider, number: null, base: 'HEAD', head, checkout: repo }
    : { target: 'https://github.com/example/limit/pull/1', provider, number: 1, base: baseCommit, head, checkout: repo };
  const reviewPath = join(directory, `${runId}.review.json`);
  writeFileSync(reviewPath, JSON.stringify({ schemaVersion: 1, sessionId, runId, status: 'running', preflight }));
  const tools = new Map();
  registerReviewTests({ registerTool: tool => tools.set(tool.name, tool) }, root);
  const tool = tools.get('agentic_code_review_run_tests');
  assert.ok(tool, 'The test tool must register under its contract name.');
  const context = (owner, hasUI) => ({ cwd: repo, hasUI, sessionManager: { getSessionId: () => owner } });
  const call = async (input, { owner = 'review-owner', signal, hasUI = true } = {}) => (await tool.execute('call', { sessionId, runId, ...input }, signal, undefined, context(owner, hasUI))).details;
  const paths = { index: join(directory, `${runId}.tests.json`), active: join(directory, `${runId}.tests.active`), workspaces: join(directory, `${runId}.tests`, 'workspaces') };
  const index = () => JSON.parse(readFileSync(paths.index, 'utf8'));
  return { root, repo, directory, reviewPath, paths, index, workspace: () => index().workspace, base: baseCommit, head, call, tool };
}

test('plan reports availability, budget, changed files, suggestions and break candidates, and builds nothing', macOnly, async t => {
  const f = setup(t);
  const plan = await f.call({ operation: 'plan' });
  assert.deepEqual(plan, {
    available: true, reason: null, sandbox: true, budget: { maxRuns: 12, used: 0, remaining: 12 }, timeoutSeconds: 300,
    base: f.base, head: f.head, headState: 'commit', components: ['.'],
    files: [
      { path: 'src/limit.mjs', status: 'modified', test: false, ranges: [[2, 3]] },
      { path: 'test/limit.test.mjs', status: 'added', test: true, ranges: [[1, 8]] },
    ],
    suggestedTests: ['test/limit.test.mjs'],
    breakCandidates: [{ path: 'src/limit.mjs', line: 2, text: 'if (value > max) return max;' }, { path: 'src/limit.mjs', line: 3, text: 'if (value < 0) return 0;' }],
  });
  assert.deepEqual(readdirSync(f.directory), [`${runId}.review.json`]);
  await assert.rejects(f.call({ operation: 'plan', kind: 'baseline' }), /plan takes only/);
});

test('runs grade the change: automatic baseline, revert, killed and surviving breaks, edge tests, then budget exhaustion', macOnly, async t => {
  const f = setup(t, { tests: { maxRuns: 8, timeoutSeconds: 60 } });
  const checkout = fingerprint(f.repo);
  const revert = await f.call({ operation: 'run', kind: 'revert', command: limitTest, cwd: '.' });
  assert.deepEqual(pick(revert.baseline), { index: 1, kind: 'baseline', outcome: 'passed', grade: 'pass', status: 'completed', exitCode: 0 });
  assert.deepEqual(pick(revert), { index: 2, kind: 'revert', outcome: 'failed-without-change', grade: 'pass', status: 'completed', exitCode: 1 });
  assert.equal(revert.remaining, 6);
  const baseline = await f.call({ operation: 'run', kind: 'baseline', command: limitTest });
  assert.deepEqual(pick(baseline), { index: 3, kind: 'baseline', outcome: 'passed', grade: 'pass', status: 'completed', exitCode: 0 });
  assert.equal(baseline.baseline, undefined);
  const killed = await f.call({ operation: 'run', kind: 'break', command: limitTest, cwd: '.', mutation: upperBreak });
  assert.deepEqual(pick(killed), { index: 4, kind: 'break', outcome: 'killed', grade: 'pass', status: 'completed', exitCode: 1 });
  assert.equal(killed.baseline, undefined);
  const survived = await f.call({ operation: 'run', kind: 'break', command: limitTest, cwd: '.',
    mutation: { path: 'src/limit.mjs', line: 3, before: 'value < 0', after: 'false', safeguard: 'the lower clamp' } });
  assert.deepEqual(pick(survived), { index: 5, kind: 'break', outcome: 'survived', grade: 'fail', status: 'completed', exitCode: 0 });
  const holds = await f.call({ operation: 'run', kind: 'edge', command: suite, edgeTest: edgeTest('limit-at-max', 'assert.equal(limit(3, 3), 3);') });
  assert.deepEqual(pick(holds.baseline), { index: 6, kind: 'baseline', outcome: 'passed', grade: 'pass', status: 'completed', exitCode: 0 });
  assert.deepEqual(pick(holds), { index: 7, kind: 'edge', outcome: 'holds', grade: 'pass', status: 'completed', exitCode: 0 });
  assert.match(holds.output, /limit-at-max/);
  const breaks = await f.call({ operation: 'run', kind: 'edge', command: suite, edgeTest: edgeTest('limit-nan', 'assert.equal(limit(Number.NaN, 3), 3);') });
  assert.deepEqual(pick(breaks), { index: 8, kind: 'edge', outcome: 'breaks', grade: 'counterexample', status: 'completed', exitCode: 1 });
  assert.equal(breaks.remaining, 0);
  assert.match(breaks.output, /limit-nan/);
  assert.ok(breaks.output.length <= 4000 && breaks.output.split('\n').length <= 40);
  await assert.rejects(f.call({ operation: 'run', kind: 'baseline', command: limitTest }), /budget is exhausted/);

  const receipt = JSON.parse(readFileSync(killed.receipt, 'utf8'));
  const folder = dirname(killed.receipt);
  assert.deepEqual(receipt, {
    schemaVersion: 1, runId, index: 4, kind: 'break', command: limitTest, cwd: '.', sandbox: true, change: upperBreak,
    changeSha256: sha256(readFileSync(join(folder, 'change.diff'))), baseline: 3, startedAt: receipt.startedAt, durationMs: receipt.durationMs,
    status: 'completed', exitCode: 1, signal: null, truncated: { stdout: false, stderr: false }, outcome: 'killed', grade: 'pass',
    stdoutSha256: sha256(readFileSync(join(folder, 'stdout.txt'))), stderrSha256: sha256(readFileSync(join(folder, 'stderr.txt'))),
  });
  assert.match(readFileSync(join(folder, 'change.diff'), 'utf8'), /^-  if \(value > max\) return max;\n\+  if \(false\) return max;$/m);
  assert.equal(JSON.parse(readFileSync(revert.receipt, 'utf8')).baseline, 1);
  const { summary, problems } = verifyTestRuns(f.directory, runId);
  assert.deepEqual(problems, []);
  assert.deepEqual(summary.outcomes, { baseline: { passed: 3 }, revert: { 'failed-without-change': 1 }, break: { killed: 1, survived: 1 }, edge: { holds: 1, breaks: 1 } });
  assert.deepEqual([summary.runs, summary.sandbox, summary.receipts.length], [8, true, 8]);
  const index = f.index();
  assert.deepEqual({ owner: index.owner, settings: index.settings, headState: index.headState, base: index.base, head: index.head },
    { owner: 'review-owner', settings: { enabled: true, sandbox: true, maxRuns: 8, timeoutSeconds: 60 }, headState: 'commit', base: f.base, head: f.head });
  assert.equal(readFileSync(join(f.workspace(), 'src/limit.mjs'), 'utf8'), headLimit);
  assert.deepEqual(readdirSync(join(f.workspace(), 'test')), ['limit.test.mjs']);
  assert.deepEqual(readdirSync(f.paths.workspaces), [f.workspace().split('/').pop()], 'Each run moves the workspace on; nothing else stays.');
  assert.equal(existsSync(f.paths.active), false);
  assert.equal(fingerprint(f.repo), checkout, 'Runs must never write to the checkout.');
  assert.deepEqual((await f.call({ operation: 'plan' })).budget, { maxRuns: 8, used: 8, remaining: 0 });
});

test('an edge command that names only its new file reuses a passed baseline in its cwd and is refused without one', macOnly, async t => {
  const f = setup(t);
  const edge = edgeTest('limit-negative', 'assert.equal(limit(-2, 3), 0);');
  const command = [process.execPath, '--test', edge.path];
  await assert.rejects(f.call({ operation: 'run', kind: 'edge', command, edgeTest: edge }), /needs a passed baseline in \. first/);
  assert.equal(existsSync(f.paths.index) ? f.index().runs.length : 0, 0);
  await f.call({ operation: 'run', kind: 'baseline', command: limitTest });
  const holds = await f.call({ operation: 'run', kind: 'edge', command, edgeTest: edge });
  assert.deepEqual(pick(holds), { index: 2, kind: 'edge', outcome: 'holds', grade: 'pass', status: 'completed', exitCode: 0 });
  assert.equal(holds.baseline, undefined);
  assert.equal(JSON.parse(readFileSync(holds.receipt, 'utf8')).baseline, 1);
});

test('an edge command must name its file or a directory that holds it, resolved against cwd, before it runs', macOnly, async t => {
  const f = setup(t);
  const edge = edgeTest('limit-unnamed', 'assert.equal(limit(1, 3), 1);');
  for (const command of [[process.execPath, '--test'], [process.execPath, 'scripts/run-tests.mjs', 'src'], [process.execPath, '--test', '--test-reporter=tap', join(f.repo, edge.path)]]) {
    await assert.rejects(f.call({ operation: 'run', kind: 'edge', command, edgeTest: edge }), /must name its test file test\/limit-unnamed\.test\.mjs or a directory that holds it/, command.join(' '));
  }
  assert.deepEqual(f.index().runs, []);
  const holds = await f.call({ operation: 'run', kind: 'edge', command: [process.execPath, '../scripts/run-tests.mjs', '.'], cwd: 'test', edgeTest: edge });
  assert.deepEqual([pick(holds.baseline), pick(holds)], [
    { index: 1, kind: 'baseline', outcome: 'passed', grade: 'pass', status: 'completed', exitCode: 0 },
    { index: 2, kind: 'edge', outcome: 'holds', grade: 'pass', status: 'completed', exitCode: 0 },
  ]);
  assert.match(holds.output, /limit-unnamed/);
});

test('the first run binds the owner session, a concurrent run is refused and a session without a UI only plans', macOnly, async t => {
  const f = setup(t);
  await assert.rejects(f.call({ operation: 'run', kind: 'baseline', command: limitTest }, { hasUI: false }), new RegExp(noUI));
  const lane = await f.call({ operation: 'plan' }, { hasUI: false });
  assert.deepEqual([lane.available, lane.reason.startsWith(noUI), lane.breakCandidates.length], [false, true, 2]);
  assert.equal(existsSync(f.paths.index), false);
  const first = f.call({ operation: 'run', kind: 'baseline', command: limitTest });
  await assert.rejects(f.call({ operation: 'run', kind: 'baseline', command: limitTest }), /runs are serial/);
  assert.equal((await first).outcome, 'passed');
  await assert.rejects(f.call({ operation: 'run', kind: 'baseline', command: limitTest }, { owner: 'another-session' }), /belong to another session/);
  assert.deepEqual((await f.call({ operation: 'plan' }, { owner: 'another-session' })).budget, { maxRuns: 12, used: 1, remaining: 11 });
  assert.equal(f.index().runs.length, 1);
});

test('an intent left by a crashed run is recorded as interrupted and the next run gets a fresh workspace', macOnly, async t => {
  const f = setup(t);
  await f.call({ operation: 'run', kind: 'baseline', command: limitTest });
  const interrupted = f.workspace();
  const halfApplied = 'export const limit = () => { throw new Error("half-applied change"); };\n';
  writeFileSync(join(interrupted, 'src/limit.mjs'), halfApplied);
  writeFileSync(f.paths.active, JSON.stringify({ schemaVersion: 1, runId, index: 2, kind: 'break', command: limitTest, cwd: '.', change: upperBreak, baseline: 1, startedAt: new Date().toISOString() }));
  assert.match(verifyTestRuns(f.directory, runId).problems.join('\n'), /still in flight/);
  assert.equal((await f.call({ operation: 'plan' })).budget.used, 2);
  const next = await f.call({ operation: 'run', kind: 'baseline', command: limitTest });
  assert.deepEqual([next.index, next.outcome, next.remaining], [3, 'passed', 9]);
  assert.deepEqual(f.index().runs.map(run => [run.index, run.kind, run.outcome, run.grade]),
    [[1, 'baseline', 'passed', 'pass'], [2, 'break', 'interrupted', 'unknown'], [3, 'baseline', 'passed', 'pass']]);
  assert.notEqual(f.workspace(), interrupted);
  assert.equal(readFileSync(join(f.workspace(), 'src/limit.mjs'), 'utf8'), headLimit);
  assert.equal(readFileSync(join(interrupted, 'src/limit.mjs'), 'utf8'), halfApplied, 'The interrupted run may still own its workspace, so recovery never writes there.');
  const receipt = JSON.parse(readFileSync(join(f.directory, f.index().runs[1].receipt.path), 'utf8'));
  assert.deepEqual([receipt.status, receipt.change, receipt.exitCode], ['interrupted', upperBreak, null]);
  assert.deepEqual(verifyTestRuns(f.directory, runId).problems, []);
  assert.equal(existsSync(f.paths.active), false);
  writeFileSync(f.paths.active, JSON.stringify({ schemaVersion: 1, runId, index: 4, kind: 'baseline', command: limitTest, cwd: '.', pid: process.ppid }));
  await assert.rejects(f.call({ operation: 'run', kind: 'baseline', command: limitTest }), /may still be active for this review/);
  assert.equal(f.index().runs.length, 3);
});

test('recovery kills the process group of an interrupted run, and not a group whose leader started at another time', macOnly, async t => {
  const f = setup(t);
  await f.call({ operation: 'run', kind: 'baseline', command: limitTest });
  const leftover = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' });
  const spawnedAt = new Date().toISOString();
  t.after(() => { try { process.kill(-leftover.pid, 'SIGKILL'); } catch { /* Already gone. */ } });
  const intent = { schemaVersion: 1, runId, kind: 'baseline', command: limitTest, cwd: '.', change: null, baseline: null, startedAt: spawnedAt, group: leftover.pid };
  writeFileSync(f.paths.active, JSON.stringify({ ...intent, index: 2, spawnedAt: new Date(Date.parse(spawnedAt) - 3_600_000).toISOString() }));
  await f.call({ operation: 'run', kind: 'baseline', command: limitTest });
  assert.equal(alive(leftover.pid), true, 'A reused group id must not be killed.');
  writeFileSync(f.paths.active, JSON.stringify({ ...intent, index: 4, spawnedAt }));
  await f.call({ operation: 'run', kind: 'baseline', command: limitTest });
  assert.equal(alive(leftover.pid), false);
  assert.deepEqual(f.index().runs.map(run => run.outcome), ['passed', 'interrupted', 'passed', 'interrupted', 'passed']);
});

test('a run that replaces the workspace root cannot steer a later run into the checkout', macOnly, async t => {
  for (const sandbox of [true, false]) {
    const f = setup(t, { tests: { sandbox } });
    const checkout = fingerprint(f.repo);
    const replaceRoot = [process.execPath, '-e', `const fs = require('fs'); const root = process.cwd();
for (const [label, act] of [['remove', () => fs.rmSync(root, { recursive: true, force: true })], ['link', () => fs.symlinkSync(${JSON.stringify(f.repo)}, root)]]) {
  try { act(); console.log(label, 'done'); } catch (error) { console.log(label, error.code); }
}`];
    const swap = await f.call({ operation: 'run', kind: 'baseline', command: replaceRoot });
    const next = await f.call({ operation: 'run', kind: 'baseline', command: limitTest });
    assert.equal(fingerprint(f.repo), checkout, `sandbox ${sandbox}: the tool must not write to the checkout through a replaced root`);
    assert.match(swap.output, sandbox ? /^remove EPERM\nlink E(?:EXIST|PERM)$/ : /^remove done\nlink done$/, `sandbox ${sandbox}: ${swap.output}`);
    assert.equal(swap.workspaceReset !== undefined, !sandbox);
    // Under the sandbox the run could empty the workspace but not remove its root; without it the root went and the next run rebuilt.
    assert.deepEqual([next.index, next.outcome], [2, sandbox ? 'failed' : 'passed']);
    assert.ok(lstatSync(f.workspace()).isDirectory());
  }
});

test('processes that outlive a run cannot steer the tool into the checkout', macOnly, async t => {
  const f = setup(t, { tests: { timeoutSeconds: 60 } });
  const checkout = fingerprint(f.repo);
  const target = join(f.repo, 'src');
  t.after(() => spawnSync('/usr/bin/pkill', ['-KILL', '-f', target]));
  const survivor = `const fs = require('fs'); const [root, target] = process.argv.slice(1);
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const until = Date.now() + 20000;
while (process.ppid !== 1 && Date.now() < until) pause(1);
while (Date.now() < until && fs.existsSync(root)) {
  try { fs.renameSync(root + '/src', root + '/src.real'); fs.symlinkSync(target, root + '/src'); } catch {}
  try { fs.unlinkSync(root + '/src'); fs.renameSync(root + '/src.real', root + '/src'); } catch {}
}`;
  const command = [process.execPath, '-e', `const { spawn, spawnSync } = require('child_process');
const { status } = spawnSync(process.execPath, ['--test', 'test/limit.test.mjs'], { stdio: 'inherit' });
const child = spawn(process.execPath, ['-e', ${JSON.stringify(survivor)}, process.cwd(), ${JSON.stringify(target)}], { detached: true, stdio: 'ignore' });
console.log('survivor', child.pid);
process.exit(status);`];
  const used = [];
  try {
    const broken = await f.call({ operation: 'run', kind: 'break', command, cwd: '.', mutation: upperBreak });
    assert.deepEqual([broken.baseline.outcome, broken.outcome], ['passed', 'killed']);
  } catch (error) {
    // A survivor of the automatic baseline can leave src swapped before the workspace moves; the path guard then refuses the break.
    assert.match(error.message, /passes through a symlink/);
  }
  assert.match(readFileSync(join(f.directory, dirname(f.index().runs[0].receipt.path), 'stdout.txt'), 'utf8'), /^survivor \d+$/m);
  used.push(f.workspace());
  const next = await f.call({ operation: 'run', kind: 'baseline', command: limitTest });
  assert.equal(next.status, 'completed');
  used.push(f.workspace());
  assert.equal(fingerprint(f.repo), checkout, 'Survivors keep write access only to paths the tool never uses again.');
  assert.notEqual(used[0], used[1]);
  assert.equal(existsSync(used[0]), false);
});

test('a workspace build that fails leaves nothing a later run trusts', macOnly, async t => {
  const f = setup(t);
  git(f.repo, 'checkout', '-q', '--detach', f.base);
  const blocked = join(f.repo, 'blocked.txt');
  writeFileSync(blocked, 'unreadable\n');
  chmodSync(blocked, 0);
  await assert.rejects(f.call({ operation: 'run', kind: 'baseline', command: limitTest }), /Copy-on-write clone failed/);
  assert.equal(existsSync(f.paths.index), false);
  assert.deepEqual(readdirSync(f.paths.workspaces), []);
  chmodSync(blocked, 0o644);
  const checkout = fingerprint(f.repo);
  const run = await f.call({ operation: 'run', kind: 'baseline', command: limitTest });
  assert.deepEqual([run.index, run.outcome], [1, 'passed'], 'The rebuilt workspace carries the head commit, not the checkout at base.');
  assert.equal(readFileSync(join(f.workspace(), 'src/limit.mjs'), 'utf8'), headLimit);
  assert.equal(fingerprint(f.repo), checkout);
});

test('completion helpers verify receipts, catch tampering and remove only the workspaces', macOnly, async t => {
  const f = setup(t);
  assert.deepEqual(verifyTestRuns(f.directory, runId), { summary: null, problems: [] });
  const run = await f.call({ operation: 'run', kind: 'baseline', command: limitTest });
  assert.deepEqual(verifyTestRuns(f.directory, runId), {
    summary: { path: f.paths.index, runs: 1, sandbox: true, outcomes: { baseline: { passed: 1 } }, receipts: [run.receipt] }, problems: [],
  });
  const checkout = fingerprint(f.repo);
  mkdirSync(join(f.paths.workspaces, 'left-by-a-survivor'));
  removeTestWorkspace(f.directory, runId);
  assert.deepEqual(readdirSync(join(f.directory, `${runId}.tests`)), ['1-baseline']);
  assert.deepEqual(readdirSync(dirname(run.receipt)).sort(), ['change.diff', 'receipt.json', 'stderr.txt', 'stdout.txt']);
  assert.deepEqual(verifyTestRuns(f.directory, runId).problems, []);
  assert.equal(fingerprint(f.repo), checkout);
  const stdout = join(dirname(run.receipt), 'stdout.txt');
  const original = readFileSync(stdout);
  writeFileSync(stdout, 'tampered');
  assert.match(verifyTestRuns(f.directory, runId).problems.join('\n'), /stdout\.txt changed/);
  writeFileSync(stdout, original);
  const receipt = JSON.parse(readFileSync(run.receipt, 'utf8'));
  writeFileSync(run.receipt, JSON.stringify({ ...receipt, outcome: 'failed' }));
  const tampered = verifyTestRuns(f.directory, runId);
  assert.match(tampered.problems.join('\n'), /receipt\.json changed/);
  assert.deepEqual(tampered.summary.receipts, []);
  assert.throws(() => removeTestWorkspace(f.directory, '../escape'), /Invalid test-run identity/);
});

test('invalid requests are refused before they consume a run', macOnly, async t => {
  const f = setup(t);
  const rejects = (input, pattern, options) => assert.rejects(f.call(input, options), pattern, JSON.stringify(input));
  await rejects({ operation: 'run', kind: 'baseline', command: limitTest, extra: true }, /Unexpected test-run argument/);
  await assert.rejects(f.tool.execute('call', { sessionId: '../x', runId, operation: 'plan' }, undefined, undefined, {}), /Invalid test-run review identity/);
  await rejects({ operation: 'run', command: limitTest }, /needs kind/);
  await rejects({ operation: 'run', kind: 'baseline', command: [] }, /argv array/);
  await rejects({ operation: 'run', kind: 'baseline', command: ['node', 'a\0b'] }, /argv array/);
  await rejects({ operation: 'run', kind: 'baseline', command: limitTest, mutation: upperBreak }, /break needs mutation/);
  await rejects({ operation: 'run', kind: 'break', command: limitTest }, /break needs mutation/);
  await rejects({ operation: 'run', kind: 'baseline', command: limitTest, cwd: '../outside' }, /repository-relative directory/);
  await rejects({ operation: 'run', kind: 'baseline', command: limitTest, cwd: 'missing' }, /not a real directory/);
  await rejects({ operation: 'run', kind: 'break', command: limitTest, mutation: { ...upperBreak, line: 1 } }, /outside the changed lines/);
  await rejects({ operation: 'run', kind: 'edge', command: suite, edgeTest: { ...edgeTest('probe', ''), path: 'src/probe.mjs' } }, /test file path/);
  await rejects({ operation: 'run', kind: 'edge', command: suite, edgeTest: { ...edgeTest('dupe', ''), path: 'test/limit.test.mjs' } }, /already exists/);
  await rejects({ operation: 'run', kind: 'baseline', command: ['review-tests-no-such-program'] }, /review-tests-no-such-program is not an executable file in \. or on PATH/);
  await rejects({ operation: 'run', kind: 'break', command: ['./scripts/run-tests.mjs', 'test'], mutation: upperBreak }, /is not an executable file/);
  assert.deepEqual(f.index().runs, []);
  assert.equal(existsSync(f.paths.active), false);
  writeFileSync(f.reviewPath, JSON.stringify({ ...JSON.parse(readFileSync(f.reviewPath, 'utf8')), status: 'complete' }));
  await rejects({ operation: 'plan' }, /prepared or running/);
});

test('settings can turn the sandbox off, and the first run freezes them for the review', macOnly, async t => {
  const f = setup(t, { tests: { sandbox: false, maxRuns: 3, timeoutSeconds: 30 } });
  const run = await f.call({ operation: 'run', kind: 'baseline', command: limitTest });
  assert.deepEqual([run.outcome, JSON.parse(readFileSync(run.receipt, 'utf8')).sandbox], ['passed', false]);
  writeFileSync(join(f.root, 'settings.json'), JSON.stringify({ tests: { sandbox: true, maxRuns: 40 } }));
  const plan = await f.call({ operation: 'plan' });
  assert.deepEqual([plan.sandbox, plan.budget], [false, { maxRuns: 3, used: 1, remaining: 2 }]);
  assert.equal(verifyTestRuns(f.directory, runId).summary.sandbox, false);
});

test('turned-off settings make plan unavailable and refuse runs', async t => {
  const f = setup(t, { tests: { enabled: false } });
  const plan = await f.call({ operation: 'plan' });
  assert.deepEqual([plan.available, plan.reason], [false, 'Test runs are turned off in settings.json (tests.enabled).']);
  await assert.rejects(f.call({ operation: 'run', kind: 'baseline', command: limitTest }), /turned off/);
  assert.equal(existsSync(f.paths.index), false);
});

test('a local review runs against the working tree and stops once HEAD moves', macOnly, async t => {
  const f = setup(t, { provider: 'local' });
  const checkout = fingerprint(f.repo);
  const plan = await f.call({ operation: 'plan' });
  assert.deepEqual({ base: plan.base, head: plan.head, headState: plan.headState, files: plan.files }, {
    base: f.base, head: f.base, headState: 'working-tree',
    files: [{ path: 'src/limit.mjs', status: 'modified', test: false, ranges: [[2, 3]] }, { path: 'test/limit.test.mjs', status: 'added', test: true, ranges: [[1, 8]] }],
  });
  const revert = await f.call({ operation: 'run', kind: 'revert', command: limitTest });
  assert.deepEqual([revert.baseline.outcome, revert.outcome], ['passed', 'failed-without-change']);
  assert.equal(fingerprint(f.repo), checkout);
  git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'moved');
  const moved = await f.call({ operation: 'plan' });
  assert.deepEqual([moved.available, moved.reason], [false, 'HEAD moved since preflight.']);
  await assert.rejects(f.call({ operation: 'run', kind: 'baseline', command: limitTest }), /HEAD moved since preflight/);
});
