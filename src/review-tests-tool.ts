import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { readTestSettings, type TestSettings } from './runtime.ts';
import { analyzeTarget, boundedRead, breakCandidates, digest, gradeRun, headReader, idPattern, kinds, removeTree, resolveTarget, suggestTests, type Analysis, type Kind, type Target } from './review-tests.ts';
import { applyChange, buildWorkspace, cloneProblem, executable, intactWorkspace, planChange, resetTemporary, resolveCwd, rotateWorkspace, runCommand, sandboxProfile, testEnvironment } from './review-tests-workspace.ts';

type RunEntry = { index: number; kind: Kind; outcome: string; grade: string; receipt: { path: string; sha256: string } };
type Index = {
  schemaVersion: 1; runId: string; sessionId: string; owner: string; settings: TestSettings; repositoryRoot: string;
  base: string; head: string; headState: Analysis['headState']; workspace: string | null; components: string[]; files: Analysis['files']; runs: RunEntry[];
};
type Request = { kind: Kind; command: string[]; cwd: string; change: Record<string, unknown> | null };
type Paths = { directory: string; index: string; active: string; workspaces: string };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const display = (component: string) => component || '.';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Shared across extension reloads in one process, so a reloaded tool cannot start a second run of the same review.
const active: Set<string> = (globalThis as Record<symbol, Set<string>>)[Symbol.for('pi-auto-review.review-tests.active')] ??= new Set();
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

function saveAtomic(path: string, text: string, exclusive = false): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
  try {
    if (exclusive) linkSync(temporary, path);
    else renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

function loadIndex(paths: Paths, sessionId: string, runId: string): Index | null {
  if (!existsSync(paths.index)) return null;
  const index = JSON.parse(boundedRead(paths.index).toString('utf8'));
  if (index?.schemaVersion !== 1 || index.runId !== runId || index.sessionId !== sessionId || typeof index.owner !== 'string'
    || typeof index.settings?.sandbox !== 'boolean' || !Number.isInteger(index.settings.maxRuns) || !Number.isInteger(index.settings.timeoutSeconds)
    || (index.workspace !== null && typeof index.workspace !== 'string')
    || !Array.isArray(index.runs) || !Array.isArray(index.components) || !Array.isArray(index.files)) throw new Error(`${runId}.tests.json has the wrong identity or shape.`);
  return index;
}

const analysisOf = (index: Index): Analysis => ({ root: index.repositoryRoot, base: index.base, head: index.head, headState: index.headState, components: index.components, files: index.files });

/** The recorded workspace, while it is still a real directory at its own canonical path under `workspaces`. */
function usableWorkspace(paths: Paths, index: Index | null): string | null {
  const workspace = index?.workspace;
  if (typeof workspace !== 'string' || !uuid.test(basename(workspace)) || !existsSync(paths.workspaces)) return null;
  return dirname(workspace) === realpathSync(paths.workspaces) && intactWorkspace(workspace) ? workspace : null;
}

function rebuild(paths: Paths, index: Index | null, target: Target, identity: Pick<Index, 'runId' | 'sessionId' | 'owner' | 'settings'>): Index {
  const analysis = analyzeTarget(target);
  if (!analysis.files.length) throw new Error('The review has no changed files to test.');
  const workspace = buildWorkspace(analysis, paths.workspaces);
  const next: Index = { schemaVersion: 1, ...identity, repositoryRoot: analysis.root, base: analysis.base, head: analysis.head, headState: analysis.headState,
    workspace, components: analysis.components, files: analysis.files, runs: index?.runs ?? [] };
  saveAtomic(paths.index, JSON.stringify(next) + '\n');
  return next;
}

function unavailable(live: TestSettings, settings: TestSettings): string | null {
  if (!live.enabled) return 'Test runs are turned off in settings.json (tests.enabled).';
  if (process.platform !== 'darwin') return 'Test runs need macOS: APFS copy-on-write clones and sandbox-exec.';
  if (settings.sandbox && !existsSync('/usr/bin/sandbox-exec')) return 'The test sandbox is on, but /usr/bin/sandbox-exec is missing.';
  return null;
}

function readRequest(input: Record<string, unknown>): Omit<Request, 'cwd'> & { cwd?: string } {
  const { kind, command, cwd, mutation, edgeTest } = input;
  if (!kinds.includes(kind as Kind)) throw new Error('run needs kind: baseline, revert, break or edge.');
  if (!Array.isArray(command) || command.length < 1 || command.length > 64
    || command.some(item => typeof item !== 'string' || !item || item.length > 4096 || item.includes('\0'))) {
    throw new Error('command is an argv array of 1-64 strings, each 1-4096 characters without NUL.');
  }
  if ((mutation !== undefined) !== (kind === 'break') || (edgeTest !== undefined) !== (kind === 'edge')) throw new Error('break needs mutation and edge needs edgeTest; no other kind takes either.');
  if (cwd !== undefined && typeof cwd !== 'string') throw new Error('cwd must be a repository-relative directory.');
  const change = kind === 'break' ? mutation : kind === 'edge' ? edgeTest : null;
  return { kind: kind as Kind, command: [...command], cwd, change: change === null ? null : structuredClone(change as Record<string, unknown>) };
}

function writeReceipt(paths: Paths, index: Index, fields: Record<string, unknown> & { index: number; kind: Kind; outcome: string; grade: string },
  stdout: Buffer, stderr: Buffer, diff: string): string {
  const folder = `${index.runId}.tests/${fields.index}-${fields.kind}`;
  const directory = join(paths.directory, folder);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, 'stdout.txt'), stdout, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, 'stderr.txt'), stderr, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, 'change.diff'), diff, { flag: 'wx', mode: 0o600 });
  const encoded = JSON.stringify({ schemaVersion: 1, runId: index.runId, ...fields, stdoutSha256: digest(stdout), stderrSha256: digest(stderr) }, null, 2) + '\n';
  saveAtomic(join(directory, 'receipt.json'), encoded);
  index.runs.push({ index: fields.index, kind: fields.kind, outcome: fields.outcome, grade: fields.grade, receipt: { path: `${folder}/receipt.json`, sha256: digest(encoded) } });
  saveAtomic(paths.index, JSON.stringify(index) + '\n');
  return join(directory, 'receipt.json');
}

