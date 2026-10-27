import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { FixtureStatus } from './experiments-contract.ts';

export const streamNames = ['stdout', 'stderr', 'result'] as const;
export type StreamName = (typeof streamNames)[number];
type CapturedStream = { chunks: Buffer[]; observedBytes: number; truncated: boolean };
export type Execution = {
  status: FixtureStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  pid: number | null;
  detail: string;
  streams: Record<StreamName, CapturedStream>;
};

export function emptyExecution(status: FixtureStatus): Execution {
  return {
    status,
    exitCode: null,
    signal: null,
    pid: null,
    detail: '',
    streams: {
      stdout: { chunks: [], observedBytes: 0, truncated: false },
      stderr: { chunks: [], observedBytes: 0, truncated: false },
      result: { chunks: [], observedBytes: 0, truncated: false },
    },
  };
}

export function executeProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  limits: Readonly<{ timeoutMs: number; maxOutputBytes: number }>,
  signal?: AbortSignal,
): Promise<Execution> {
  if (signal?.aborted) return Promise.resolve(emptyExecution('cancelled'));
  return new Promise(resolveExecution => {
    const execution = emptyExecution('completed');
    const child = spawn(executable, [...args], {
      cwd,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    execution.pid = child.pid ?? null;
    const result = child.stdio[3] as Readable;
    const streams = { stdout: child.stdout!, stderr: child.stderr!, result };
    let remaining = limits.maxOutputBytes;
    let stopped = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (status: FixtureStatus) => {
      if (stopped) return;
      stopped = true;
      execution.status = status;
      child.kill('SIGKILL');
      // Do not wait indefinitely for a descendant holding a pipe. This only kills
      // the direct child; trusted fixtures must not create background processes.
      for (const stream of Object.values(streams)) stream.destroy();
    };
    for (const name of streamNames) {
      streams[name].on('data', (chunk: Buffer) => {
        const captured = execution.streams[name];
        captured.observedBytes += chunk.length;
        const kept = Math.min(remaining, chunk.length);
        if (kept) captured.chunks.push(Buffer.from(chunk.subarray(0, kept)));
        remaining -= kept;
        if (kept !== chunk.length) {
          captured.truncated = true;
          stop('output_limit');
        }
      });
    }
    const deadline = setTimeout(() => stop('timeout'), limits.timeoutMs);
    const cancel = () => stop('cancelled');
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.once('error', error => {
      execution.detail = error.message;
      stop('process_error');
    });
    child.once('exit', () => {
      // An inherited pipe is outside this fixture profile, not a successful run.
      drainTimer = setTimeout(() => stop('process_error'), 250);
    });
    child.once('close', (code, terminationSignal) => {
      clearTimeout(deadline);
      clearTimeout(drainTimer);
      signal?.removeEventListener('abort', cancel);
      execution.exitCode = code;
      execution.signal = terminationSignal;
      resolveExecution(execution);
    });
  });
}
