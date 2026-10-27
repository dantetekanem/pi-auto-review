import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digestBytes } from './experiments-contract.ts';
import { reserveRestricted, settleRestricted, type RestrictedRequest } from './experiments-restricted-contract.ts';
import { materializeRestrictedInputs, readPinnedFile } from './experiments-materialize.ts';
import { runDocker } from './experiments-docker.ts';
import { startRestrictedRecord, finishRestrictedRecord } from './experiments-receipts.ts';

const loader = `
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  const projected = {
    '@earendil-works/pi-coding-agent': 'file:///bundle/deps/pi/dist/core/tools/file-mutation-queue.js',
    'typebox': 'file:///bundle/deps/typebox/build/index.mjs'
  }[specifier];
  const result = projected ? { url: projected, shortCircuit: true } : next(specifier, context);
  if (!result.url.startsWith('node:') && !result.url.startsWith('file:///bundle/')) throw new Error('Import outside sealed bundle.');
  return result;
} });
`;
const reporter = `
export default async function* (source) {
  for await (const event of source) {
    if (!['test:pass','test:fail','test:diagnostic','test:stdout','test:stderr'].includes(event.type)) continue;
    const data = event.data, error = data.details?.error?.cause ?? data.details?.error;
    yield JSON.stringify({ type:event.type, name:data.name, skip:data.skip, todo:data.todo,
      code:error?.code, message:error?.message ?? data.message })+'\\n';
  }
}
`;
const adapterFiles = ['experiments-node.ts', 'experiments-docker.ts', 'experiments-restricted-contract.ts', 'experiments-materialize.ts', 'experiments-receipts.ts', 'experiments-seccomp.json'];
const adapterSha256 = digestBytes(Buffer.concat(adapterFiles.map(path => readFileSync(new URL(path, import.meta.url)))));
export const nodeAdapterIdentity = () => adapterSha256;
export const targetSignature = 'optional findings must be nonblocking';
export const normalizerVersion = 'node-findings-v1';

type NodeExecution = { status: string; exitCode: number | null; stdout: Buffer; stderr: Buffer };
type Event = { type: string; name?: string; skip?: unknown; todo?: unknown; code?: string; message?: string };

/** Test events and returned data are child observations, not proof that hostile code told the truth. */
export function parseNodeObservation(execution: NodeExecution, targetId: string, input: string) {
  const result = (status: string, observation: string | null, detail = '', normalized: unknown = null) => ({ status, observation, detail, normalized });
  if (execution.status !== 'completed') return result(execution.status, null);
  let events: Event[];
  try {
    events = execution.stdout.toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (events.some(event => !event || typeof event !== 'object'
      || !['test:pass', 'test:fail', 'test:diagnostic', 'test:stdout', 'test:stderr'].includes(event.type)
      || ['name', 'code', 'message'].some(key => key in event && typeof event[key as keyof Event] !== 'string')
      || ['skip', 'todo'].some(key => key in event && !['boolean', 'string'].includes(typeof event[key as keyof Event])))) throw new Error();
  } catch { return result('process_error', null, 'Malformed node:test event stream.'); }
  const targets = events.filter(event => ['test:pass', 'test:fail'].includes(event.type) && event.name === targetId);
  if (!targets.length) return execution.exitCode === 0
    ? result('completed', 'not_observed', 'The named target did not run.') : result('setup_error', null, 'No target result before process failure.');
  if (targets.length !== 1 || targets[0].skip || targets[0].todo) return result('completed', 'not_observed', 'The target was duplicated or skipped.');
  const target = targets[0];
  if (target.type === 'test:fail' && (target.code !== 'ERR_ASSERTION' || !target.message?.includes(targetSignature))) {
    return result('completed', 'probe_error', 'Failure did not match the frozen target assertion.');
  }
  const observations = events.filter(event => event.type === 'test:diagnostic' && event.message?.startsWith('AR_OBSERVATION '));
  try {
    if (observations.length !== 1) throw new Error('Missing or duplicate target observation.');
    const normalized = JSON.parse(observations[0].message!.slice('AR_OBSERVATION '.length));
    const expectedKinds = ['fix', ...JSON.parse(input).items.map((item: { kind: string }) => item.kind)];
    if (!Array.isArray(normalized.records) || normalized.records.length !== expectedKinds.length
      || normalized.records.some((record: { kind: string; blocks: boolean }, index: number) => record.kind !== expectedKinds[index] || typeof record.blocks !== 'boolean')
      || normalized.bugs !== 0) throw new Error('Target invocation data did not match the declared input.');
    const mismatch = normalized.records.some((record: { blocks: boolean }) => record.blocks);
    if ((target.type === 'test:fail') !== mismatch || execution.exitCode !== (mismatch ? 1 : 0)) throw new Error('Assertion, observed values and exit status disagree.');
    return result('completed', mismatch ? 'target_failure' : 'passed', mismatch ? targetSignature : '', normalized);
  } catch (error) { return result('completed', 'probe_error', String(error)); }
}

