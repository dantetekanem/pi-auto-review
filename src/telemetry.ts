import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
type Fields = Record<string, unknown>;
type Request = { id: number; started: number; firstDelta?: number; firstText?: number; stage: number | null; model: string | null };

// One extension instance writes one stream; the coordinator never rewrites it.
export function registerTelemetry(pi: ExtensionAPI, root: string, now = () => performance.now()): void {
  let binding: { sessionId: string; runId: string; agentSessionId: string; path: string } | undefined;
  let active: { stage: number; started: number } | undefined;
  let request: Request | undefined;
  let sequence = 0, requestSequence = 0, failed = false;
  const tools = new Map<string, { started: number; stage: number | null; name: string }>();
  const emit = (kind: string, fields: Fields = {}) => {
    if (!binding || failed) return;
    try {
      appendFileSync(binding.path, `${JSON.stringify({ schemaVersion: 1, sessionId: binding.sessionId,
        runId: binding.runId, agentSessionId: binding.agentSessionId, sequence: ++sequence,
        at: new Date().toISOString(), stage: active?.stage ?? null, kind, ...fields })}\n`, { mode: 0o600 });
    } catch { failed = true; }
  };
  const check = () => { if (failed) throw new Error('Review telemetry could not persist; report this coverage gap.'); };
  const elapsed = (start: number) => Math.max(0, now() - start);
  const observing = (ctx: { sessionManager: { getSessionId(): string } }) => binding?.agentSessionId === ctx.sessionManager.getSessionId();

  pi.registerTool({
    name: 'agentic_code_review_step', label: 'Review step telemetry',
    description: readFileSync(fileURLToPath(new URL('../prompts/step.md', import.meta.url)), 'utf8'),
    parameters: Type.Object({
      sessionId: Type.String({ maxLength: 128 }), runId: Type.String({ maxLength: 128 }),
      stage: Type.Integer({ minimum: 1, maximum: 7 }),
      phase: Type.String({ enum: ['start', 'end'] }),
      outcome: Type.Optional(Type.String({ enum: ['reviewed', 'partial', 'unable'] })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const { sessionId, runId, stage, phase, outcome } = params;
      const agentSessionId = ctx.sessionManager.getSessionId();
      if (![sessionId, runId, agentSessionId].every(identity)) throw new Error('Invalid telemetry identity.');
      if (!Number.isInteger(stage) || stage < 1 || stage > 7) throw new Error('Invalid review stage.');
      if (binding && (binding.runId !== runId || binding.sessionId !== sessionId || binding.agentSessionId !== agentSessionId)) {
        throw new Error('Telemetry is already bound to another run or session.');
      }
      check();
      if (phase === 'start') {
        if (active) throw new Error('A review stage is already active.');
        if (outcome !== undefined) throw new Error('Outcome belongs to a stage end.');
      } else if (phase === 'end') {
        if (!active || active.stage !== stage) throw new Error('No matching active review stage.');
        if (!['reviewed', 'partial', 'unable'].includes(outcome ?? '')) throw new Error('A stage end requires an outcome.');
      } else throw new Error('Invalid review phase.');
      if (!binding) {
        const reviewPath = join(root, sessionId, `${runId}.review.json`);
        if (!lstatSync(reviewPath).isFile()) throw new Error('Prepared review must be a regular file.');
        const review = JSON.parse(readFileSync(reviewPath, 'utf8'));
        if (review.sessionId !== sessionId || review.runId !== runId || !['prepared', 'running'].includes(review.status)) {
          throw new Error('Telemetry requires a matching open prepared review.');
        }
        const directory = join(root, sessionId, `${runId}.telemetry`);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (!lstatSync(directory).isDirectory()) throw new Error('Telemetry directory must be a regular directory.');
        const path = join(directory, `${agentSessionId}-${randomUUID()}.jsonl`);
        writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
        binding = { sessionId, runId, agentSessionId, path };
        emit('capture_start', { queueMs: null, startupMs: null, preBindingEvents: 'unavailable' });
      }
      if (phase === 'start') {
        active = { stage, started: now() };
        emit('step_start');
      } else {
        emit('step_end', { durationMs: elapsed(active!.started), outcome });
        active = undefined;
      }
      check();
      return { content: [{ type: 'text', text: `Review stage ${stage} ${phase} recorded. Telemetry: ${binding.path}` }],
        details: { path: binding.path, agentSessionId, stage, phase } };
    },
  });

  pi.on('before_provider_request', (_event, ctx) => {
    if (!observing(ctx)) return;
    if (request) emit('model_unfinished', { requestId: request.id, stage: request.stage, durationMs: elapsed(request.started) });
    request = { id: ++requestSequence, started: now(), stage: active?.stage ?? null,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null };
    emit('model_start', { requestId: request.id, model: request.model, thinking: ctx.thinkingLevel ?? null });
  });
  pi.on('after_provider_response', (event, ctx) => {
    if (observing(ctx)) emit('provider_response', { requestId: request?.id ?? null, status: event.status,
      durationMs: request ? elapsed(request.started) : null });
  });
  pi.on('message_update', (event, ctx) => {
    if (!observing(ctx) || !request) return;
    const update = event.assistantMessageEvent;
    if (!['text_delta', 'thinking_delta', 'toolcall_delta'].includes(update.type) || !('delta' in update) || !update.delta) return;
    request.firstDelta ??= now();
    if (update.type === 'text_delta') request.firstText ??= now();
  });
  pi.on('message_end', (event, ctx) => {
    if (!observing(ctx) || event.message.role !== 'assistant') return;
    const usage = event.message.usage;
    const durationMs = request ? elapsed(request.started) : null;
    const output = finite(usage?.output);
    emit('model_end', { requestId: request?.id ?? null, stage: request?.stage ?? active?.stage ?? null,
      model: request?.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null), durationMs,
      timeToFirstDeltaMs: request?.firstDelta !== undefined ? request.firstDelta - request.started : null,
      timeToFirstTextMs: request?.firstText !== undefined ? request.firstText - request.started : null,
      outputTokensPerSecond: output !== null && durationMs !== null && durationMs > 0 ? output * 1000 / durationMs : null,
      stopReason: event.message.stopReason,
      usage: { input: finite(usage?.input), output, cacheRead: finite(usage?.cacheRead), cacheWrite: finite(usage?.cacheWrite),
        totalTokens: finite(usage?.totalTokens), costUsd: finite(usage?.cost?.total) } });
    request = undefined;
  });
  pi.on('tool_execution_start', (event, ctx) => {
    if (!observing(ctx)) return;
    tools.set(event.toolCallId, { started: now(), stage: active?.stage ?? null, name: event.toolName });
    emit('tool_start', { toolCallId: event.toolCallId, toolName: event.toolName });
  });
  pi.on('tool_execution_end', (event, ctx) => {
    if (!observing(ctx)) return;
    const tool = tools.get(event.toolCallId);
    emit('tool_end', { toolCallId: event.toolCallId, toolName: event.toolName, stage: tool?.stage ?? null,
      durationMs: tool ? elapsed(tool.started) : null, isError: event.isError });
    tools.delete(event.toolCallId);
  });
  pi.on('session_shutdown', (_event, ctx) => {
    if (!observing(ctx)) return;
    if (active) emit('step_end', { durationMs: elapsed(active.started), outcome: 'interrupted' });
    if (request) emit('model_unfinished', { requestId: request.id, stage: request.stage, durationMs: elapsed(request.started) });
    for (const [toolCallId, tool] of tools) emit('tool_unfinished', { toolCallId, toolName: tool.name, stage: tool.stage, durationMs: elapsed(tool.started) });
    emit('session_end');
    binding = undefined; active = undefined; request = undefined; tools.clear();
  });
}
