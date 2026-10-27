import { readFileSync } from 'node:fs';
import { digestBytes } from './experiments-contract.ts';
import type { RestrictedRequest } from './experiments-restricted-contract.ts';
import { canonicalJson, canonicalSha256, freezeOracle, type OracleBinding } from './experiments-oracle.ts';
import { calibratePredicate, predicateScope, type Calibration, type Controls } from './experiments-calibration.ts';
import type { AttemptEvidence } from './experiments-comparison.ts';
import { memberOrderIdentity, prepareMemberOrderPair, runMemberOrderRelation } from './experiments-metamorphic.ts';
import { reduceFindingWitness, reductionIdentity } from './experiments-reduce.ts';
import { assertAttempt, requestWithInput, type ExecuteAttempt } from './experiments-family-context.ts';

export { assertAttempt, requestWithInput, type ExecuteAttempt } from './experiments-family-context.ts';

export type FindingFamilySpec = {
  version: 'optional-findings-v1';
  seed: number;
  trials: number;
  inputClass: 'optional-findings';
  domain: { atoms: Record<string, unknown>[]; minItems: number };
};
export type PreparedFamily = {
  id: string;
  spec: FindingFamilySpec;
  binding: OracleBinding;
  generatorSha256: string;
  templateCheckId: string;
  controls: { pass: string; failure: string; infrastructure: string };
  metamorphic?: { sha256: string };
  reduction?: { sha256: string; maxEvaluations: number };
};
const generatorSha256 = digestBytes(readFileSync(new URL('./experiments-family.ts', import.meta.url)));

function freezeSpec(value: FindingFamilySpec): FindingFamilySpec {
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded) > 12000) throw new Error('Family domain exceeds its limit.');
  const spec: FindingFamilySpec = JSON.parse(encoded);
  if (spec.version !== 'optional-findings-v1' || spec.inputClass !== 'optional-findings'
    || !Number.isInteger(spec.seed) || spec.seed < 0 || spec.seed > 0xffffffff
    || !Number.isInteger(spec.trials) || spec.trials < 1 || spec.trials > 16
    || !Array.isArray(spec.domain?.atoms) || spec.domain.atoms.length < 1 || spec.domain.atoms.length > 4
    || !Number.isInteger(spec.domain.minItems) || spec.domain.minItems < 0 || spec.domain.minItems > spec.domain.atoms.length
    || spec.domain.atoms.some(atom => !atom || !['fix', 'nit'].includes(String(atom.kind)) || typeof atom.blocks !== 'boolean')
    || new Set(spec.domain.atoms.map(canonicalSha256)).size !== spec.domain.atoms.length) {
    throw new Error('Unsupported finite optional-finding family.');
  }
  return spec;
}

export function enumerateFamilyInputs(value: FindingFamilySpec): string[] {
  const spec = freezeSpec(value);
  return Array.from({ length: 2 ** spec.domain.atoms.length }, (_, mask) => JSON.stringify({
    items: spec.domain.atoms.filter((_atom, index) => mask & (1 << index)),
  }));
}

export function generateFindingFamily(value: FindingFamilySpec) {
  const spec = freezeSpec(value);
  const inputs = enumerateFamilyInputs(spec);
  let state = spec.seed;
  const classes: Record<string, number> = {};
  const acceptedClasses: Record<string, number> = {};
  const trials = Array.from({ length: spec.trials }, (_, index) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const input = inputs[state % inputs.length];
    const items = JSON.parse(input).items as Record<string, unknown>[];
    const kinds = new Set(items.map(item => item.kind));
    const inputClass = !items.length ? 'empty-core' : kinds.size === 2 ? 'mixed' : `${items[0].kind}-only`;
    const accepted = items.length >= spec.domain.minItems;
    classes[inputClass] = (classes[inputClass] ?? 0) + 1;
    if (accepted) acceptedClasses[inputClass] = (acceptedClasses[inputClass] ?? 0) + 1;
    return { index, input, inputSha256: digestBytes(input), inputClass, accepted };
  });
  const accepted = trials.filter(trial => trial.accepted).length;
  return {
    identity: canonicalSha256({ spec, generatorSha256 }),
    spec,
    generatorSha256,
    generated: trials.length,
    accepted,
    rejected: trials.length - accepted,
    classes,
    acceptedClasses,
    trials,
  };
}

export function validatePreparedFamily(family: PreparedFamily, requests: Map<string, RestrictedRequest>): void {
  if (!/^[\w-]{1,80}$/.test(family.id)) throw new Error('Invalid prepared family ID.');
  const generated = generateFindingFamily(family.spec);
  const binding = freezeOracle({ requirement: family.binding.requirement, oracle: family.binding.oracle });
  if (family.generatorSha256 !== generated.generatorSha256 || family.binding.identity !== binding.identity) {
    throw new Error('Prepared family generator or oracle identity changed.');
  }
  const template = requests.get(family.templateCheckId);
  if (!template || ['pass', 'failure', 'infrastructure'].some(key => !requests.has(family.controls?.[key as keyof Controls]))) {
    throw new Error('Prepared family is missing a template or control.');
  }
  if (family.metamorphic && family.metamorphic.sha256 !== memberOrderIdentity()) throw new Error('Prepared relation identity changed.');
  if (family.reduction && (family.reduction.sha256 !== reductionIdentity()
    || !Number.isInteger(family.reduction.maxEvaluations) || family.reduction.maxEvaluations < 1 || family.reduction.maxEvaluations > 32)) {
    throw new Error('Prepared reducer identity or budget changed.');
  }
  const inputs = enumerateFamilyInputs(family.spec);
  if (family.metamorphic) {
    inputs.push(...inputs.filter(input => JSON.parse(input).items.length > 0).map(input => prepareMemberOrderPair(input).right));
  }
  const allowed = new Set([...requests.values()].map(canonicalSha256));
  if (inputs.some(input => !allowed.has(canonicalSha256(requestWithInput(template, input))))) {
    throw new Error('Prepared family inputs exceed the approved request set.');
  }
}