export async function runRestrictedNode(request: RestrictedRequest, grant: unknown, artifactRoot: string, guardPath: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const admission = reserveRestricted(request, grant);
  const started = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, admission.limits.timeoutMs);
  let record: Awaited<ReturnType<typeof startRestrictedRecord>> | undefined;
  let materialized: Awaited<ReturnType<typeof materializeRestrictedInputs>> | undefined;
  let execution: Awaited<ReturnType<typeof runDocker>> = {
    status: 'setup_error', detail: '', exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
    containerId: null, cleanup: 'not-created', configuration: null, profileVerified: false, durationMs: 0, outputTruncated: false,
  };
  let cleanupConfirmed = true;
  try {
    const snapshot = admission.request;
    if (snapshot.adapterSha256 !== adapterSha256) throw new Error('Node adapter identity changed.');
    record = await startRestrictedRecord(artifactRoot, guardPath, snapshot);
    await mkdir(record.bundle, { mode: 0o755 });
    materialized = await materializeRestrictedInputs(snapshot, record.bundle, controller.signal);
    const probe = await readPinnedFile(snapshot.probe, 65536, controller.signal);
    for (const [path, bytes] of Object.entries({ 'probe.mjs': probe, 'loader.mjs': loader, 'reporter.mjs': reporter, 'input.json': snapshot.input })) {
      await writeFile(join(record.bundle, path), bytes, { flag: 'wx', mode: 0o444 });
    }
    controller.signal.throwIfAborted();
    const remainingMs = admission.limits.timeoutMs - Math.ceil(performance.now() - started);
    if (remainingMs <= 0) {
      timedOut = true;
      throw new Error('Setup exhausted the attempt deadline.');
    }
    execution = await runDocker(snapshot.backend, record.bundle,
      ['--import', '/bundle/loader.mjs', '--test', '--test-reporter=/bundle/reporter.mjs', '/bundle/probe.mjs'],
      { ...admission.limits, timeoutMs: remainingMs }, controller.signal, record.attemptId);
    cleanupConfirmed = execution.cleanup !== 'unconfirmed';
  } catch (error) {
    execution.detail = String(error);
    if (!record) {
      cleanupConfirmed = false;
      throw error;
    }
  } finally {
    if (record) {
      try {
        await rm(record.bundle, { recursive: true, force: true });
      } catch (error) {
        cleanupConfirmed = false;
        execution.status = 'cleanup_failed';
        execution.cleanup = 'unconfirmed';
        execution.detail += String(error);
      }
    }
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    if (cleanupConfirmed) {
      if (signal?.aborted) execution.status = 'cancelled';
      else if (timedOut) execution.status = 'timeout';
    }
    execution.durationMs = Math.ceil(performance.now() - started);
    settleRestricted(grant, {
      durationMs: execution.durationMs,
      capturedBytes: execution.outputTruncated ? admission.limits.maxOutputBytes : execution.stdout.length + execution.stderr.length,
      cleanupConfirmed,
    });
  }
  const observation = parseNodeObservation(execution, request.targetId, request.input);
  return finishRestrictedRecord(record!, { ...execution, status: observation.status, detail: observation.detail || execution.detail }, {
    ...observation, requestDigest: admission.digest, approval: { attempt: admission.attempt, approvedBy: admission.approvedBy, familySha256: admission.familySha256 },
    source: materialized?.source, dependencies: materialized?.dependencies,
    backend: request.backend, configuration: execution.configuration,
    probeSha256: request.probe.sha256, inputSha256: digestBytes(request.input), adapterSha256,
    targetId: request.targetId, targetSignature, normalizerVersion, limits: admission.limits,
    mocks: ['Pi registration and reviewer context'], dependencyProjection: 'Actual Pi file-mutation queue and Typebox; native Node TypeScript stripping; no full SDK boot',
  });
}