/** Kills an interrupted run's process group, unless its id now belongs to a leader that started at another time. */
function stopGroup(intent: Record<string, unknown> | null): void {
  const group = intent?.group;
  const spawnedAt = Date.parse(String(intent?.spawnedAt));
  if (typeof group !== 'number' || !Number.isInteger(group) || group <= 1 || !Number.isFinite(spawnedAt)) return;
  const leader = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(group)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  // ps prints whole seconds of local time.
  const started = Date.parse(leader.stdout?.trim() ?? '');
  if (!Number.isFinite(started) || Math.abs(started - spawnedAt) > 2000) return;
  try { process.kill(-group, 'SIGKILL'); } catch { /* The group exited meanwhile. */ }
}

/** A run whose intent outlived its session: index a receipt it finished, else record it as interrupted. */
function recover(paths: Paths, index: Index): void {
  let intent: Record<string, unknown> | null = null;
  try { intent = JSON.parse(boundedRead(paths.active).toString('utf8')); } catch { /* An unreadable intent is still an interrupted run. */ }
  const pid = intent?.pid;
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
    throw new Error(`A test run from process ${pid} may still be active for this review; wait for it, or remove ${paths.active} if no review is running.`);
  }
  stopGroup(intent);
  // Processes of the interrupted run may still write to its workspace, so nothing touches that path again.
  index.workspace = null;
  const number = index.runs.length + 1;
  if (typeof intent?.index === 'number' && intent.index < number) {
    saveAtomic(paths.index, JSON.stringify(index) + '\n');
    return unlinkSync(paths.active);
  }
  const kind = kinds.includes(intent?.kind as Kind) ? intent!.kind as Kind : 'baseline';
  const folder = join(paths.directory, `${index.runId}.tests`, `${number}-${kind}`);
  try {
    const bytes = boundedRead(join(folder, 'receipt.json'));
    const receipt = JSON.parse(bytes.toString('utf8'));
    const intact = receipt.runId === index.runId && receipt.index === number && receipt.kind === kind
      && [['stdout.txt', 'stdoutSha256'], ['stderr.txt', 'stderrSha256'], ['change.diff', 'changeSha256']].every(([file, key]) => digest(boundedRead(join(folder, file))) === receipt[key]);
    if (intact) {
      index.runs.push({ index: number, kind, outcome: receipt.outcome, grade: receipt.grade, receipt: { path: `${index.runId}.tests/${number}-${kind}/receipt.json`, sha256: digest(bytes) } });
      saveAtomic(paths.index, JSON.stringify(index) + '\n');
      return unlinkSync(paths.active);
    }
  } catch { /* No complete receipt: record the run as interrupted below. */ }
  removeTree(folder);
  const empty = Buffer.alloc(0);
  writeReceipt(paths, index, {
    index: number, kind, command: intent?.command ?? null, cwd: intent?.cwd ?? null, sandbox: index.settings.sandbox, change: intent?.change ?? null,
    changeSha256: digest(''), baseline: intent?.baseline ?? null, startedAt: intent?.startedAt ?? null, durationMs: null, status: 'interrupted',
    exitCode: null, signal: null, truncated: { stdout: false, stderr: false }, outcome: 'interrupted', grade: 'unknown',
  }, empty, empty, '');
  unlinkSync(paths.active);
}

