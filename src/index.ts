import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerFindings } from './findings.ts';
import { registerCodebaseLearning } from './codebase.ts';
import { registerReviewWave } from './wave.ts';
import {
  completionFileName,
  formatPreflight,
  launchReviewPane,
  preflightReview,
  runHeadlessReview,
  type ReviewPreflight,
} from './runtime.ts';

const promptPath = (name: string) => fileURLToPath(new URL(`../prompts/${name}.md`, import.meta.url));
const readPrompt = (name: string) => readFileSync(promptPath(name), 'utf8');
function prepareReview(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  context: string,
  root: string,
  preflight: ReviewPreflight,
  signal?: AbortSignal,
  preparedRunId?: string,
) {
  signal?.throwIfAborted();
  const { intake, ...preflightRecord } = preflight;
  if (typeof context !== 'string' || context.length > 8000) {
    throw new Error('Review context must be at most 8000 characters.');
  }

  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionId || sessionId.length > 128 || /[^A-Za-z0-9_-]/.test(sessionId)) {
    throw new Error('Invalid review session ID.');
  }

  const prompts = {
    workflow: promptPath('workflow'),
    collect: promptPath('collect'),
    reviewZone: promptPath('review-zone'),
    artifacts: promptPath('artifacts'),
    presentation: promptPath('presentation'),
    voice: promptPath('voice'),
    taste: promptPath('taste'),
    prContext: promptPath('pr-context'),
    session: promptPath('session-launch'),
  };
  for (const path of Object.values(prompts)) {
    accessSync(path);
  }
  const launch = readPrompt('session-launch');

  const runId = preparedRunId ?? randomUUID();
  const directory = join(root, sessionId);
  const name = `review-${runId.slice(0, 8)}`;
  const paths = {
    map: join(directory, `${runId}.map.jsonl`),
    bugs: join(directory, `${runId}.bugs.json`),
    review: join(directory, `${runId}.review.json`),
    pr: join(directory, `${runId}.pr.md`),
    threads: join(directory, `${runId}.pr-threads.md`),
    prContext: join(directory, `${runId}.pr-context.json`),
    patch: join(directory, `${runId}.patch`),
    mission: join(directory, `${runId}.mission.md`),
    complete: join(directory, completionFileName(runId)),
  };
  const metadata = {
    schemaVersion: 1,
    presentationVersion: 1,
    runId,
    sessionId,
    cwd: ctx.cwd,
    context,
    createdAt: new Date().toISOString(),
  };
  const details = {
    ...metadata,
    historyRoot: root,
    codebasesRoot: join(root, 'codebases'),
    paths,
    prompts,
    preflight: preflightRecord,
    reviewSession: { name },
  };
  const mission = launch.replace('{{review}}', () => JSON.stringify(paths.review));

  if (Buffer.byteLength(JSON.stringify(details)) > 50_000) {
    throw new Error('Encoded review context is too large.');
  }

  const files: Array<[string, unknown]> = [
    [paths.map, {
      ...metadata,
      id: runId,
      kind: 'run',
      state: 'prepared',
      repository: null,
      revision: null,
      preflight: preflightRecord,
      sources: [],
    }],
    [paths.bugs, {
      ...metadata,
      status: 'prepared',
      bugs: [],
      findings: [],
    }],
    [paths.review, {
      ...details,
      status: 'prepared',
      grades: { merge: null, deploy: null },
      commentDrafts: [],
      collection: null,
      collectors: 0,
      pack: null,
      prContext: intake ? {
        provider: preflightRecord.provider,
        url: preflightRecord.target,
        number: preflightRecord.number,
        title: preflightRecord.title,
        base: preflightRecord.base,
        head: preflightRecord.head,
        gaps: intake.gaps,
        files: [paths.pr, paths.threads, paths.prContext, ...(intake.diff ? [paths.patch] : [])],
      } : null,
      learning: null,
      timing: null,
    }],
  ];

  const textFiles: Array<[string, string]> = [
    [paths.mission, mission],
    ...(intake ? [
      [paths.pr, `# ${preflightRecord.title ?? preflightRecord.target}\n\n${intake.body}`],
      [paths.threads, intake.threads || `No review-thread text fetched.\n${intake.gaps.join('\n')}`],
      [paths.prContext, `${JSON.stringify({ pr: intake.data, checks: intake.checks, gaps: intake.gaps })}\n`],
      ...(intake.diff ? [[paths.patch, intake.diff]] as Array<[string, string]> : []),
    ] as Array<[string, string]> : []),
  ];

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const created: string[] = [];
  try {
    for (const [path, data] of files) {
      const fd = openSync(path, 'wx', 0o600);
      created.push(path);
      try {
        writeFileSync(fd, `${JSON.stringify(data)}\n`);
      } finally {
        closeSync(fd);
      }
    }
    for (const [path, content] of textFiles) {
      const fd = openSync(path, 'wx', 0o600);
      created.push(path);
      try { writeFileSync(fd, content); } finally { closeSync(fd); }
    }
  } catch (error) {
    for (const path of created) {
      unlinkSync(path);
    }
    throw error;
  }

  return { details, mission };
}

