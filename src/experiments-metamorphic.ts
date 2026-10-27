import { readFileSync } from 'node:fs';
import { digestBytes } from './experiments-contract.ts';
import { describeRestricted, type RestrictedRequest } from './experiments-restricted-contract.ts';
import { assessClaim, canonicalJson, canonicalSha256, freezeOracle, type OracleBinding } from './experiments-oracle.ts';
import { predicateScope, type Calibration } from './experiments-calibration.ts';
import type { AttemptEvidence } from './experiments-comparison.ts';
import type { ExecuteAttempt } from './experiments-family-context.ts';

const relationSha256 = digestBytes(readFileSync(new URL('./experiments-metamorphic.ts', import.meta.url)));
export const memberOrderIdentity = () => relationSha256;
const relation = {
  version: 'json-member-order-v1',
  source: 'https://www.rfc-editor.org/rfc/rfc8259#section-4',
  statement: 'Unique JSON object members preserve their name/value mapping; arrays stay ordered.',
  applicability: 'Selected finding handler reads named fields. This is a scoped interoperability check, not a rule for every JSON consumer.',
  entryId: 'registerFindings/agentic_code_review_append_finding',
};

function reverseMembers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseMembers);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseMembers(item)]));
}

export function prepareMemberOrderPair(input: string) {
  if (Buffer.byteLength(input) > 16384) throw new Error('Relation input exceeds its bound.');
  const value = JSON.parse(input);
  // Canonical input proves this generated serialization contains no duplicate member names.
  if (canonicalJson(value) !== input || !Array.isArray(value?.items) || !value.items.length || value.items.length > 4
    || value.items.some((item: Record<string, unknown>) => !item || !['fix', 'nit'].includes(String(item.kind)) || typeof item.blocks !== 'boolean')) {
    throw new Error('Relation needs canonical, nonempty optional-finding input with unique members.');
  }
  const right = JSON.stringify(reverseMembers(value));
  if (right === input || canonicalJson(JSON.parse(right)) !== input) throw new Error('No applicable member-order transformation.');
  return { left: input, right, relation, identity: canonicalSha256({ relation, relationSha256, input }) };
}

export async function runMemberOrderRelation(
  binding: OracleBinding, template: RestrictedRequest, calibration: Calibration,
  execute: ExecuteAttempt, signal?: AbortSignal,
) {
  const attempts: AttemptEvidence[] = [];
  const result = (status: 'inapplicable' | 'inconclusive' | 'observed-equivalent' | 'observed-difference', reason: string) => ({
    status, reason, attempts, relation, relationSha256, oracleIdentity: binding.identity, formalProof: false,
  });
  let pair: ReturnType<typeof prepareMemberOrderPair>;
  try {
    const frozen = freezeOracle({ requirement: binding.requirement, oracle: binding.oracle });
    const scope = assessClaim(frozen, { revision: template.source.revision, inputClass: 'optional-findings', claimKind: 'observation', verifiedTargetFailure: false });
    if (binding.identity !== frozen.identity || binding.requirement.entryId !== relation.entryId
      || ['inapplicable', 'exceptioned'].includes(scope.status) || calibration.status !== 'calibrated'
      || calibration.oracleIdentity !== frozen.identity || calibration.scope !== predicateScope(template)) {
      return result('inapplicable', 'Entry, requirement, options or calibration do not establish this relation.');
    }
    pair = prepareMemberOrderPair(template.input);
  } catch (error) {
    return result('inapplicable', String(error));
  }
  try {
    for (const input of [pair.left, pair.right]) {
      signal?.throwIfAborted();
      const prepared = describeRestricted({ ...structuredClone(template), input });
      const attempt = await execute(prepared.request, 'metamorphic');
      if (attempt.requestDigest !== prepared.digest || canonicalSha256(attempt.request) !== canonicalSha256(prepared.request)
        || attempts.some(prior => prior.attemptId === attempt.attemptId)) throw new Error('Relation execution identity changed or was reused.');
      attempts.push(attempt);
      if (attempt.predicate === 'UNRESOLVED') return result('inconclusive', 'Both target outcomes are required for the relation.');
    }
    const [left, right] = attempts;
    const equal = left.predicate === right.predicate && canonicalSha256(left.normalized) === canonicalSha256(right.normalized);
    return { ...result(equal ? 'observed-equivalent' : 'observed-difference',
      equal ? 'Normalized results agree for this pair only.' : 'Reordering members changed the observed result; reviewer interpretation is still required.'),
      pairIdentity: pair.identity };
  } catch (error) {
    return result('inconclusive', String(error));
  }
}