/** Whether an edge command loads its new file: by naming it, by naming a directory that holds it, or not at all. Options and absolute paths name nothing. */
function edgeReference(request: Request): 'file' | 'directory' | null {
  if (request.kind !== 'edge') return null;
  const file = (request.change as { path: string }).path;
  const named = request.command.slice(1).filter(arg => !arg.startsWith('-') && !posix.isAbsolute(arg))
    .map(arg => posix.normalize(posix.join(request.cwd, arg)).replace(/(.)\/+$/, '$1'));
  if (named.includes(file)) return 'file';
  return named.some(path => path === '.' || file.startsWith(`${path}/`)) ? 'directory' : null;
}

/** An edge command that names its new file cannot run as a baseline, so any passed baseline in the same cwd shows the harness works. */
function passedBaseline(paths: Paths, index: Index, request: Request, anyCommand: boolean): number | null {
  for (const run of [...index.runs].reverse()) {
    if (run.kind !== 'baseline' || run.outcome !== 'passed') continue;
    const bytes = boundedRead(join(paths.directory, run.receipt.path));
    if (digest(bytes) !== run.receipt.sha256) throw new Error(`Receipt ${run.receipt.path} changed since it was indexed.`);
    const receipt = JSON.parse(bytes.toString('utf8'));
    const sameCommand = anyCommand || JSON.stringify(receipt.command) === JSON.stringify(request.command);
    if (sameCommand && receipt.cwd === request.cwd) return run.index;
  }
  return null;
}

