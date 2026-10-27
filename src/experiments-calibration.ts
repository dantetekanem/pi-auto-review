import { comparisonContext, compareAttempts, type AttemptEvidence } from './experiments-comparison.ts';
import { canonicalSha256, type OracleBinding } from './experiments-oracle.ts';
import type { RestrictedRequest } from './experiments-restricted-contract.ts';

export type Calibration = ReturnType<typeof calibratePredicate>;
export type Controls = { pass: AttemptEvidence; failure: AttemptEvidence; infrastructure: AttemptEvidence };

// Families vary inputs within an independently approved domain; all other probe context stays fixed.
export const predicateScope = (request: RestrictedRequest) => comparisonContext({ ...request, input: 'null' });

/** Consumes verified host AttemptEvidence, not model-supplied receipt-shaped objects. */
export function calibratePredicate(binding: OracleBinding, controls: Controls, inputClass: string) {
  const { pass, failure, infrastructure } = controls;
  const comparison = compareAttempts(binding, pass, failure, inputClass);
  const setupContext = comparisonContext({ ...infrastructure.request, dependencies: pass.request.dependencies });
  const calibrated = comparison.status === 'sensitivity-control'
    && pass.predicate === 'PASS' && !pass.request.source.mutation
    && failure.predicate === 'FAIL' && failure.request.source.mutation?.label === 'sensitivity-control'
    && pass.request.source.revision === failure.request.source.revision
    && infrastructure.predicate === 'UNRESOLVED' && infrastructure.status === 'setup_error'
    && !infrastructure.request.source.mutation
    && infrastructure.request.source.revision === pass.request.source.revision
    && setupContext === comparisonContext(pass.request);
  const data = {
    status: calibrated ? 'calibrated' as const : 'unresolved' as const,
    reason: calibrated ? 'The unchanged probe detects the labeled mutation and separates setup failure.'
      : 'Pass, intended-failure, setup or applicability control did not match the frozen predicate.',
    oracleIdentity: binding.identity,
    inputClass,
    scope: predicateScope(pass.request),
    controls: [pass.reference, failure.reference, infrastructure.reference],
    requirementTruthEstablished: false,
  };
  return { ...data, identity: canonicalSha256(data) };
}
