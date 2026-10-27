import { describeRestricted, type RestrictedRequest } from './experiments-restricted-contract.ts';
import { canonicalSha256 } from './experiments-oracle.ts';
import type { AttemptEvidence } from './experiments-comparison.ts';

export type ExecuteAttempt = (request: RestrictedRequest, phase: string) => Promise<AttemptEvidence>;

export function requestWithInput(template: RestrictedRequest, input: string): RestrictedRequest {
  return describeRestricted({ ...structuredClone(template), input }).request;
}

export function assertAttempt(request: RestrictedRequest, attempt: AttemptEvidence) {
  if (attempt.requestDigest !== describeRestricted(request).digest
    || canonicalSha256(attempt.request) !== canonicalSha256(request)
    || !['PASS', 'FAIL', 'UNRESOLVED'].includes(attempt.predicate)) {
    throw new Error('Runner returned a different request or unsupported predicate.');
  }
}
