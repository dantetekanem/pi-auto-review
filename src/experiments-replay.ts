import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { approveExecution, claimExecution, digestBytes, type FixtureObservation, type FixtureStatus } from './experiments-contract.ts';
import { emptyExecution, executeProcess, streamNames, type Execution, type StreamName } from './experiments-process.ts';

export type ReplayRequest = {
  runId: string;
  profile: 'trusted-program';
  revision: string;
  executable: string;
  script: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  files: { path: string; sha256: string; copyAs?: string }[];
  headers: string[];
  cases: { id: string; failure?: { prefix: string; contains: string } }[];
  limits: { timeoutMs: number; maxOutputBytes: number };
};
type Outcome = { status: FixtureStatus; observation: FixtureObservation | null; detail: string };

function validText(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00\r\n]/.test(value);
}

export function describeReplay(value: ReplayRequest) {
  if (value?.profile !== 'trusted-program' || !validText(value.runId, 128)
    || !/^[\w-]+$/.test(value.runId) || !/^[a-f0-9]{40,64}$/.test(value.revision)) {
    throw new Error('Invalid replay identity.');
  }
  for (const path of [value.executable, value.cwd]) {
    if (!validText(path) || !isAbsolute(path)) throw new Error('Replay paths must be absolute.');
  }
  if (!Array.isArray(value.files) || value.files.length < 2 || value.files.length > 32) {
    throw new Error('Invalid replay files.');
  }
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const file of value.files) {
    if (!validText(file.path) || !isAbsolute(file.path) || paths.has(file.path)
      || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid replay file identity.');
    paths.add(file.path);
    if (file.copyAs !== undefined) {
      if (!/^[\w.-]{1,100}$/.test(file.copyAs) || ['.', '..'].includes(file.copyAs)
        || names.has(file.copyAs)) throw new Error('Invalid replay file name.');
      names.add(file.copyAs);
    }
  }
  if (!names.has(value.script) || !paths.has(value.executable)) throw new Error('Pin the replay script and executable files.');
  if (!Array.isArray(value.args) || value.args.length > 8 || value.args.some(arg => !validText(arg))) {
    throw new Error('Invalid replay arguments.');
  }
  if (!value.environment || typeof value.environment !== 'object' || Array.isArray(value.environment)
    || Object.entries(value.environment).some(([key, text]) => !['PATH', 'JSON_VERSION'].includes(key) || !validText(text))) {
    throw new Error('Invalid replay environment.');
  }
  if (!Array.isArray(value.headers) || value.headers.length < 1 || value.headers.length > 16
    || value.headers.some(line => !validText(line, 1024))) throw new Error('Invalid replay headers.');
  if (!Array.isArray(value.cases) || value.cases.length < 1 || value.cases.length > 16
    || new Set(value.cases.map(item => item.id)).size !== value.cases.length
    || value.cases.some(item => !/^[\w-]{1,80}$/.test(item.id)
      || (item.failure && (!validText(item.failure.prefix, 200) || !validText(item.failure.contains, 200))))) {
    throw new Error('Invalid replay cases.');
  }
  for (const [amount, max] of [[value.limits?.timeoutMs, 30000], [value.limits?.maxOutputBytes, 1048576]]) {
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > max) throw new Error('Invalid replay limit.');
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 65536) throw new Error('Replay request is too large.');
  const request: ReplayRequest = structuredClone(value);
  const supervisor = { executable: process.execPath, version: process.version, platform: process.platform, arch: process.arch };
  return { request, supervisor, digest: digestBytes(JSON.stringify({ request, supervisor })) };
}

// Host API, not a model-facing approval mechanism. The host already authorized these bytes.
export function approveTrustedReplay(request: ReplayRequest, approval: { approvedBy: string; maxAttempts: number }) {
  return approveExecution(describeReplay(request).digest, 'trusted-program', approval);
}

async function pinnedCopies(request: ReplayRequest, signal?: AbortSignal) {
  const copies = new Map<string, Buffer>();
  let copiedBytes = 0;
  for (const file of request.files) {
    signal?.throwIfAborted();
    const metadata = await stat(file.path);
    if (!metadata.isFile() || metadata.size > 268435456) throw new Error(`Unsupported replay file: ${file.path}`);
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let readBytes = 0;
    for await (const chunk of createReadStream(file.path, { signal })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      readBytes += bytes.length;
      if (readBytes > 268435456) throw new Error('Replay file grew past its limit.');
      hash.update(bytes);
      if (file.copyAs) {
        copiedBytes += bytes.length;
        if (copiedBytes > 2097152) throw new Error('Replay copies exceed two MiB.');
        chunks.push(bytes);
      }
    }
    if (hash.digest('hex') !== file.sha256) throw new Error(`Replay file identity changed: ${file.path}`);
    if (file.copyAs) copies.set(file.copyAs, Buffer.concat(chunks));
  }
  return copies;
}

