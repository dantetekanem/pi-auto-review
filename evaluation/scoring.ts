import { canonicalSha256 } from '../src/experiments-oracle.ts';

type Case = { id: string; base: string; head: string; knownDefects: string[] };
export type EvaluationPlan = {
  schemaVersion: 1;
  corpusSha256: string;
  model: string;
  thinking: string;
  variants: { id: string; sha256: string }[];
  cases: Case[];
  budget: { modelCalls: number; inputTokens: number; outputTokens: number; executionAttempts: number; costUsd: number };
};
const statuses = ['complete', 'incomplete', 'infrastructure-error', 'invalid-fixture', 'unsupported', 'unknown'] as const;
const usageKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd', 'wallMs', 'executionMs'] as const;
const executionKeys = ['attempts', 'replayedFailures', 'setupFailures', 'invalidFixtures', 'duplicates', 'unresolved'] as const;
type CostBasis = 'provider-reported' | 'usage-times-prices';
export type EvaluationRun = {
  planId: string;
  caseId: string;
  variant: string;
  status: typeof statuses[number];
  findings: { id: string }[];
  usage?: Partial<Record<typeof usageKeys[number], number | null>> & { costBasis?: CostBasis };
  execution?: Record<typeof executionKeys[number], number> & { receipts: string[] };
};
export type Adjudication = {
  caseId: string;
  variant: string;
  findingId: string;
  adjudicator: string;
  reason: string;
  evidence: string[];
} & (
  | { verdict: 'known'; defectId: string }
  | { verdict: 'false-positive' | 'novel' }
  | { verdict: 'duplicate'; duplicateOf: string }
);

const sha = (value: string) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const named = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);
const finite = (value: number) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const key = (...parts: string[]) => JSON.stringify(parts);
const rate = (numerator: number, denominator: number) => ({ numerator, denominator, value: denominator ? numerator / denominator : null });

function validatePlan(plan: EvaluationPlan) {
  if (plan.schemaVersion !== 1 || !sha(plan.corpusSha256) || !named(plan.model)
    || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(plan.thinking)
    || !Array.isArray(plan.variants) || !plan.variants.length || plan.variants.length > 4
    || new Set(plan.variants.map(variant => variant.id)).size !== plan.variants.length
    || plan.variants.some(variant => !named(variant.id) || !sha(variant.sha256))) {
    throw new Error('Invalid frozen evaluation plan.');
  }
  if (!Array.isArray(plan.cases) || !plan.cases.length || plan.cases.length > 4
    || new Set(plan.cases.map(item => item.id)).size !== plan.cases.length
    || plan.cases.some(item => !named(item.id) || !/^[a-f0-9]{40}$/.test(item.base) || !/^[a-f0-9]{40}$/.test(item.head)
      || !Array.isArray(item.knownDefects) || item.knownDefects.length > 32
      || item.knownDefects.some(id => !named(id)) || new Set(item.knownDefects).size !== item.knownDefects.length)) {
    throw new Error('Invalid frozen case identities.');
  }
  if (!plan.budget || Object.keys(plan.budget).sort().join(',') !== 'costUsd,executionAttempts,inputTokens,modelCalls,outputTokens'
    || Object.entries(plan.budget).some(([name, value]) => !finite(value) || name !== 'costUsd' && !Number.isSafeInteger(value))) {
    throw new Error('Invalid matched evaluation budget.');
  }
}

export function evaluationIdentity(plan: EvaluationPlan): string {
  validatePlan(plan);
  return canonicalSha256(plan);
}

function validateRun(run: EvaluationRun) {
  if (!statuses.includes(run.status) || !Array.isArray(run.findings) || run.findings.length > 128
    || run.findings.some(finding => !named(finding.id)) || new Set(run.findings.map(finding => finding.id)).size !== run.findings.length) {
    throw new Error('Invalid run status or finding identities.');
  }
  for (const metric of usageKeys) {
    const value = run.usage?.[metric];
    if (value != null && (!finite(value) || metric.endsWith('Tokens') && !Number.isSafeInteger(value))) {
      throw new Error('Invalid usage metric.');
    }
  }
  if (run.usage?.costUsd != null && !['provider-reported', 'usage-times-prices'].includes(run.usage.costBasis ?? '')) {
    throw new Error('A recorded cost requires its cost basis.');
  }
  const execution = run.execution;
  if (execution && (executionKeys.some(metric => !finite(execution[metric]) || !Number.isSafeInteger(execution[metric]))
    || !Array.isArray(execution.receipts) || execution.receipts.some(reference => !sha(reference))
    || execution.attempts > 0 && !execution.receipts.length)) {
    throw new Error('Invalid execution counters or receipt references.');
  }
}

function total(runs: (EvaluationRun | undefined)[], metric: (run: EvaluationRun) => number | null | undefined) {
  let knownTotal = 0;
  let missingCases = 0;
  for (const run of runs) {
    const value = run && metric(run);
    if (value == null) missingCases++;
    else knownTotal += value;
  }
  if (!Number.isFinite(knownTotal)) throw new Error('Metric total overflow.');
  return { total: missingCases ? null : knownTotal, knownTotal, missingCases };
}