async function execute(paths: Paths, index: Index, workspace: string, request: Request, baseline: number | null, signal?: AbortSignal) {
  const number = index.runs.length + 1;
  const cwd = resolveCwd(workspace, index.components, request.cwd);
  resetTemporary(workspace);
  const intent = { schemaVersion: 1, runId: index.runId, index: number, kind: request.kind, command: request.command,
    cwd: request.cwd, change: request.change, baseline, startedAt: new Date().toISOString(), pid: process.pid, workspace };
  saveAtomic(paths.active, JSON.stringify(intent) + '\n', true);
  let applied: ReturnType<typeof applyChange> | null = null;
  try {
    if (request.kind !== 'baseline') applied = applyChange(workspace, analysisOf(index), request.kind, request.change);
  } catch (error) {
    unlinkSync(paths.active);
    throw error;
  }
  const recordGroup = (group: number) => {
    try { saveAtomic(paths.active, JSON.stringify({ ...intent, group, spawnedAt: new Date().toISOString() }) + '\n'); }
    catch { /* Recovery then cannot stop the group; the workspace move below still contains it. */ }
  };
  let workspaceReset: string | undefined;
  let execution;
  try {
    execution = await runCommand({ command: request.command, cwd, env: testEnvironment(workspace, cwd), timeoutMs: index.settings.timeoutSeconds * 1000,
      profile: index.settings.sandbox ? sandboxProfile(workspace) : null, signal, onSpawn: recordGroup });
  } finally {
    // Processes that left the group keep write access to `workspace`, so the restore and every later write use the new path.
    index.workspace = rotateWorkspace(workspace);
    if (!index.workspace) workspaceReset = 'The run removed or replaced the workspace root; the next run rebuilds it.';
    else if (applied) {
      try { applied.restore(index.workspace); } catch (error) {
        workspaceReset = `${message(error)} The workspace was abandoned and the next run rebuilds it.`;
        try { removeTree(index.workspace); } catch { /* Completion removes the whole workspaces directory later. */ }
        index.workspace = null;
      }
    }
  }
  const { outcome, grade } = gradeRun(request.kind, execution.status, execution.exitCode);
  const diff = applied?.diff ?? '';
  const receipt = writeReceipt(paths, index, {
    index: number, kind: request.kind, command: request.command, cwd: request.cwd, sandbox: index.settings.sandbox, change: request.change,
    changeSha256: digest(diff), baseline, startedAt: intent.startedAt, durationMs: execution.durationMs, status: execution.status, exitCode: execution.exitCode,
    signal: execution.signal, truncated: execution.truncated, outcome, grade,
  }, execution.stdout, execution.stderr, diff);
  unlinkSync(paths.active);
  return {
    index: number, kind: request.kind, outcome, grade, status: execution.status, exitCode: execution.exitCode, durationMs: execution.durationMs, receipt,
    output: execution.tail, ...(execution.error ? { error: execution.error } : {}), ...(workspaceReset ? { workspaceReset } : {}),
  };
}

function plan(paths: Paths, review: Record<string, unknown>, live: TestSettings, sessionId: string, runId: string, hasUI: boolean) {
  const index = loadIndex(paths, sessionId, runId);
  const settings = index?.settings ?? live;
  const inFlight = existsSync(paths.active);
  const used = (index?.runs.length ?? 0) + (inFlight ? 1 : 0);
  const built = inFlight ? null : usableWorkspace(paths, index);
  let reason = unavailable(live, settings);
  let analysis: Analysis | null = null;
  let suggestedTests: string[] = [];
  let candidates: ReturnType<typeof breakCandidates> = [];
  if (!reason) {
    try {
      const target = resolveTarget(review.preflight);
      analysis = index && built ? analysisOf(index) : analyzeTarget(target);
      reason = analysis.files.length ? cloneProblem(analysis.root, paths.directory) : 'The review has no changed files to test.';
      suggestedTests = suggestTests(analysis);
      candidates = breakCandidates(analysis, headReader(analysis, built ?? undefined));
    } catch (error) { reason = message(error); }
  }
  reason ??= hasUI ? null : 'Only the top-level review session runs tests, and this session has no UI; propose the runs in your report instead.';
  return {
    available: !reason, reason, sandbox: settings.sandbox, budget: { maxRuns: settings.maxRuns, used, remaining: Math.max(0, settings.maxRuns - used) },
    timeoutSeconds: settings.timeoutSeconds, base: analysis?.base ?? null, head: analysis?.head ?? null, headState: analysis?.headState ?? null,
    components: analysis?.components.map(display) ?? [], files: analysis?.files.map(({ path, status, test, ranges }) => ({ path, status, test, ranges })) ?? [],
    suggestedTests, breakCandidates: candidates,
  };
}