const completionWatchers = new Map<string, FSWatcher>();
const processMonitors = new Map<string, AbortController>();
const watchdogEnabled = (pi: ExtensionAPI) => (pi as ExtensionAPI & { __disableAutoReviewWatchdog?: boolean }).__disableAutoReviewWatchdog !== true;

function watchCompletion(pi: ExtensionAPI, run: ReturnType<typeof prepareReview>): () => void {
  const { runId, paths, reviewSession } = run.details;
  const directory = dirname(paths.complete);
  let closed = false;
  let watcher: FSWatcher;
  const close = () => {
    if (closed) return;
    closed = true;
    watcher?.close();
    completionWatchers.delete(runId);
  };
  const completed = () => {
    if (!existsSync(paths.complete)) return;
    const marker = JSON.parse(readFileSync(paths.complete, 'utf8')) as { summary?: unknown; status?: unknown };
    close();
    processMonitors.get(runId)?.abort();
    processMonitors.delete(runId);
    pi.sendMessage({
      customType: 'agentic-code-review-complete',
      content: `Review session ${reviewSession.name} finished (${String(marker.status ?? 'unknown')}). Read ${paths.review}, ${paths.bugs} and the relevant records in ${paths.map}, then present the review under the saved presentation and voice prompts. The pane's draft summary was: ${String(marker.summary ?? '').slice(0, 5000)}`,
      details: { runId, paths, reviewSession, marker },
      display: true,
    }, { triggerTurn: true, deliverAs: 'followUp' });
  };
  watcher = watch(directory, () => completed());
  completionWatchers.set(runId, watcher);
  completed();
  return close;
}

