import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { accessSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerFindings } from './findings.ts';
import { registerCodebaseLearning } from './codebase.ts';

const promptPath = (name: string) => fileURLToPath(new URL(`../prompts/${name}.md`, import.meta.url));
const prompt = (name: string) => readFileSync(promptPath(name), 'utf8');
const requestEvent = 'pi-extended-teams:orchestration-request';
const responseEvent = 'pi-extended-teams:orchestration-response';

function prepareReview(pi: ExtensionAPI, ctx: ExtensionContext, context: string, root: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (typeof context !== 'string' || context.length > 8000) throw new Error('Review context must be at most 8000 characters.');
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionId || sessionId.length > 128 || /[^A-Za-z0-9_-]/.test(sessionId)) throw new Error('Invalid review session ID.');
  const tools = pi.getActiveTools();
  if (!tools.includes('spawn_agent') && !tools.includes('spawn_swarm_agents')) {
    throw new Error('pi-extended-teams must provide an active spawn_agent or spawn_swarm_agents tool.');
  }

  const prompts = {
    coordinator: promptPath('coordinator'),
    workflow: promptPath('workflow'),
    collect: promptPath('collect'),
    'deep-collect': promptPath('deep-collect'),
    artifacts: promptPath('artifacts'),
    presentation: promptPath('presentation'),
  };
  for (const path of Object.values(prompts)) accessSync(path);
  const launch = prompt('launch');
  const runId = randomUUID(), directory = join(root, sessionId), name = `review-${runId}`;
  const paths = {
    map: join(directory, `${runId}.map.jsonl`),
    bugs: join(directory, `${runId}.bugs.json`),
    review: join(directory, `${runId}.review.json`),
  };
  const metadata = { schemaVersion: 1, presentationVersion: 1, runId, sessionId, cwd: ctx.cwd, context, createdAt: new Date().toISOString() };
  const details = { ...metadata, historyRoot: root, codebasesRoot: join(root, 'codebases'), paths, prompts, coordinator: { name } };
  const mission = launch.replace('{{coordinator}}', () => JSON.stringify(prompts.coordinator))
    .replace('{{review}}', () => JSON.stringify(paths.review));
  if (Buffer.byteLength(JSON.stringify(details)) > 50_000) throw new Error('Encoded review context is too large.');

  const files: Array<[string, unknown]> = [
    [paths.map, { ...metadata, id: runId, kind: 'run', state: 'prepared', repository: null, revision: null, sources: [] }],
    [paths.bugs, { ...metadata, status: 'prepared', bugs: [], findings: [] }],
    [paths.review, { ...details, status: 'prepared', grades: { merge: null, deploy: null } }],
  ];
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const created: string[] = [];
  try {
    for (const [path, data] of files) {
      const fd = openSync(path, 'wx', 0o600);
      created.push(path);
      try { writeFileSync(fd, `${JSON.stringify(data)}\n`); }
      finally { closeSync(fd); }
    }
  } catch (error) {
    for (const path of created) unlinkSync(path);
    throw error;
  }
  return { details, mission };
}

function requestCoordinator(pi: ExtensionAPI, ctx: ExtensionContext, run: ReturnType<typeof prepareReview>, signal?: AbortSignal): Promise<boolean> {
  const { runId, sessionId, paths, coordinator } = run.details;
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error, queued = false) => {
      clearTimeout(timer); unsubscribe(); signal?.removeEventListener('abort', interrupted);
      if (error) reject(error); else resolve(queued);
    };
    const interrupted = () => finish(new Error(`Review launch acknowledgement was interrupted; a coordinator may still start. Do not retry this run. Check ${coordinator.name}. Artifacts: ${paths.review}`));
    unsubscribe = pi.events.on(responseEvent, data => {
      if (!data || typeof data !== 'object') return;
      const response = data as { requestId?: unknown; type?: unknown; ok?: unknown; error?: unknown; details?: { queued?: unknown } };
      if (response.requestId !== runId || response.type !== 'spawn_agent') return;
      if (response.ok === true && response.details) finish(undefined, response.details.queued === true);
      else finish(new Error(`Review launch failed: ${String(response.error ?? 'invalid teams response').slice(0, 1000)}. Artifacts: ${paths.review}`));
    });
    timer = setTimeout(interrupted, 30_000);
    signal?.addEventListener('abort', interrupted, { once: true });
    if (signal?.aborted) { interrupted(); return; }
    try {
      pi.events.emit(requestEvent, {
        requestId: runId, type: 'spawn_agent', ctx,
        params: { name: coordinator.name, prompt: run.mission, cwd: ctx.cwd,
          model_slot: 'write-critical', allow_nested_read_agents: true,
          metadata: { runId, sessionId, paths } },
      });
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

export function registerReview(pi: ExtensionAPI, root = join(getAgentDir(), 'auto-review')): void {
  registerFindings(pi, root);
  registerCodebaseLearning(pi, root);
  const launch = async (context: string, ctx: ExtensionContext, signal?: AbortSignal) => {
    const run = prepareReview(pi, ctx, context, root, signal);
    const queued = await requestCoordinator(pi, ctx, run, signal);
    const { runId, sessionId, paths, coordinator } = run.details;
    // The coordinator can already be writing. Never rewrite its files after dispatch.
    return {
      content: [{ type: 'text' as const, text: `Review coordinator ${coordinator.name} ${queued ? 'queued' : 'started'}. Its report will arrive through pi-extended-teams. Artifacts: ${paths.review}` }],
      details: { runId, sessionId, paths, coordinator: { ...coordinator, queued } },
    };
  };
  pi.registerCommand('code-review', {
    description: 'Start an automatic review coordinator; optional context is plain text.',
    handler: async (context, ctx) => {
      try {
        const result = await launch(context, ctx, ctx.signal);
        pi.sendMessage({ customType: 'agentic-code-review', content: result.content, details: result.details, display: true }, { triggerTurn: false });
      } catch (error) {
        if (!ctx.hasUI) throw error;
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });
  pi.registerTool({
    name: 'agentic_code_review', label: 'Agentic code review', description: prompt('entry'),
    parameters: Type.Object({
      context: Type.Optional(Type.String({ description: 'Review request, optional URL and additional context, as plain text.', maxLength: 8000 })),
    }),
    async execute(_id, { context = '' }, signal, _onUpdate, ctx) { return launch(context, ctx, signal); },
  });
}

export default function agenticReview(pi: ExtensionAPI): void { registerReview(pi); }
