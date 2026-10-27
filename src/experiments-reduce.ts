import { readFileSync } from 'node:fs';
import { digestBytes } from './experiments-contract.ts';
import type { AttemptEvidence } from './experiments-comparison.ts';
import { assertAttempt, requestWithInput, type ExecuteAttempt } from './experiments-family-context.ts';
import { canonicalSha256 } from './experiments-oracle.ts';

const implementationSha256 = digestBytes(readFileSync(new URL('./experiments-reduce.ts', import.meta.url)));
export function reductionIdentity(): string {
  return implementationSha256;
}

export type ReductionOptions = { maxEvaluations?: number; signal?: AbortSignal; minItems?: number };
export type FindingReduction = {
  status: 'completed' | 'inconclusive';
  witness: AttemptEvidence;
  originalItems: number;
  reducedItems: number;
  oneMinimal: boolean;
  reason: string;
  attempts: AttemptEvidence[];
  replay: AttemptEvidence | null;
};

function findingItems(input: string): Record<string, unknown>[] {
  const parsed = JSON.parse(input);
  if (!parsed || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.items)
    || parsed.items.length > 4 || JSON.stringify(parsed) !== input
    || parsed.items.some((atom: unknown) => !atom || typeof atom !== 'object' || Array.isArray(atom)
      || !['fix', 'nit'].includes(String((atom as Record<string, unknown>).kind))
      || typeof (atom as Record<string, unknown>).blocks !== 'boolean')
    || new Set(parsed.items.map(canonicalSha256)).size !== parsed.items.length) {
    throw new Error('Reduction requires canonical JSON with at most four distinct optional-finding atoms.');
  }
  return parsed.items;
}

/** Ordered single-deletion reducer, not ddmin or a global-minimum search.
 * The caller owns approval, calibration and ONE cumulative execution budget.
 * Only verified target predicates from that executor are evidence here.
 */
export async function reduceFindingWitness(
  initial: AttemptEvidence, execute: ExecuteAttempt, options: ReductionOptions = {},
): Promise<FindingReduction> {
  const attempts: AttemptEvidence[] = [];
  let witness = initial;
  let replay: AttemptEvidence | null = null;
  let originalItems = 0;
  let retained: Record<string, unknown>[] = [];
  let reason = '';
  let audited = false;
  const maxEvaluations = options.maxEvaluations ?? 24;
  const minItems = options.minItems ?? 0;
  const ids = new Set<string>();
  const references = new Set<string>();
  const observations = new Map<string, string>();
  let evaluations = 0;

  function remember(attempt: AttemptEvidence) {
    if (typeof attempt.attemptId !== 'string' || !attempt.attemptId
      || typeof attempt.reference?.path !== 'string' || !attempt.reference.path
      || ids.has(attempt.attemptId) || references.has(attempt.reference.path)) {
      throw new Error('Reduction requires distinct fresh attempt identities and receipt references.');
    }
    ids.add(attempt.attemptId);
    references.add(attempt.reference.path);
    if (attempt.status !== 'completed' || attempt.predicate === 'UNRESOLVED') {
      throw new Error('An execution did not establish the target outcome; no infrastructure retry.');
    }
    const observation = canonicalSha256({ predicate: attempt.predicate, normalized: attempt.normalized });
    const previous = observations.get(attempt.request.input);
    if (previous !== undefined && previous !== observation) {
      throw new Error('Repeated input changed its target outcome or normalized observation.');
    }
    observations.set(attempt.request.input, observation);
  }

  async function evaluate(items: Record<string, unknown>[], phase: string) {
    options.signal?.throwIfAborted();
    if (evaluations >= maxEvaluations) throw new Error('Reduction evaluation budget exhausted.');
    // No grants are issued here: this is only an ordered subset of the original atoms.
    const request = requestWithInput(initial.request, JSON.stringify({ items }));
    evaluations++;
    const attempt = await execute(request, phase);
    attempts.push(attempt);
    assertAttempt(request, attempt);
    remember(attempt);
    options.signal?.throwIfAborted();
    return attempt;
  }

  try {
    retained = findingItems(initial.request.input);
    originalItems = retained.length;
    if (!Number.isSafeInteger(maxEvaluations) || maxEvaluations < 1 || maxEvaluations > 32
      || !Number.isSafeInteger(minItems) || minItems < 0 || minItems > originalItems) {
      throw new Error('Unsupported reduction evaluation or minimum-item bound.');
    }
    options.signal?.throwIfAborted();
    assertAttempt(initial.request, initial);
    remember(initial);
    if (initial.predicate !== 'FAIL') throw new Error('The initial witness is not a verified target failure.');

    // Two explicit fresh repeats establish bounded stability, never an infrastructure retry.
    await evaluate(retained, 'stability');
    await evaluate(retained, 'stability');
    let index = 0;
    while (index < retained.length && retained.length > minItems) {
      const candidate = retained.filter((_atom, position) => position !== index);
      const attempt = await evaluate(candidate, 'removal');
      if (attempt.predicate === 'FAIL') {
        retained = candidate;
        witness = attempt;
        index = 0;
      } else {
        index++;
      }
    }

    // Audit every final single removal freshly, even when greedy search saw it before.
    // A minimum-size boundary cannot justify an unqualified one-minimal label.
    if (retained.length > 0 && retained.length <= minItems) {
      reason = 'Minimum-item bound prevents a complete single-removal audit.';
    } else {
      for (let index = 0; index < retained.length; index++) {
        const candidate = retained.filter((_atom, position) => position !== index);
        const attempt = await evaluate(candidate, 'audit');
        if (attempt.predicate !== 'PASS') throw new Error('A final single removal retained the target failure.');
      }
      audited = true;
    }
    // Always fresh; neither the stability repeats nor a prior removal count as replay.
    replay = await evaluate(retained, 'replay');
    if (replay.predicate !== 'FAIL') throw new Error('Fresh replay did not preserve the target failure.');
  } catch (error) {
    reason = String(error);
  }
  const completed = audited && replay !== null && reason === '';
  return {
    status: completed ? 'completed' : 'inconclusive', witness, originalItems,
    reducedItems: retained.length, oneMinimal: completed, reason: completed
      ? 'Stable target witness; every final single removal passed and a fresh replay failed. Not a global minimum.' : reason,
    attempts, replay,
  };
}
