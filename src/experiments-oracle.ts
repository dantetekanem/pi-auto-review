import { createHash } from 'node:crypto';

type EvidenceKind = 'user-criterion' | 'repository-contract' | 'external-contract' | 'implementation-inference';
type Evidence = Readonly<{ kind: EvidenceKind; ref: string; sha256: string }>;
type Scope = Readonly<{ revisions: readonly string[]; inputClasses: readonly string[] }>;
type Exception = Scope & Readonly<{ id: string; evidence: Evidence }>;
export type Requirement = Scope & Readonly<{
  id: string;
  statement: string;
  authority: Evidence;
  entryId: string;
  exceptions: readonly Exception[];
}>;
export type Oracle = Readonly<{
  targetCheckId: string;
  targetSignature: string;
  normalizerVersion: string;
  normalizerSha256: string;
}>;
export type OracleBinding = Readonly<{ requirement: Requirement; oracle: Oracle; identity: string }>;
export type ClaimRequest = Readonly<{
  revision: string;
  inputClass: string;
  claimKind: 'observation' | 'provisional-inference' | 'requirement-violation';
  verifiedTargetFailure: boolean;
}>;

// JSON identity, not authorization. Only the host can independently approve the
// pinned evidence and issue execution authority; model-supplied hashes prove neither.
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(current: unknown): string {
    if (current === null || typeof current === 'boolean' || typeof current === 'string') {
      return JSON.stringify(current);
    }
    if (typeof current === 'number' && Number.isFinite(current)) return JSON.stringify(current);
    if (typeof current !== 'object') throw new TypeError('Unsupported canonical JSON value.');
    if (ancestors.has(current)) throw new TypeError('Cyclic canonical JSON value.');
    const array = Array.isArray(current);
    if (!array && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
      throw new TypeError('Canonical JSON requires plain objects.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' ||
      (key !== 'length' || !array) && (!('value' in descriptors[key]) || !descriptors[key].enumerable))) {
      throw new TypeError('Canonical JSON rejects symbols, accessors and hidden properties.');
    }
    ancestors.add(current);
    try {
      if (array) {
        const values = current as unknown[];
        if (Object.keys(descriptors).length !== values.length + 1 ||
          Object.keys(descriptors).some(key => key !== 'length' &&
            (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= values.length))) {
          throw new TypeError('Canonical JSON requires dense arrays without extra properties.');
        }
        return `[${values.map((_, index) => encode(descriptors[index].value)).join(',')}]`;
      }
      return `{${Object.keys(descriptors).sort().map(key =>
        `${JSON.stringify(key)}:${encode(descriptors[key].value)}`).join(',')}}`;
    } finally {
      ancestors.delete(current);
    }
  }
  return encode(value);
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function record(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) {
    throw new TypeError('Invalid oracle record fields.');
  }
}

function nonempty(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Invalid oracle text.');
}

function evidence(value: unknown): asserts value is Evidence {
  record(value, ['kind', 'ref', 'sha256']);
  if (!['user-criterion', 'repository-contract', 'external-contract', 'implementation-inference'].includes(value.kind as string)) {
    throw new TypeError('Unsupported requirement authority.');
  }
  nonempty(value.ref);
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new TypeError('Invalid evidence digest.');
  }
}

function scope(value: Record<string, unknown>): asserts value is Record<string, unknown> & Scope {
  for (const field of ['revisions', 'inputClasses']) {
    const items = value[field];
    if (!Array.isArray(items) || items.length === 0 || items.some(item => typeof item !== 'string' || !item.trim()) ||
      new Set(items).size !== items.length) {
      throw new TypeError(`Invalid oracle ${field}.`);
    }
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function freezeOracle(value: { requirement: Requirement; oracle: Oracle }): OracleBinding {
  // Canonical round-trip both rejects unsupported input and detaches caller-owned data.
  const detached: unknown = JSON.parse(canonicalJson(value));
  record(detached, ['requirement', 'oracle']);
  const requirement = detached.requirement;
  record(requirement, ['id', 'statement', 'authority', 'entryId', 'revisions', 'inputClasses', 'exceptions']);
  nonempty(requirement.id);
  nonempty(requirement.statement);
  nonempty(requirement.entryId);
  evidence(requirement.authority);
  scope(requirement);
  if (!Array.isArray(requirement.exceptions)) throw new TypeError('Invalid exceptions.');
  const exceptionIds = new Set<string>();
  for (const exception of requirement.exceptions) {
    record(exception, ['id', 'evidence', 'revisions', 'inputClasses']);
    nonempty(exception.id);
    if (exceptionIds.has(exception.id)) throw new TypeError('Duplicate exception ID.');
    exceptionIds.add(exception.id);
    evidence(exception.evidence);
    if (exception.evidence.kind === 'implementation-inference') {
      throw new TypeError('An inferred exception cannot waive a requirement.');
    }
    scope(exception);
    if (exception.revisions.some((revision: string) => !requirement.revisions.includes(revision)) ||
      exception.inputClasses.some((inputClass: string) => !requirement.inputClasses.includes(inputClass))) {
      throw new TypeError('Exception exceeds requirement scope.');
    }
  }
  const oracle = detached.oracle;
  record(oracle, ['targetCheckId', 'targetSignature', 'normalizerVersion', 'normalizerSha256']);
  nonempty(oracle.targetCheckId);
  nonempty(oracle.targetSignature);
  nonempty(oracle.normalizerVersion);
  if (typeof oracle.normalizerSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(oracle.normalizerSha256)) {
    throw new TypeError('Invalid normalizer digest.');
  }
  const data = deepFreeze(detached as { requirement: Requirement; oracle: Oracle });
  return Object.freeze({ ...data, identity: canonicalSha256(data) });
}

export function assessClaim(binding: OracleBinding, request: ClaimRequest):
  Readonly<{ status: 'inapplicable' | 'exceptioned' | 'observation' | 'provisional-inference' | 'eligible-violation'; eligible: boolean; exceptionId?: string }> {
  nonempty(request.revision);
  nonempty(request.inputClass);
  if (!['observation', 'provisional-inference', 'requirement-violation'].includes(request.claimKind) ||
    typeof request.verifiedTargetFailure !== 'boolean') throw new TypeError('Invalid claim.');
  const { requirement } = binding;
  if (!requirement.revisions.includes(request.revision) || !requirement.inputClasses.includes(request.inputClass)) {
    return { status: 'inapplicable', eligible: false };
  }
  const exception = requirement.exceptions.find(item =>
    item.revisions.includes(request.revision) && item.inputClasses.includes(request.inputClass));
  if (exception) return { status: 'exceptioned', exceptionId: exception.id, eligible: false };
  if (request.claimKind === 'observation' || !request.verifiedTargetFailure) {
    return { status: 'observation', eligible: false };
  }
  if (request.claimKind === 'provisional-inference' || requirement.authority.kind === 'implementation-inference') {
    return { status: 'provisional-inference', eligible: false };
  }
  return { status: 'eligible-violation', eligible: true };
}
