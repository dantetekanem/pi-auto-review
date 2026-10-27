import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { digestBytes } from './experiments-contract.ts';

type ExecutionRecord = {
  status: string; detail: string; exitCode: number | null; stdout: Buffer; stderr: Buffer;
  containerId: string | null; cleanup: string; durationMs: number; outputTruncated: boolean; profileVerified: boolean;
};
const statuses = ['completed', 'setup_error', 'process_error', 'timeout', 'output_limit', 'cancelled', 'cleanup_failed'];

/** A single durable guard fences restricted attempts, including crashes and ambiguous create responses. */
export async function startRestrictedRecord(artifactRoot: string, guardPath: string, request: { runId: string }) {
  const encoded = JSON.stringify(request) + '\n';
  if (!/^[\w-]{1,128}$/.test(request.runId) || Buffer.byteLength(encoded) > 65536) throw new Error('Invalid restricted request record.');
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  await mkdir(dirname(guardPath), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(resolve(artifactRoot), 'restricted-'));
  const attemptId = randomUUID();
  const paths = {
    request: join(directory, 'request.json'), receipt: join(directory, 'receipt.json'),
    stdout: join(directory, 'stdout.bin'), stderr: join(directory, 'stderr.bin'),
  };
  const guard = JSON.stringify({ attemptId, runId: request.runId, containerName: `autoreview-${attemptId}`, directory });
  try {
    await writeFile(guardPath, guard, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('A restricted attempt is active or pending reconciliation. Do not retry automatically.');
    throw error;
  }
  // Any later failure leaves the intent: recovery must establish what actually ran.
  await writeFile(paths.request, encoded, { flag: 'wx', mode: 0o600 });
  return { directory, bundle: join(directory, 'bundle'), attemptId, runId: request.runId,
    guardPath, guard, requestDigest: digestBytes(encoded), paths, startedAt: new Date().toISOString() };
}

type PendingRecord = Awaited<ReturnType<typeof startRestrictedRecord>>;

export async function finishRestrictedRecord(record: PendingRecord, execution: ExecutionRecord, annotations: Record<string, unknown>) {
  if (!statuses.includes(execution.status) || !Buffer.isBuffer(execution.stdout) || !Buffer.isBuffer(execution.stderr)
    || execution.stdout.length + execution.stderr.length > 1048576) throw new Error('Invalid execution capture or output limit.');
  const outputs: Record<string, { bytes: number; sha256: string }> = {};
  for (const name of ['stdout', 'stderr'] as const) {
    const bytes = execution[name];
    await writeFile(record.paths[name], bytes, { flag: 'wx', mode: 0o600 });
    outputs[name] = { bytes: bytes.length, sha256: digestBytes(bytes) };
  }
  const cleanupConfirmed = ['container-removed', 'container-absent', 'not-created'].includes(execution.cleanup);
  const completed = execution.status === 'completed' && execution.profileVerified && cleanupConfirmed && !execution.outputTruncated;
  const receipt = {
    ...annotations,
    schemaVersion: 1, runId: record.runId, attemptId: record.attemptId,
    profile: 'docker-node-v1', sandboxed: execution.profileVerified, processControl: 'container-cgroup',
    observationOrigin: 'child-reported', observation: completed ? annotations.observation ?? null : null,
    status: !cleanupConfirmed ? 'cleanup_failed' : execution.outputTruncated ? 'output_limit'
      : execution.status === 'completed' && !execution.profileVerified ? 'process_error' : execution.status,
    detail: execution.detail, exitCode: execution.exitCode, containerId: execution.containerId,
    containerName: `autoreview-${record.attemptId}`, cleanup: execution.cleanup,
    startedAt: record.startedAt, durationMs: execution.durationMs, outputTruncated: execution.outputTruncated,
    requestRecordSha256: record.requestDigest, outputs, paths: record.paths,
  };
  const encoded = JSON.stringify(receipt, null, 2) + '\n';
  if (Buffer.byteLength(encoded) > 1048576) throw new Error('Restricted receipt exceeds its limit.');
  await writeFile(record.paths.receipt, encoded, { flag: 'wx', mode: 0o600 });
  if (cleanupConfirmed) {
    if (await readFile(record.guardPath, 'utf8') !== record.guard) throw new Error('Restricted attempt guard changed; reconciliation required.');
    await unlink(record.guardPath);
  }
  return { receipt, sha256: digestBytes(encoded) };
}