async function run(paths: Paths, review: Record<string, unknown>, live: TestSettings, input: Record<string, unknown>, owner: string, signal?: AbortSignal) {
  const requested = readRequest(input);
  const loaded = loadIndex(paths, String(input.sessionId), String(input.runId));
  const settings = loaded?.settings ?? live;
  const reason = unavailable(live, settings);
  if (reason) throw new Error(reason);
  if (loaded && loaded.owner !== owner) throw new Error('Test runs for this review belong to another session.');
  if (!loaded && existsSync(paths.active)) throw new Error(`${paths.active} exists without its index; inspect and remove it to continue.`);
  const target = resolveTarget(review.preflight);
  if (loaded && existsSync(paths.active)) recover(paths, loaded);
  if ((loaded?.runs.length ?? 0) >= settings.maxRuns) throw new Error(`The test budget is exhausted: ${settings.maxRuns} of ${settings.maxRuns} runs used.`);
  const identity = { runId: String(input.runId), sessionId: String(input.sessionId), owner, settings };
  let current = loaded && usableWorkspace(paths, loaded) ? loaded : rebuild(paths, loaded, target, identity);
  let workspace = current.workspace!;
  const cwd = requested.cwd || undefined;
  if (cwd === undefined && current.components.length !== 1) throw new Error(`cwd is required when the change spans several components: ${current.components.map(display).join(', ')}.`);
  const request: Request = { ...requested, cwd: cwd ?? display(current.components[0]) };
  const directory = resolveCwd(workspace, current.components, request.cwd);
  if (request.kind !== 'baseline') planChange(workspace, analysisOf(current), request.kind, request.change);
  const reference = edgeReference(request);
  if (request.kind === 'edge' && !reference) {
    throw new Error(`An edge command must name its test file ${(request.change as { path: string }).path} or a directory that holds it, relative to cwd ${request.cwd}; otherwise nothing shows the file ran.`);
  }
  if (!executable(request.command[0], directory, testEnvironment(workspace, directory).PATH)) throw new Error(`${request.command[0]} is not an executable file in ${request.cwd} or on PATH.`);
  const baseline = request.kind === 'baseline' ? null : passedBaseline(paths, current, request, reference === 'file');
  if (baseline === null && reference === 'file') throw new Error(`An edge command that names its new file needs a passed baseline in ${request.cwd} first; run kind "baseline" with the focused test command.`);
  const needed = request.kind === 'baseline' || baseline !== null ? 1 : 2;
  const remaining = settings.maxRuns - current.runs.length;
  if (remaining < needed) throw new Error(`The test budget has ${remaining} run${remaining === 1 ? '' : 's'} left; this needs ${needed}, counting the automatic baseline.`);
  let automatic: Awaited<ReturnType<typeof execute>> | undefined;
  if (request.kind !== 'baseline' && baseline === null) {
    automatic = await execute(paths, current, workspace, { kind: 'baseline', command: request.command, cwd: request.cwd, change: null }, null, signal);
    if (automatic.outcome !== 'passed' || signal?.aborted) {
      return { baseline: automatic, result: null, remaining: settings.maxRuns - current.runs.length,
        note: `The automatic baseline ${automatic.outcome === 'passed' ? 'passed, but the call was cancelled' : `was ${automatic.outcome}`}; the ${request.kind} run did not start.` };
    }
    if (!current.workspace) current = rebuild(paths, current, target, identity);
    workspace = current.workspace!;
  }
  const result = await execute(paths, current, workspace, request, baseline ?? automatic?.index ?? null, signal);
  return { ...result, ...(automatic ? { baseline: automatic } : {}), remaining: settings.maxRuns - current.runs.length };
}

