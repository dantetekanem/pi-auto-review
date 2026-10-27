import { isAbsolute } from 'node:path';
import { digestBytes } from './experiments-contract.ts';

export type PinnedFile = { path: string; sha256: string };
export type RestrictedRequest = {
  runId: string;
  profile: 'docker-node-v1';
  backend: {
    socketPath: string; engineId: string; imageId: string; platform: 'linux/arm64';
    seccompPath: string; seccompSha256: string;
  };
  source: {
    repository: string; revision: string; paths: string[];
    mutation?: { label: 'sensitivity-control'; path: string; before: string; after: string };
  };
  dependencies: PinnedFile;
  probe: PinnedFile;
  adapterSha256: string;
  input: string;
  targetId: string;
  limits: { timeoutMs: number; maxOutputBytes: number };
};
export type RestrictedApproval = {
  approvedBy: string; familySha256: string; expiresAt: number;
  maxAttempts: number; maxWallMs: number; maxOutputBytes: number;
};
export type RestrictedGrant = Readonly<{ profile: 'docker-node-v1'; familySha256: string }>;
type Authority = {
  digests: Set<string>; approval: RestrictedApproval; attempts: number;
  durationMs: number; capturedBytes: number; active: boolean; revoked: boolean; fenced: boolean;
};
const authorities = new WeakMap<object, Authority>();
const hash = (value: string) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: number, max: number) => Number.isSafeInteger(value) && value > 0 && value <= max;
const text = (value: string, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);
const absolute = (value: string) => text(value) && isAbsolute(value) && !value.includes(',');

function keys(value: object, allowed: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unsupported restricted request field.');
}
export function safeRelativePath(value: string): boolean {
  return text(value, 500) && !isAbsolute(value) && !value.includes('\\')
    && value.split('/').every(part => part !== '.' && part !== '..' && part !== '' && part !== '.git');
}

export function describeRestricted(value: RestrictedRequest) {
  keys(value, ['runId', 'profile', 'backend', 'source', 'dependencies', 'probe', 'adapterSha256', 'input', 'targetId', 'limits']);
  if (value.profile !== 'docker-node-v1' || !text(value.runId, 128) || !/^[\w-]+$/.test(value.runId)) {
    throw new Error('Unsupported restricted profile or run.');
  }
  const backend = value.backend;
  keys(backend, ['socketPath', 'engineId', 'imageId', 'platform', 'seccompPath', 'seccompSha256']);
  if (!absolute(backend.socketPath) || !text(backend.engineId, 128)
    || !/^sha256:[a-f0-9]{64}$/.test(backend.imageId) || backend.platform !== 'linux/arm64'
    || !absolute(backend.seccompPath) || !hash(backend.seccompSha256)) throw new Error('Invalid restricted backend.');
  const source = value.source;
  keys(source, ['repository', 'revision', 'paths', 'mutation']);
  if (!absolute(source.repository) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.revision)
    || !Array.isArray(source.paths) || !source.paths.length || source.paths.length > 64
    || new Set(source.paths).size !== source.paths.length || !source.paths.every(safeRelativePath)) {
    throw new Error('Unsupported committed source.');
  }
  if (source.mutation) {
    const mutation = source.mutation;
    keys(mutation, ['label', 'path', 'before', 'after']);
    if (mutation.label !== 'sensitivity-control' || !source.paths.includes(mutation.path)
      || !text(mutation.before, 1024) || !text(mutation.after, 1024) || mutation.before === mutation.after) {
      throw new Error('Invalid labeled sensitivity control.');
    }
  }
  for (const pin of [value.dependencies, value.probe]) {
    keys(pin, ['path', 'sha256']);
    if (!absolute(pin.path) || !hash(pin.sha256)) throw new Error('Invalid restricted input pin.');
  }
  keys(value.limits, ['timeoutMs', 'maxOutputBytes']);
  if (!hash(value.adapterSha256) || !text(value.targetId, 80) || !/^[\w.-]+$/.test(value.targetId)
    || typeof value.input !== 'string' || Buffer.byteLength(value.input) > 16384
    || !integer(value.limits.timeoutMs, 30000) || !integer(value.limits.maxOutputBytes, 1048576)) {
    throw new Error('Invalid restricted probe, input or limits.');
  }
  JSON.parse(value.input);
  const request = structuredClone(value);
  return { request, digest: digestBytes(JSON.stringify(request)) };
}

