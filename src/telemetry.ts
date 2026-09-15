import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const isIdentity = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const nonnegativeMetric = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

type TelemetryFields = Record<string, unknown>;
type ModelRequest = {
  id: number;
  started: number;
  firstDelta?: number;
  firstText?: number;
  stage: number | null;
  model: string | null;
};
type ReviewBinding = {
  sessionId: string;
  runId: string;
  agentSessionId: string;
  path: string;
};
type StepSpan = {
  stage: number;
  started: number;
};
type ToolSpan = {
  started: number;
  stage: number | null;
  name: string;
};

// One extension instance writes one stream; the top-level review session never rewrites it.
export function registerTelemetry(pi: ExtensionAPI, root: string, now = () => performance.now()): void {
  let binding: ReviewBinding | undefined;
  let activeStep: StepSpan | undefined;
  let activeRequest: ModelRequest | undefined;
  let eventSequence = 0;
  let requestSequence = 0;
  let persistenceFailed = false;
  const activeTools = new Map<string, ToolSpan>();

  const emit = (kind: string, fields: TelemetryFields = {}) => {
    if (!binding || persistenceFailed) return;
    try {
      const record = {
        schemaVersion: 1,
        sessionId: binding.sessionId,
        runId: binding.runId,
        agentSessionId: binding.agentSessionId,
        sequence: ++eventSequence,
        at: new Date().toISOString(),
        stage: activeStep?.stage ?? null,
        kind,
        ...fields,
      };
      appendFileSync(binding.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      persistenceFailed = true;
    }
  };
  const checkPersistence = () => {
    if (persistenceFailed) {
      throw new Error('Review telemetry could not persist; report this coverage gap.');
    }
  };
  const elapsed = (start: number) => Math.max(0, now() - start);
  const observesSession = (ctx: { sessionManager: { getSessionId(): string } }) =>
    binding?.agentSessionId === ctx.sessionManager.getSessionId();

  pi.registerTool({
    name: 'agentic_code_review_step',
    label: 'Review step telemetry',
    description: 'Inactive review telemetry prototype.',
    parameters: Type.Object({
      sessionId: Type.String({ maxLength: 128 }),
      runId: Type.String({ maxLength: 128 }),
      stage: Type.Integer({ minimum: 1, maximum: 7 }),
      phase: Type.String({ enum: ['start', 'end'] }),
      outcome: Type.Optional(Type.String({ enum: ['reviewed', 'partial', 'unable'] })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const { sessionId, runId, stage, phase, outcome } = params;
      const agentSessionId = ctx.sessionManager.getSessionId();
      if (![sessionId, runId, agentSessionId].every(isIdentity)) {
        throw new Error('Invalid telemetry identity.');
      }
      if (!Number.isInteger(stage) || stage < 1 || stage > 7) {
        throw new Error('Invalid review stage.');
      }
      if (binding && (
        binding.runId !== runId
        || binding.sessionId !== sessionId
        || binding.agentSessionId !== agentSessionId
      )) {
        throw new Error('Telemetry is already bound to another run or session.');
      }
      checkPersistence();

      if (phase === 'start') {
        if (activeStep) throw new Error('A review stage is already active.');
        if (outcome !== undefined) throw new Error('Outcome belongs to a stage end.');
      } else if (phase === 'end') {
        if (!activeStep || activeStep.stage !== stage) {
          throw new Error('No matching active review stage.');
        }
        if (!['reviewed', 'partial', 'unable'].includes(outcome ?? '')) {
          throw new Error('A stage end requires an outcome.');
        }
      } else {
        throw new Error('Invalid review phase.');
      }

      if (!binding) {
        const reviewPath = join(root, sessionId, `${runId}.review.json`);
        if (!lstatSync(reviewPath).isFile()) {
          throw new Error('Prepared review must be a regular file.');
        }
        const review = JSON.parse(readFileSync(reviewPath, 'utf8'));
        if (
          review.sessionId !== sessionId
          || review.runId !== runId
          || !['prepared', 'running'].includes(review.status)
        ) {
          throw new Error('Telemetry requires a matching open prepared review.');
        }

        const directory = join(root, sessionId, `${runId}.telemetry`);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (!lstatSync(directory).isDirectory()) {
          throw new Error('Telemetry directory must be a regular directory.');
        }
        const path = join(directory, `${agentSessionId}-${randomUUID()}.jsonl`);
        writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
        binding = { sessionId, runId, agentSessionId, path };
        emit('capture_start', {
          queueMs: null,
          startupMs: null,
          preBindingEvents: 'unavailable',
        });
      }

      if (phase === 'start') {
        activeStep = { stage, started: now() };
        emit('step_start');
      } else {
        emit('step_end', {
          durationMs: elapsed(activeStep!.started),
          outcome,
        });
        activeStep = undefined;
      }
      checkPersistence();

      return {
        content: [{
          type: 'text',
          text: `Review stage ${stage} ${phase} recorded. Telemetry: ${binding.path}`,
        }],
        details: { path: binding.path, agentSessionId, stage, phase },
      };
    },
  });

  pi.on('before_provider_request', (_event, ctx) => {
    if (!observesSession(ctx)) return;
    if (activeRequest) {
      emit('model_unfinished', {
        requestId: activeRequest.id,
        stage: activeRequest.stage,
        durationMs: elapsed(activeRequest.started),
      });
    }
    activeRequest = {
      id: ++requestSequence,
      started: now(),
      stage: activeStep?.stage ?? null,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
    };
    emit('model_start', {
      requestId: activeRequest.id,
      model: activeRequest.model,
      thinking: ctx.thinkingLevel ?? null,
    });
  });

  pi.on('after_provider_response', (event, ctx) => {
    if (observesSession(ctx)) {
      emit('provider_response', {
        requestId: activeRequest?.id ?? null,
        status: event.status,
        durationMs: activeRequest ? elapsed(activeRequest.started) : null,
      });
    }
  });

  pi.on('message_update', (event, ctx) => {
    if (!observesSession(ctx) || !activeRequest) return;
    const update = event.assistantMessageEvent;
    if (
      !['text_delta', 'thinking_delta', 'toolcall_delta'].includes(update.type)
      || !('delta' in update)
      || !update.delta
    ) {
      return;
    }

    activeRequest.firstDelta ??= now();
    if (update.type === 'text_delta') activeRequest.firstText ??= now();
  });

  pi.on('message_end', (event, ctx) => {
    if (!observesSession(ctx) || event.message.role !== 'assistant') return;
    const usage = event.message.usage;
    const durationMs = activeRequest ? elapsed(activeRequest.started) : null;
    const output = nonnegativeMetric(usage?.output);

    emit('model_end', {
      requestId: activeRequest?.id ?? null,
      stage: activeRequest?.stage ?? activeStep?.stage ?? null,
      model: activeRequest?.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null),
      durationMs,
      timeToFirstDeltaMs: activeRequest?.firstDelta !== undefined
        ? activeRequest.firstDelta - activeRequest.started
        : null,
      timeToFirstTextMs: activeRequest?.firstText !== undefined
        ? activeRequest.firstText - activeRequest.started
        : null,
      outputTokensPerSecond: output !== null && durationMs !== null && durationMs > 0
        ? output * 1000 / durationMs
        : null,
      stopReason: event.message.stopReason,
      usage: {
        input: nonnegativeMetric(usage?.input),
        output,
        cacheRead: nonnegativeMetric(usage?.cacheRead),
        cacheWrite: nonnegativeMetric(usage?.cacheWrite),
        totalTokens: nonnegativeMetric(usage?.totalTokens),
        costUsd: nonnegativeMetric(usage?.cost?.total),
      },
    });
    activeRequest = undefined;
  });

  pi.on('tool_execution_start', (event, ctx) => {
    if (!observesSession(ctx)) return;
    activeTools.set(event.toolCallId, {
      started: now(),
      stage: activeStep?.stage ?? null,
      name: event.toolName,
    });
    emit('tool_start', {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    });
  });

  pi.on('tool_execution_end', (event, ctx) => {
    if (!observesSession(ctx)) return;
    const tool = activeTools.get(event.toolCallId);
    emit('tool_end', {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      stage: tool?.stage ?? null,
      durationMs: tool ? elapsed(tool.started) : null,
      isError: event.isError,
    });
    activeTools.delete(event.toolCallId);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    if (!observesSession(ctx)) return;
    if (activeStep) {
      emit('step_end', {
        durationMs: elapsed(activeStep.started),
        outcome: 'interrupted',
      });
    }
    if (activeRequest) {
      emit('model_unfinished', {
        requestId: activeRequest.id,
        stage: activeRequest.stage,
        durationMs: elapsed(activeRequest.started),
      });
    }
    for (const [toolCallId, tool] of activeTools) {
      emit('tool_unfinished', {
        toolCallId,
        toolName: tool.name,
        stage: tool.stage,
        durationMs: elapsed(tool.started),
      });
    }
    emit('session_end');

    binding = undefined;
    activeStep = undefined;
    activeRequest = undefined;
    activeTools.clear();
  });
}