function respond(details: Record<string, unknown>) {
  let text = JSON.stringify(details);
  if (text.length > 16000 && Array.isArray(details.files)) {
    const files = details.files as unknown[];
    text = JSON.stringify({ ...details, files: files.slice(0, 60), omittedFiles: files.length - 60 });
  }
  return { content: [{ type: 'text' as const, text }], details };
}

export function registerReviewTests(pi: ExtensionAPI, root: string): void {
  pi.registerTool({
    name: 'agentic_code_review_run_tests',
    label: 'Run review tests',
    description: readFileSync(new URL('../prompts/run-tests.md', import.meta.url), 'utf8').trim(),
    executionMode: 'sequential',
    parameters: Type.Object({
      sessionId: Type.String({ maxLength: 128 }),
      runId: Type.String({ maxLength: 128 }),
      operation: Type.Union([Type.Literal('plan'), Type.Literal('run')]),
      kind: Type.Optional(Type.Union(kinds.map(kind => Type.Literal(kind)))),
      command: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 64, description: 'argv; there is no shell' })),
      cwd: Type.Optional(Type.String({ maxLength: 4096, description: 'Repository-relative directory inside a copied component' })),
      mutation: Type.Optional(Type.Object({
        path: Type.String({ maxLength: 4096 }), line: Type.Integer({ minimum: 1 }), before: Type.String({ minLength: 1, maxLength: 500 }),
        after: Type.String({ maxLength: 500 }), safeguard: Type.String({ minLength: 1, maxLength: 300 }),
      }, { additionalProperties: false })),
      edgeTest: Type.Optional(Type.Object({
        path: Type.String({ maxLength: 4096 }), content: Type.String({ maxLength: 65536 }), codePath: Type.String({ minLength: 1, maxLength: 300 }),
      }, { additionalProperties: false })),
    }, { additionalProperties: false }),
    async execute(_id, input, signal, _update, ctx) {
      signal?.throwIfAborted();
      const fields = input as Record<string, unknown>;
      if (Object.keys(fields).some(key => !['sessionId', 'runId', 'operation', 'kind', 'command', 'cwd', 'mutation', 'edgeTest'].includes(key))) throw new Error('Unexpected test-run argument.');
      const { sessionId, runId, operation } = input;
      if (!idPattern.test(sessionId) || !idPattern.test(runId)) throw new Error('Invalid test-run review identity.');
      const directory = join(root, sessionId);
      const review = JSON.parse(boundedRead(join(directory, `${runId}.review.json`)).toString('utf8'));
      if (review?.sessionId !== sessionId || review.runId !== runId || !['prepared', 'running'].includes(review.status)) {
        throw new Error('Test runs need this review prepared or running, with matching session and run IDs.');
      }
      const paths: Paths = { directory, index: join(directory, `${runId}.tests.json`), active: join(directory, `${runId}.tests.active`), workspaces: join(directory, `${runId}.tests`, 'workspaces') };
      const live = readTestSettings(root);
      if (operation === 'plan') {
        if (['kind', 'command', 'cwd', 'mutation', 'edgeTest'].some(key => fields[key] !== undefined)) throw new Error('plan takes only sessionId, runId and operation.');
        return respond(plan(paths, review, live, sessionId, runId, ctx?.hasUI === true));
      }
      if (operation !== 'run') throw new Error('operation is plan or run.');
      // In-process lanes and headless sessions have no UI; like approved experiments, runs stay with the top-level session.
      if (ctx?.hasUI !== true) throw new Error('Only the top-level review session runs tests, and this session has no UI; propose the run in your report instead.');
      const key = paths.index;
      if (active.has(key)) throw new Error('Another test run is active for this review; runs are serial.');
      active.add(key);
      try {
        return respond(await run(paths, review, live, fields, ctx.sessionManager.getSessionId(), signal));
      } finally { active.delete(key); }
    },
  });
}