/** Scores independently supplied judgments, not claim truth. No model calls or runtime execution. */
export function scoreEvaluation(plan: EvaluationPlan, runs: EvaluationRun[], judgments: Adjudication[]) {
  const planId = evaluationIdentity(plan);
  const cases = new Map(plan.cases.map(item => [item.id, item]));
  const variants = new Set(plan.variants.map(item => item.id));
  if (runs.length > cases.size * variants.size || judgments.length > cases.size * variants.size * 128) {
    throw new Error('Duplicate run or oversized evaluation.');
  }

  const byRun = new Map<string, EvaluationRun>();
  for (const run of runs) {
    if (run.planId !== planId || !cases.has(run.caseId) || !variants.has(run.variant)) {
      throw new Error('Run does not match the frozen plan.');
    }
    const id = key(run.caseId, run.variant);
    if (byRun.has(id)) throw new Error('Duplicate run for one case/variant.');
    validateRun(run);
    byRun.set(id, run);
  }
  const byFinding = new Map<string, Adjudication>();
  for (const judgment of judgments) {
    const run = byRun.get(key(judgment.caseId, judgment.variant));
    if (!run?.findings.some(finding => finding.id === judgment.findingId)) throw new Error('Judgment has no matching finding.');
    const id = key(judgment.caseId, judgment.variant, judgment.findingId);
    if (byFinding.has(id) || !named(judgment.adjudicator) || !judgment.reason?.trim()
      || !Array.isArray(judgment.evidence) || !judgment.evidence.length || judgment.evidence.some(ref => !named(ref))) {
      throw new Error('Conflicting or unsupported judgment.');
    }
    if (judgment.verdict === 'known' && !cases.get(judgment.caseId)!.knownDefects.includes(judgment.defectId)) {
      throw new Error('Unknown gold defect.');
    }
    if (!['known', 'false-positive', 'novel', 'duplicate'].includes(judgment.verdict)) throw new Error('Invalid judgment verdict.');
    byFinding.set(id, judgment);
  }
  for (const judgment of judgments) {
    if (judgment.verdict !== 'duplicate') continue;
    const original = byFinding.get(key(judgment.caseId, judgment.variant, judgment.duplicateOf));
    if (!original || original === judgment || original.verdict === 'duplicate') {
      throw new Error('Duplicate must reference a directly adjudicated finding in this case/variant.');
    }
  }

  return {
    planId,
    basis: 'supplied-adjudication',
    statisticallyConclusive: false,
    variants: plan.variants.map(variant => {
      const result = {
        id: variant.id,
        cases: {
          all: cases.size, runnable: 0, incomplete: 0, infrastructureError: 0,
          invalidFixture: 0, unsupported: 0, unknown: 0,
        },
        truePositives: 0, falsePositives: 0, duplicates: 0, novel: 0,
        unadjudicated: 0, missedKnown: 0, unassessedKnown: 0,
      };
      let allKnown = 0;
      let runnableKnown = 0;
      let runnableFound = 0;
      const selected = plan.cases.map(item => byRun.get(key(item.id, variant.id)));
      for (const [index, item] of plan.cases.entries()) {
        const run = selected[index];
        const status = run?.status ?? 'unknown';
        const statusKey = {
          complete: 'runnable', incomplete: 'incomplete', 'infrastructure-error': 'infrastructureError',
          'invalid-fixture': 'invalidFixture', unsupported: 'unsupported', unknown: 'unknown',
        } as const;
        result.cases[statusKey[status]]++;
        allKnown += item.knownDefects.length;
        const found = new Set<string>();
        for (const finding of run?.findings ?? []) {
          const judgment = byFinding.get(key(item.id, variant.id, finding.id));
          if (!judgment) {
            result.unadjudicated++;
            continue;
          }
          switch (judgment.verdict) {
            case 'known':
              if (found.has(judgment.defectId)) {
                result.duplicates++;
              } else {
                found.add(judgment.defectId);
                result.truePositives++;
              }
              break;
            case 'false-positive': result.falsePositives++; break;
            case 'novel': result.novel++; break;
            case 'duplicate': result.duplicates++; break;
          }
        }
        if (status === 'complete') {
          runnableKnown += item.knownDefects.length;
          runnableFound += found.size;
          result.missedKnown += item.knownDefects.length - found.size;
        } else {
          result.unassessedKnown += item.knownDefects.length - found.size;
        }
      }
      return {
        ...result,
        precision: rate(result.truePositives, result.truePositives + result.falsePositives),
        recallAll: rate(result.truePositives, allKnown),
        recallRunnable: rate(runnableFound, runnableKnown),
        usage: Object.fromEntries(usageKeys.map(metric => [metric, total(selected, run => run.usage?.[metric])])),
        execution: Object.fromEntries(executionKeys.map(metric => [metric, total(selected, run => run.execution?.[metric])])),
      };
    }),
  };
}