export function assertDockerIdentity(backend: RestrictedRequest['backend'], info: unknown, image: unknown): void {
  if (!info || typeof info !== 'object') throw new Error('Restricted backend is unavailable.');
  const engine = info as Record<string, unknown>;
  if (engine.ID !== backend.engineId || engine.OSType !== 'linux' || engine.CgroupVersion !== '2'
    || !['MemoryLimit', 'SwapLimit', 'PidsLimit', 'CpuCfsQuota'].every(key => engine[key] === true)
    || !Array.isArray(engine.SecurityOptions) || !engine.SecurityOptions.includes('name=seccomp,profile=builtin')
    || !engine.SecurityOptions.includes('name=cgroupns')) throw new Error('Unsupported restricted backend identity or controllers.');
  if (!image || typeof image !== 'object') throw new Error('Restricted image is unavailable.');
  const pinned = image as Record<string, unknown>;
  const config = pinned.Config as { Volumes?: unknown } | undefined;
  if (pinned.Id !== backend.imageId || pinned.Os !== 'linux' || pinned.Architecture !== 'arm64'
    || !config || (config.Volumes && Object.keys(config.Volumes).length)) {
    throw new Error('Unsupported restricted image identity or volumes.');
  }
}

/** Host API only. Enumerate the finite allowed requests before approval; no model can add one later. */
export function approveRestricted(requests: RestrictedRequest[], approval: RestrictedApproval): RestrictedGrant {
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > 128
    || !text(approval.approvedBy, 200) || !hash(approval.familySha256)
    || !integer(approval.maxAttempts, 64) || !integer(approval.maxWallMs, 600000)
    || !integer(approval.maxOutputBytes, 16777216)) throw new Error('Invalid restricted authority or budget.');
  if (!Number.isSafeInteger(approval.expiresAt) || approval.expiresAt <= Date.now()
    || approval.expiresAt > Date.now() + 86400000) throw new Error('Invalid restricted authority expiry.');
  const prepared = requests.map(describeRestricted);
  if (new Set(prepared.map(item => item.request.runId)).size !== 1) throw new Error('Mixed review runs.');
  const grant = Object.freeze({ profile: 'docker-node-v1' as const, familySha256: approval.familySha256 });
  authorities.set(grant, {
    digests: new Set(prepared.map(item => item.digest)), approval: { ...approval },
    attempts: 0, durationMs: 0, capturedBytes: 0, active: false, revoked: false, fenced: false,
  });
  return grant;
}

function authorityFor(grant: unknown): Authority {
  const authority = grant && typeof grant === 'object' ? authorities.get(grant) : undefined;
  if (!authority) throw new Error('A host-issued restricted grant is required.');
  return authority;
}

export function reserveRestricted(request: RestrictedRequest, grant: unknown) {
  const authority = authorityFor(grant);
  const prepared = describeRestricted(request);
  if (!authority.digests.has(prepared.digest)) throw new Error('Restricted grant does not match this request.');
  if (authority.revoked || Date.now() >= authority.approval.expiresAt) throw new Error('Restricted grant expired or revoked.');
  if (authority.fenced) throw new Error('Previous cleanup is unconfirmed; reconcile it before new work.');
  if (authority.active) throw new Error('A restricted attempt is already active.');
  const timeoutMs = Math.min(request.limits.timeoutMs, authority.approval.maxWallMs - authority.durationMs, authority.approval.expiresAt - Date.now());
  const maxOutputBytes = Math.min(request.limits.maxOutputBytes, authority.approval.maxOutputBytes - authority.capturedBytes);
  if (authority.attempts >= authority.approval.maxAttempts || timeoutMs <= 0 || maxOutputBytes <= 0) {
    throw new Error('Restricted cumulative budget exhausted.');
  }
  authority.active = true;
  authority.attempts++;
  return {
    ...prepared, attempt: authority.attempts, approvedBy: authority.approval.approvedBy,
    familySha256: authority.approval.familySha256, limits: { timeoutMs, maxOutputBytes },
  };
}

export function settleRestricted(grant: unknown, result: { durationMs: number; capturedBytes: number; cleanupConfirmed: boolean }): void {
  const authority = authorityFor(grant);
  if (!authority.active) throw new Error('No active restricted attempt.');
  if (![result.durationMs, result.capturedBytes].every(value => Number.isSafeInteger(value) && value >= 0)
    || typeof result.cleanupConfirmed !== 'boolean') throw new Error('Invalid restricted accounting.');
  authority.durationMs += result.durationMs;
  authority.capturedBytes += result.capturedBytes;
  authority.fenced = !result.cleanupConfirmed;
  authority.active = false;
}

export function revokeRestricted(grant: unknown): void {
  authorityFor(grant).revoked = true;
}