export async function runPreparedFamily(
  family: PreparedFamily, requests: Map<string, RestrictedRequest>,
  executeCheck: (id: string) => Promise<AttemptEvidence>, signal?: AbortSignal,
) {
  validatePreparedFamily(family, requests);
  const controls: Partial<Controls> = {};
  try {
    for (const key of ['pass', 'failure', 'infrastructure'] as const) {
      signal?.throwIfAborted();
      const id = family.controls[key];
      controls[key] = await executeCheck(id);
      assertAttempt(requests.get(id)!, controls[key]);
    }
    const calibration = calibratePredicate(family.binding, controls as Controls, family.spec.inputClass);
    const template = requests.get(family.templateCheckId)!;
    const ids = new Map([...requests].map(([id, request]) => [canonicalSha256(request), id]));
    const execute: ExecuteAttempt = async request => {
      const id = ids.get(canonicalSha256(request));
      if (!id) throw new Error('Family request was not approved.');
      return executeCheck(id);
    };
    const result = await runFindingFamily(family.spec, family.binding, template, calibration, execute, signal);
    let metamorphic;
    if (family.metamorphic && result.status === 'completed') {
      const candidate = result.outcomes.find(outcome => JSON.parse(outcome.attempt.request.input).items.length > 0);
      metamorphic = candidate
        ? await runMemberOrderRelation(family.binding, candidate.attempt.request, calibration, execute, signal)
        : { status: 'inapplicable', reason: 'No nonempty eligible input was executed.', attempts: [] };
    }
    let reduction;
    if (family.reduction && result.status === 'completed') {
      const failures = result.outcomes.filter(outcome => outcome.attempt.predicate === 'FAIL');
      const itemCount = (outcome: typeof failures[number]) => JSON.parse(outcome.attempt.request.input).items.length;
      const candidate = failures.sort((left, right) => itemCount(right) - itemCount(left))[0];
      reduction = candidate
        ? await reduceFindingWitness(candidate.attempt, execute, { ...family.reduction, minItems: family.spec.domain.minItems, signal })
        : { status: 'not-applicable', reason: 'No target failure was observed.', oneMinimal: false, replay: null };
    }
    const unresolvedRelation = metamorphic && ['inconclusive', 'inapplicable'].includes(metamorphic.status);
    const unresolvedReduction = reduction?.status === 'inconclusive';
    return {
      status: unresolvedRelation || unresolvedReduction ? 'inconclusive' as const : result.status,
      family: result,
      reason: metamorphic && unresolvedRelation ? metamorphic.reason
        : reduction && unresolvedReduction ? reduction.reason : result.reason,
      ...(metamorphic && { metamorphic }),
      ...(reduction && { reduction }),
    };
  } catch (error) {
    return { status: 'inconclusive' as const, family: null, reason: String(error), controls };
  }
}

/** One host-approved finite decision, serial executions, no model turn per generated input. */
export async function runFindingFamily(
  spec: FindingFamilySpec, binding: OracleBinding, template: RestrictedRequest,
  calibration: Calibration, execute: ExecuteAttempt, signal?: AbortSignal,
) {
  const generated = generateFindingFamily(spec);
  const frozen = freezeOracle({ requirement: binding.requirement, oracle: binding.oracle });
  const outcomes: { index: number; inputClass: string; attempt: AttemptEvidence }[] = [];
  const attemptIds = new Set<string>();
  let reason = '';
  if (binding.identity !== frozen.identity || calibration.oracleIdentity !== frozen.identity
    || calibration.status !== 'calibrated' || calibration.inputClass !== spec.inputClass
    || calibration.scope !== predicateScope(template)
    || !frozen.requirement.revisions.includes(template.source.revision)) {
    reason = 'Family context is not covered by the calibrated predicate.';
  } else if (generated.accepted === 0) {
    reason = 'All generated inputs were rejected.';
  } else {
    for (const trial of generated.trials) {
      if (!trial.accepted) continue;
      try {
        signal?.throwIfAborted();
        const request = requestWithInput(template, trial.input);
        const attempt = await execute(request, 'trial');
        assertAttempt(request, attempt);
        if (attemptIds.has(attempt.attemptId)) throw new Error('A trial reused a prior attempt.');
        attemptIds.add(attempt.attemptId);
        outcomes.push({ index: trial.index, inputClass: trial.inputClass, attempt });
        if (attempt.predicate === 'UNRESOLVED') {
          reason = 'A trial did not establish the target outcome.';
          break;
        }
      } catch (error) {
        reason = String(error);
        break;
      }
    }
  }
  return {
    ...generated,
    status: reason ? 'inconclusive' as const : 'completed' as const,
    reason,
    identity: canonicalSha256({ family: generated.identity, oracle: frozen.identity, template }),
    kind: template.source.mutation ? 'sensitivity-control' : 'revision-observation',
    binding: { requirement: frozen.requirement, oracle: frozen.oracle },
    calibration,
    executed: outcomes.length,
    observedFailures: outcomes.filter(outcome => outcome.attempt.predicate === 'FAIL').length,
    outcomes,
    formalProof: false,
  };
}