function monitorReviewProcess(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  run: ReturnType<typeof prepareReview>,
  initial: { name: string; paneId: string; model: string; thinking: 'medium' },
): void {
  const { runId, paths, preflight } = run.details;
  const controller = new AbortController();
  processMonitors.set(runId, controller);
  void (async () => {
    let reviewSession = initial;
    let fallbackStarted = false;
    while (!controller.signal.aborted && !existsSync(paths.complete)) {
      const settled = await pi.exec('herdr', [
        'agent', 'wait', reviewSession.name,
        '--until', 'idle', '--until', 'done', '--until', 'blocked', '--timeout', '3600000',
      ], { signal: controller.signal, timeout: 3_610_000 }).catch(error => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
      if (controller.signal.aborted || existsSync(paths.complete)) break;
      let status = '';
      try { status = String((JSON.parse(settled.stdout) as { result?: { agent?: { agent_status?: unknown } } }).result?.agent?.agent_status ?? ''); } catch { status = ''; }
      if (status === 'blocked') {
        await pi.exec('herdr', ['agent', 'wait', reviewSession.name, '--until', 'working', '--timeout', '3600000'], { signal: controller.signal, timeout: 3_610_000 }).catch(() => undefined);
        continue;
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
      if (existsSync(paths.complete)) break;
      const resume = await pi.exec('herdr', ['agent', 'prompt', reviewSession.name, `Resume the auto-review mission at ${paths.mission}. Finish every required item and call agentic_code_review_complete.`], { signal: controller.signal, timeout: 30_000 }).catch(error => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
      if (resume.code === 0) continue;
      if (!fallbackStarted) {
        reviewSession = await launchReviewPane(pi, ctx, { name: `${run.details.reviewSession.name}-fallback`, missionPath: paths.mission, preflight });
        fallbackStarted = true;
      }
    }
    processMonitors.delete(runId);
  })();
}

function completionDelivered(ctx: ExtensionContext, runId: string): boolean {
  return ctx.sessionManager.getEntries().some(entry => entry.type === 'message'
    && entry.message.role === 'custom'
    && entry.message.customType === 'agentic-code-review-complete'
    && (entry.message.details as { runId?: unknown } | undefined)?.runId === runId);
}

export function registerReview(pi: ExtensionAPI, root = join(getAgentDir(), 'auto-review')): void {
  registerFindings(pi, root);
  registerCodebaseLearning(pi, root);
  registerReviewWave(pi);

  pi.registerTool({
    name: 'agentic_code_review_complete',
    label: 'Complete review session',
    description: 'Finish one prepared auto-review after its final review JSON, bug handoff and learning have been saved. Called only by the dedicated top-level review session. Writes the completion marker that wakes the invoking Pi session, returns the human report and terminates the review turn.',
    parameters: Type.Object({
      sessionId: Type.String({ maxLength: 128 }),
      runId: Type.String(),
      summary: Type.String({ minLength: 1, maxLength: 5000 }),
    }),
    async execute(_id, { sessionId, runId, summary }, signal) {
      signal?.throwIfAborted();
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) throw new Error('Invalid review completion identity.');
      const reviewPath = join(root, sessionId, `${runId}.review.json`);
      const completePath = join(root, sessionId, completionFileName(runId));
      const review: unknown = JSON.parse(readFileSync(reviewPath, 'utf8'));
      if (!review || typeof review !== 'object' || (review as { status?: unknown }).status !== 'complete' || typeof (review as { completedAt?: unknown }).completedAt !== 'string') {
        throw new Error('Complete the review JSON and its completedAt timestamp before the handoff.');
      }
      const finalReview = review as { findings?: unknown; commentDrafts?: unknown };
      const findings = Array.isArray(finalReview.findings) ? finalReview.findings : [];
      const drafts = Array.isArray(finalReview.commentDrafts) ? finalReview.commentDrafts : [];
      const acceptedIds = findings.filter(item => item && typeof item === 'object' && (item as { state?: unknown }).state === 'accepted').map(item => (item as { id?: unknown }).id).filter((id): id is string => typeof id === 'string');
      const validDrafts = drafts.filter(item => item && typeof item === 'object' && typeof (item as { findingId?: unknown }).findingId === 'string' && typeof (item as { path?: unknown }).path === 'string' && Number.isInteger((item as { line?: unknown }).line) && typeof (item as { body?: unknown }).body === 'string' && Boolean((item as { body: string }).body.trim()));
      if (validDrafts.length !== drafts.length || acceptedIds.some(id => !validDrafts.some(item => (item as { findingId: string }).findingId === id))) {
        throw new Error('Every accepted finding needs one valid commentDraft before completion.');
      }
      const marker = { sessionId, runId, status: (review as { status: string }).status, completedAt: (review as { completedAt: string }).completedAt, summary };
      const encoded = `${JSON.stringify(marker)}\n`;
      if (existsSync(completePath)) {
        if (readFileSync(completePath, 'utf8') !== encoded) throw new Error('A different completion was already saved for this run.');
      } else {
        const temp = `${completePath}.${randomUUID()}.tmp`;
        const fd = openSync(temp, 'wx', 0o600);
        try { writeFileSync(fd, encoded); } finally { closeSync(fd); }
        renameSync(temp, completePath);
      }
      return { content: [{ type: 'text' as const, text: summary }], details: marker, terminate: true };
    },
  });

  const launch = async (context: string, ctx: ExtensionContext, signal?: AbortSignal, prepared?: ReviewPreflight, preparedRunId?: string, checkout?: string) => {
    signal?.throwIfAborted();
    const preflight = prepared ?? await preflightReview(pi, ctx, context, root, checkout);
    const run = prepareReview(pi, ctx, context, root, preflight, signal, preparedRunId);
    const closeWatcher = watchCompletion(pi, run);
    try {
      let reviewSession;
      try {
        reviewSession = await launchReviewPane(pi, ctx, { name: run.details.reviewSession.name, missionPath: run.details.paths.mission, preflight });
      } catch {
        reviewSession = await runHeadlessReview(pi, { name: `${run.details.reviewSession.name}-headless`, missionPath: run.details.paths.mission, preflight });
      }
      if (reviewSession.paneId !== 'headless' && watchdogEnabled(pi)) monitorReviewProcess(pi, ctx, run, reviewSession);
      const { runId, sessionId, paths } = run.details;
      return {
        content: [{
          type: 'text' as const,
          text: `${formatPreflight(preflight, paths.review)}\nSession: ${reviewSession.name}${reviewSession.paneId === 'headless' ? ' (headless recovery)' : ` in Herdr pane ${reviewSession.paneId}`}\n\nThis Pi session will receive one completion handoff from ${paths.complete}.`,
        }],
        details: { runId, sessionId, paths, preflight: run.details.preflight, reviewSession },
      };
    } catch (error) {
      closeWatcher();
      throw error;
    }
  };

  pi.on('session_shutdown', () => {
    for (const watcher of completionWatchers.values()) watcher.close();
    completionWatchers.clear();
    for (const monitor of processMonitors.values()) monitor.abort();
    processMonitors.clear();
  });

  pi.on('session_start', async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const directory = join(root, sessionId);
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory).filter(item => item.endsWith('.review.json'))) {
      try {
        const review = JSON.parse(readFileSync(join(directory, name), 'utf8')) as ReturnType<typeof prepareReview>['details'] & { status?: string };
        if (!review.runId || !review.paths?.complete || !review.paths?.mission || !review.reviewSession?.name || !review.preflight || completionDelivered(ctx, review.runId)) continue;
        const run = { details: review, mission: readFileSync(review.paths.mission, 'utf8') } as ReturnType<typeof prepareReview>;
        watchCompletion(pi, run);
        if (existsSync(review.paths.complete)) continue;
        const current = await pi.exec('herdr', ['agent', 'get', review.reviewSession.name], { timeout: 10_000 }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
        let reviewSession: { name: string; paneId: string; model: string; thinking: 'medium' };
        if (current.code === 0) {
          const parsed = JSON.parse(current.stdout) as { result?: { agent?: { pane_id?: string } } };
          reviewSession = { name: review.reviewSession.name, paneId: String(parsed.result?.agent?.pane_id ?? ''), model: review.preflight.model, thinking: 'medium' };
        } else {
          reviewSession = await launchReviewPane(pi, ctx, { name: `${review.reviewSession.name}-fallback`, missionPath: review.paths.mission, preflight: review.preflight });
        }
        if (watchdogEnabled(pi)) monitorReviewProcess(pi, ctx, run, reviewSession);
      } catch {
        // A concurrently written or historical artifact is retried on the next session start.
      }
    }
  });

  pi.registerCommand('code-review', {
    description: 'Preflight and start an automatic review in a dedicated visible Pi pane; optional context is plain text.',
    handler: async (context, ctx) => {
      try {
        const preflight = await preflightReview(pi, ctx, context, root);
        const sessionId = ctx.sessionManager.getSessionId();
        if (!sessionId || sessionId.length > 128 || /[^A-Za-z0-9_-]/.test(sessionId)) throw new Error('Invalid review session ID.');
        const runId = randomUUID();
        const artifact = join(root, sessionId, `${runId}.review.json`);
        if (ctx.hasUI && !(await ctx.ui.confirm('Start auto-review?', formatPreflight(preflight, artifact)))) return;
        const result = await launch(context, ctx, ctx.signal, preflight, runId);
        pi.sendMessage({
          customType: 'agentic-code-review',
          content: result.content,
          details: result.details,
          display: true,
        }, { triggerTurn: false });
      } catch (error) {
        if (!ctx.hasUI) throw error;
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });

  pi.registerTool({
    name: 'agentic_code_review',
    label: 'Agentic code review',
    description: readPrompt('entry'),
    parameters: Type.Object({
      context: Type.Optional(Type.String({
        description: 'Review request, optional URL and additional context, as plain text.',
        maxLength: 8000,
      })),
      checkout: Type.Optional(Type.String({
        description: 'Absolute local checkout for the target. Omit to reuse the newest matching checkout from prior review artifacts, then the invoking cwd.',
        maxLength: 4000,
      })),
    }),
    async execute(_id, { context = '', checkout }, signal, _onUpdate, ctx) {
      return launch(context, ctx, signal, undefined, undefined, checkout);
    },
  });
}

export default function agenticReview(pi: ExtensionAPI): void {
  registerReview(pi);
}
