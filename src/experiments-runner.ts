import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  claimFixture,
  digestBytes,
  type FixtureRequest,
  type FixtureObservation,
  type FixtureStatus,
} from './experiments-contract.ts';
import { emptyExecution, executeProcess, streamNames, type Execution, type StreamName } from './experiments-process.ts';

// A single-file ESM fixture and probe, not a repository adapter or an untrusted-code sandbox.
// probe(subject, input, check) must invoke check(actual, expected) exactly once.
const runner = `
import { deepStrictEqual } from 'node:assert';
import { readFileSync, writeSync } from 'node:fs';
let phase = 'setup';
let checks = 0;
let targetError;
let kind;
let detail = '';
try {
  const subject = await import('./fixture.mjs');
  const { default: probe } = await import('./probe.mjs');
  if (typeof probe !== 'function') throw new TypeError('Probe must export a function.');
  const input = JSON.parse(readFileSync('input.json', 'utf8'));
  phase = 'probe';
  await probe(subject, input, (actual, expected) => {
    checks++;
    if (checks !== 1) throw new Error('Probe must perform exactly one target check.');
    try {
      deepStrictEqual(actual, expected, process.argv[2]);
    } catch (error) {
      targetError = error;
      throw error;
    }
  });
  if (checks > 1) kind = 'probe_error';
  else if (targetError) kind = 'target_failure';
  else kind = checks === 1 ? 'passed' : 'not_observed';
  if (targetError) detail = targetError.message;
} catch (error) {
  if (phase === 'setup') kind = 'setup_error';
  else if (targetError !== undefined && error === targetError) kind = 'target_failure';
  else kind = 'probe_error';
  detail = String(error?.message ?? error);
}
writeSync(3, JSON.stringify({ kind, checks, detail: detail.slice(0, 1024) }));
process.exitCode ??= ['passed', 'not_observed'].includes(kind) ? 0 : 1;
`;

function isObservationKind(value: unknown): value is FixtureObservation | 'setup_error' {
  return typeof value === 'string'
    && ['passed', 'target_failure', 'not_observed', 'probe_error', 'setup_error'].includes(value);
}

function observationFrom(execution: Execution): {
  status: FixtureStatus;
  observation: FixtureObservation | null;
  detail: string;
} {
  if (execution.status !== 'completed') {
    return { status: execution.status, observation: null, detail: execution.detail };
  }
  try {
    const result: unknown = JSON.parse(Buffer.concat(execution.streams.result.chunks).toString('utf8'));
    if (!result || typeof result !== 'object'
      || !('kind' in result) || !isObservationKind(result.kind)
      || !('checks' in result) || typeof result.checks !== 'number' || !Number.isInteger(result.checks)
      || !('detail' in result) || typeof result.detail !== 'string') {
      throw new Error('Invalid fixture observation.');
    }
    const expectedExit = ['passed', 'not_observed'].includes(result.kind) ? 0 : 1;
    if (result.checks < 0 || result.checks > 2
      || execution.exitCode !== expectedExit || execution.signal
      || (['passed', 'target_failure'].includes(result.kind) && result.checks !== 1)
      || (result.kind === 'not_observed' && result.checks !== 0)) {
      throw new Error('Invalid target-check count or process exit.');
    }
    return result.kind === 'setup_error'
      ? { status: 'setup_error', observation: null, detail: result.detail }
      : { status: 'completed', observation: result.kind, detail: result.detail };
  } catch (error) {
    return {
      status: 'process_error',
      observation: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Runs only already-authorized, trusted fixture code with the host user's access.
 * Grant issuance must stay with the trusted caller. No Pi tool is registered here.
 * A receipt records execution and child-reported observations, never defect truth.
 * Call again with the saved request and sufficient grant attempts for fresh replay.
 */
export async function runTrustedFixture(
  request: FixtureRequest,
  grant: unknown,
  artifactRoot: string,
  options: { signal?: AbortSignal } = {},
) {
  options.signal?.throwIfAborted();
  const admitted = claimFixture(request, grant);
  const snapshot = admitted.request;
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const attemptId = randomUUID();
  const directory = await mkdtemp(join(resolve(artifactRoot), 'fixture-'));
  const cwd = join(directory, 'workspace');
  const paths = Object.freeze({
    request: join(directory, 'request.json'),
    stdout: join(directory, 'stdout.bin'),
    stderr: join(directory, 'stderr.bin'),
    result: join(directory, 'result.json'),
    receipt: join(directory, 'receipt.json'),
  });
  const environment = Object.freeze({ HOME: cwd, TMPDIR: cwd, TZ: 'UTC', LANG: 'C' });
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let execution = emptyExecution('setup_error');
  let cleanup = 'workspace-removed';
  let cleanupError: string | null = null;
  try {
    await writeFile(paths.request, JSON.stringify(snapshot) + '\n', { flag: 'wx', mode: 0o600 });
    await mkdir(cwd, { mode: 0o700 });
    const files = {
      'fixture.mjs': snapshot.source,
      'probe.mjs': snapshot.probe,
      'input.json': snapshot.input,
      'runner.mjs': runner,
    };
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(cwd, name), content, { flag: 'wx', mode: 0o600 });
    }
    execution = await executeProcess(process.execPath, ['runner.mjs', snapshot.targetId], cwd, environment, snapshot.limits, options.signal);
  } catch (error) {
    execution.detail = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await rm(cwd, { recursive: true, force: true });
    } catch (error) {
      cleanup = 'failed';
      cleanupError = error instanceof Error ? error.message : String(error);
    }
  }
  const outputs = {} as Record<StreamName, { bytes: number; observedBytes: number; sha256: string; truncated: boolean }>;
  for (const name of streamNames) {
    const captured = execution.streams[name];
    const bytes = Buffer.concat(captured.chunks);
    await writeFile(paths[name], bytes, { flag: 'wx', mode: 0o600 });
    outputs[name] = Object.freeze({
      bytes: bytes.length,
      observedBytes: captured.observedBytes,
      sha256: digestBytes(bytes),
      truncated: captured.truncated,
    });
  }
  const outcome = observationFrom(execution);
  const receipt = Object.freeze({
    schemaVersion: 1,
    runId: snapshot.runId,
    attemptId,
    profile: snapshot.profile,
    sandboxed: false,
    processControl: 'direct-child-only',
    observationOrigin: 'child-reported',
    requestDigest: admitted.digest,
    identities: admitted.identities,
    runtime: admitted.runtime,
    runnerDigest: digestBytes(runner),
    approval: admitted.approval,
    targetId: snapshot.targetId,
    limits: snapshot.limits,
    command: Object.freeze([process.execPath, 'runner.mjs', snapshot.targetId]),
    cwd,
    environment,
    startedAt,
    durationMs: Math.round(performance.now() - start),
    status: cleanupError ? 'cleanup_failed' : outcome.status,
    observation: cleanupError ? null : outcome.observation,
    detail: outcome.detail,
    pid: execution.pid,
    exitCode: execution.exitCode,
    signal: execution.signal,
    cleanup,
    cleanupError,
    outputs: Object.freeze(outputs),
    paths,
  });
  await writeFile(paths.receipt, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return receipt;
}
