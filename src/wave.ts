import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { type ExtensionAPI, withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const MAX_WORKERS = 3;
const WORKER_SAFETY_TIMEOUT_SECONDS = 3600;
const OUTPUT_LIMIT = 12_000;

type WorkerInput = { name: string; kind: 'read-collect' | 'read-review'; prompt: string; items: string[] };
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
type WorkerResult = {
  name: string;
  kind: WorkerInput['kind'];
  status: 'completed' | 'timed_out' | 'failed';
  elapsedMs: number;
  model: string;
  thinking: 'medium';
  output: string;
  error: string | null;
  usage: Usage;
  artifact: string;
  unfinished: string[];
};

function finalText(message: unknown): string | undefined {
  if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'assistant') return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.filter(item => item && typeof item === 'object' && (item as { type?: unknown }).type === 'text').map(item => (item as { text?: unknown }).text).filter((text): text is string => typeof text === 'string');
  return texts.length ? texts.join('\n') : undefined;
}

function addUsage(total: Usage, message: unknown): void {
  if (!message || typeof message !== 'object') return;
  const usage = (message as { usage?: Record<string, unknown> }).usage;
  if (!usage) return;
  total.input += Number(usage.input ?? 0);
  total.output += Number(usage.output ?? 0);
  total.cacheRead += Number(usage.cacheRead ?? 0);
  total.cacheWrite += Number(usage.cacheWrite ?? 0);
  const cost = usage.cost;
  total.cost += typeof cost === 'object' && cost ? Number((cost as { total?: unknown }).total ?? 0) : 0;
}

async function writeArtifact(path: string, content: string): Promise<void> {
  await withFileMutationQueue(path, async () => {
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, content); } finally { closeSync(fd); }
  });
}

async function runWorker(input: WorkerInput, options: { cwd: string; outputDir: string; model: string; timeoutMs: number; signal?: AbortSignal }): Promise<WorkerResult> {
  const started = Date.now();
  const artifact = join(options.outputDir, `${input.name}.worker.json`);
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let output = '';
  let stderr = '';
  let timedOut = false;
  let aborted = false;

  const exitCode = await new Promise<number>(resolvePromise => {
    const args = [
      '--mode', 'json', '-p', '--no-session', '--no-approve',
      '--model', options.model, '--thinking', 'medium',
      '--no-skills', '--no-prompt-templates', '--no-context-files',
      '--tools', 'read,bash,agentic_code_review_append_finding',
      input.prompt,
    ];
    const grouped = process.platform !== 'win32';
    const child = spawn('pi', args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: grouped });
    let buffer = '';
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    };
    const stop = () => {
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 5_000);
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const interrupted = () => {
      aborted = true;
      stop();
    };
    options.signal?.addEventListener('abort', interrupted, { once: true });

    const line = (text: string) => {
      if (!text.trim()) return;
      try {
        const event = JSON.parse(text) as { type?: unknown; message?: unknown };
        if (event.type === 'message_end') {
          addUsage(usage, event.message);
          output = finalText(event.message) ?? output;
        }
      } catch {
        // JSON mode can still emit provider diagnostics; stderr is retained separately.
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const item of lines) line(item);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', error => { stderr += error.message; });
    child.on('close', code => {
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', interrupted);
      if (buffer) line(buffer);
      resolvePromise(code ?? 1);
    });
  });

  const status: WorkerResult['status'] = timedOut || aborted ? 'timed_out' : exitCode === 0 && output ? 'completed' : 'failed';
  const error = status === 'completed' ? null : timedOut ? `Process safety fuse fired after ${Math.round(options.timeoutMs / 1000)} seconds; partial output retained.` : aborted ? 'Parent review aborted the worker; partial output retained.' : (stderr.trim().slice(0, 2000) || `pi exited ${exitCode}`);
  const result: WorkerResult = { name: input.name, kind: input.kind, status, elapsedMs: Date.now() - started, model: options.model, thinking: 'medium', output, error, usage, artifact, unfinished: status === 'completed' ? [] : input.items }; 
  await writeArtifact(artifact, `${JSON.stringify(result)}\n`);
  return result;
}

export function registerReviewWave(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'agentic_code_review_wave',
    label: 'Run bounded review wave',
    description: 'Run one parallel auto-review wave: at most two read-review workers and one read-collect worker. Every worker is a fresh read-only Pi process using the top-level review model at medium. A one-hour process safety fuse stops a truly stuck process; the top-level review session completes its unfinished items directly. Returns every report in this result; there is no teams inbox, completion group, polling or later wave.',
    parameters: Type.Object({
      workers: Type.Array(Type.Object({
        name: Type.String({ pattern: '^[a-z][a-z0-9-]{0,31}$' }),
        kind: Type.String({ pattern: '^read-(?:collect|review)$' }),
        prompt: Type.String({ minLength: 1, maxLength: 20_000 }),
        items: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 12, description: 'Exact unit IDs or gap questions this worker owns. Returned as unfinished when the process fails or reaches its deadline.' }),
      }), { minItems: 1, maxItems: MAX_WORKERS }),
      output_dir: Type.String({ minLength: 1, maxLength: 4000 }),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: WORKER_SAFETY_TIMEOUT_SECONDS, description: 'Process safety fuse. Runtime uses 3600 seconds; tests may inject a lower value.' })),
    }),
    async execute(_id, { workers, output_dir: outputDir, timeout_seconds: timeoutSeconds = WORKER_SAFETY_TIMEOUT_SECONDS }, signal, onUpdate, ctx) {
      if (!ctx.model?.reasoning || ctx.model.thinkingLevelMap?.medium === null) throw new Error('The review wave needs a model that supports medium thinking.');
      if (!isAbsolute(outputDir)) throw new Error('Review wave output_dir must be absolute.');
      const resolvedOutput = resolve(outputDir);
      mkdirSync(resolvedOutput, { recursive: true, mode: 0o700 });
      const reviewerCount = workers.filter((worker: WorkerInput) => worker.kind === 'read-review').length;
      const collectorCount = workers.filter((worker: WorkerInput) => worker.kind === 'read-collect').length;
      if (reviewerCount > 2 || collectorCount > 1) throw new Error('A review wave allows at most two read-review workers and one read-collect worker.');
      if (new Set(workers.map((worker: WorkerInput) => worker.name)).size !== workers.length) throw new Error('Review worker names must be unique.');

      const model = `${ctx.model.provider}/${ctx.model.id}`;
      const started = Date.now();
      let finished = 0;
      const results = await Promise.all(workers.map(async (worker: WorkerInput) => {
        const result = await runWorker(worker, { cwd: ctx.cwd, outputDir: resolvedOutput, model, timeoutMs: timeoutSeconds * 1000, signal });
        finished += 1;
        onUpdate?.({ content: [{ type: 'text', text: `Review wave: ${finished}/${workers.length} workers settled.` }], details: { finished, total: workers.length } });
        return result;
      }));
      const summary = results.map(result => `## ${result.name} [${result.kind}, ${result.status}, ${(result.elapsedMs / 1000).toFixed(1)}s]\n${result.output.slice(0, OUTPUT_LIMIT) || result.error || '(no output)'}${result.unfinished.length ? `\n\nTop-level review must finish directly: ${result.unfinished.join('; ')}` : ''}${result.output.length > OUTPUT_LIMIT ? `\n\n[Full report: ${result.artifact}]` : ''}`).join('\n\n');
      return {
        content: [{ type: 'text' as const, text: summary }],
        details: { model, thinking: 'medium', elapsedMs: Date.now() - started, timeoutSeconds, results },
      };
    },
  });
}
