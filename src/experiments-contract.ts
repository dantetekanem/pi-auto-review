import { createHash } from 'node:crypto';

export type FixtureRequest = {
  runId: string;
  profile: 'trusted-fixture';
  source: string;
  probe: string;
  input: string;
  targetId: string;
  limits: Readonly<{ timeoutMs: number; maxOutputBytes: number }>;
};

export type FixtureObservation = 'passed' | 'target_failure' | 'not_observed' | 'probe_error';
export type FixtureStatus =
  | 'completed'
  | 'setup_error'
  | 'process_error'
  | 'timeout'
  | 'output_limit'
  | 'cancelled';

export function digestBytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function text(value: string, name: string, maxBytes = 131072): string {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > maxBytes) {
    throw new Error(`Invalid fixture ${name}.`);
  }
  return value;
}

function boundedInteger(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error('Invalid fixture execution limit.');
  }
  return value;
}

export function describeFixture(value: FixtureRequest) {
  if (value?.profile !== 'trusted-fixture') throw new Error('Unsupported fixture profile.');
  const runId = text(value.runId, 'run ID', 128);
  const targetId = text(value.targetId, 'target ID', 80);
  if (!/^[\w-]+$/.test(runId) || !/^[\w.:-]+$/.test(targetId)) {
    throw new Error('Invalid fixture identity.');
  }
  const input = text(value.input, 'JSON input');
  JSON.parse(input);
  const request: Readonly<FixtureRequest> = Object.freeze({
    runId,
    profile: 'trusted-fixture',
    source: text(value.source, 'source'),
    probe: text(value.probe, 'probe'),
    input,
    targetId,
    limits: Object.freeze({
      timeoutMs: boundedInteger(value.limits?.timeoutMs, 30000),
      maxOutputBytes: boundedInteger(value.limits?.maxOutputBytes, 1048576),
    }),
  });
  const runtime = Object.freeze({
    executable: process.execPath,
    version: process.version,
    platform: process.platform,
    arch: process.arch,
  });
  const identities = Object.freeze({
    source: digestBytes(request.source),
    probe: digestBytes(request.probe),
    input: digestBytes(request.input),
  });
  return Object.freeze({
    request,
    runtime,
    identities,
    digest: digestBytes(JSON.stringify({ request, runtime })),
  });
}

export type ExecutionGrant = Readonly<{ profile: 'trusted-fixture' | 'trusted-program'; requestDigest: string }>;
export type FixtureGrant = ExecutionGrant;
type Authorization = {
  digest: string;
  approvedBy: string;
  maxAttempts: number;
  remaining: number;
};
const grants = new WeakMap<object, Authorization>();

// Host API only: the caller must already have authorization for these exact fixtures.
// This in-process capability is neither user authentication nor a sandbox. Never expose
// grant issuance as an agent tool or accept an approval-shaped JSON object instead.
export function approveExecution(
  digest: string,
  profile: ExecutionGrant['profile'],
  approval: { approvedBy: string; maxAttempts: number },
): ExecutionGrant {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid execution identity.');
  const approvedBy = text(approval.approvedBy, 'approver', 200);
  if (!approvedBy.trim()) throw new Error('Invalid fixture approver.');
  const maxAttempts = boundedInteger(approval.maxAttempts, 10);
  const grant = Object.freeze({ profile, requestDigest: digest });
  grants.set(grant, { digest, approvedBy, maxAttempts, remaining: maxAttempts });
  return grant;
}

// Admission and attempt reservation are synchronous, before any filesystem/process work.
export function claimExecution(digest: string, grant: unknown) {
  const authorization = grant && typeof grant === 'object' ? grants.get(grant) : undefined;
  if (!authorization) throw new Error('A host-issued execution grant is required.');
  if (authorization.digest !== digest) throw new Error('Execution grant does not match the request.');
  if (authorization.remaining === 0) throw new Error('Execution grant is exhausted.');
  authorization.remaining -= 1;
  return Object.freeze({
    approvedBy: authorization.approvedBy,
    attempt: authorization.maxAttempts - authorization.remaining,
    maxAttempts: authorization.maxAttempts,
  });
}

export function approveTrustedFixture(
  request: FixtureRequest,
  approval: { approvedBy: string; maxAttempts: number },
): FixtureGrant {
  return approveExecution(describeFixture(request).digest, 'trusted-fixture', approval);
}

export function claimFixture(request: FixtureRequest, grant: unknown) {
  const prepared = describeFixture(request);
  return Object.freeze({ ...prepared, approval: claimExecution(prepared.digest, grant) });
}