function observationFrom(execution: Execution, request: ReplayRequest): Outcome {
  const outcome = (status: FixtureStatus, observation: FixtureObservation | null, detail = ''): Outcome => ({ status, observation, detail });
  if (execution.status !== 'completed') return outcome(execution.status, null, execution.detail);
  const lines = Buffer.concat(execution.streams.stdout.chunks).toString('utf8').split(/\r?\n/);
  const cases = lines.filter(line => /^(PASS|FAIL) /.test(line));
  const summaries = lines.filter(line => line.startsWith('RESULT '));
  if (!cases.length && execution.exitCode !== 0) return outcome('setup_error', null, 'Program failed before any case result.');
  if (!cases.length && execution.exitCode === 0) return outcome('completed', 'not_observed', 'No target cases ran.');
  if (!request.headers.every(header => lines.includes(header))) return outcome('setup_error', null, 'Runtime or source header did not match.');
  const summary = summaries.length === 1 ? /^RESULT (\d+) cases, (\d+) failures$/.exec(summaries[0]) : null;
  if (!summary || execution.signal) return outcome('process_error', null, 'Missing or invalid result summary.');
  if (cases.length !== request.cases.length || Number(summary[1]) !== request.cases.length) {
    return outcome('completed', 'not_observed', 'The complete target case set was not observed.');
  }
  let failures = 0;
  let unexpectedFailure = false;
  for (const target of request.cases) {
    const matches = cases.filter(line => line.startsWith(`PASS ${target.id} `) || line.startsWith(`FAIL ${target.id} `));
    if (matches.length !== 1) return outcome('process_error', null, 'Duplicate or missing case identity.');
    const line = matches[0];
    if (line.startsWith('FAIL ')) {
      failures++;
      if (!target.failure || !line.startsWith(`FAIL ${target.id} ${target.failure.prefix}`)
        || !line.includes(target.failure.contains)) unexpectedFailure = true;
    }
  }
  if (Number(summary[2]) !== failures || execution.exitCode !== (failures ? 1 : 0)) {
    return outcome('process_error', null, 'Case counts or exit status disagree.');
  }
  return outcome('completed', unexpectedFailure ? 'probe_error' : failures ? 'target_failure' : 'passed');
}

/** Supervise only host-approved programs. File hashes detect drift, not concurrent hostile writers. */
export async function runTrustedReplay(
  request: ReplayRequest,
  grant: unknown,
  artifactRoot: string,
  options: { signal?: AbortSignal } = {},
) {
  options.signal?.throwIfAborted();
  const prepared = describeReplay(request);
  const approval = claimExecution(prepared.digest, grant);
  const snapshot = prepared.request;
  const copies = await pinnedCopies(snapshot, options.signal);
  options.signal?.throwIfAborted();
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(resolve(artifactRoot), 'replay-'));
  const workspace = join(directory, 'workspace');
  const paths = {
    request: join(directory, 'request.json'),
    receipt: join(directory, 'receipt.json'),
    stdout: join(directory, 'stdout.bin'),
    stderr: join(directory, 'stderr.bin'),
    result: join(directory, 'result.bin'),
  };
  const environment = { HOME: workspace, TMPDIR: workspace, TZ: 'UTC', LANG: 'C', ...snapshot.environment };
  const command = [snapshot.executable, join(workspace, snapshot.script), ...snapshot.args];
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let execution = emptyExecution('setup_error');
  let inputError: string | null = null;
  let cleanupError: string | null = null;
  try {
    await writeFile(paths.request, JSON.stringify(snapshot) + '\n', { flag: 'wx', mode: 0o600 });
    await mkdir(workspace, { mode: 0o700 });
    for (const [name, bytes] of copies) {
      await writeFile(join(workspace, name), bytes, { flag: 'wx', mode: 0o600 });
    }
    execution = await executeProcess(snapshot.executable, command.slice(1), snapshot.cwd, environment, snapshot.limits, options.signal);
    try {
      await pinnedCopies(snapshot, options.signal);
    } catch (error) {
      if (options.signal?.aborted) {
        if (execution.status === 'completed') execution.status = 'cancelled';
      } else {
        inputError = error instanceof Error ? error.message : String(error);
      }
    }
  } catch (error) {
    execution.detail = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await rm(workspace, { recursive: true, force: true });
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }
  }
  const outputs = {} as Record<StreamName, { bytes: number; observedBytes: number; sha256: string; truncated: boolean }>;
  for (const name of streamNames) {
    const captured = execution.streams[name];
    const bytes = Buffer.concat(captured.chunks);
    await writeFile(paths[name], bytes, { flag: 'wx', mode: 0o600 });
    outputs[name] = {
      bytes: bytes.length,
      observedBytes: captured.observedBytes,
      sha256: digestBytes(bytes),
      truncated: captured.truncated,
    };
  }
  const outcome = observationFrom(execution, snapshot);
  const receipt = {
    schemaVersion: 1,
    runId: snapshot.runId,
    attemptId: randomUUID(),
    profile: snapshot.profile,
    sandboxed: false,
    processControl: 'direct-child-only',
    observationOrigin: 'parsed-child-transcript',
    requestDigest: prepared.digest,
    supervisor: prepared.supervisor,
    approval,
    revision: snapshot.revision,
    files: snapshot.files,
    command,
    cwd: snapshot.cwd,
    workspace,
    environment,
    limits: snapshot.limits,
    startedAt,
    durationMs: Math.round(performance.now() - start),
    status: cleanupError ? 'cleanup_failed' : inputError ? 'input_changed' : outcome.status,
    observation: cleanupError || inputError ? null : outcome.observation,
    detail: cleanupError || inputError || outcome.detail,
    pid: execution.pid,
    exitCode: execution.exitCode,
    signal: execution.signal,
    cleanup: cleanupError ? 'failed' : 'workspace-removed',
    cleanupError,
    outputs,
    paths,
  };
  await writeFile(paths.receipt, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return receipt;
}
