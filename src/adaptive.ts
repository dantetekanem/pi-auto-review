import { canonicalSha256 } from './experiments-oracle.ts';

type SourceKind = 'scan' | 'collect' | 'search' | 'execution';
type Gap = 'frontier' | 'partial-coverage' | 'unresolved-calls' | 'static-dispatch' | 'edge-limit'
  | 'partial-search' | 'unsupported-input' | 'setup-error' | 'execution-unresolved' | 'interpretation-needed';
export type FactQuestion = {
  criterionId: string;
  scope: string;
  question: string;
  material: boolean;
  contextId: string;
};
export type FactSource = { kind: SourceKind; sha256: string; details: unknown };
type EdgeSource = {
  path: string;
  symbol: string;
  fingerprint: string;
  line: number;
  name: string;
  resolution: string;
};
export type MissingFact = FactQuestion & {
  id: string;
  status: 'unknown';
  gaps: Gap[];
  source: Omit<FactSource, 'details'>;
  edges: EdgeSource[];
};
export type RetrievalAction = { factId: string } & (
  { kind: 'collect'; target: string } | { kind: 'search'; query: string; path: string }
  | { kind: 'family'; familyId: string });
export type ActionBudget = { total: number; collect: number; search: number; family: number };
export type SelectionInput = {
  facts: MissingFact[];
  actions: RetrievalAction[];
  budget: ActionBudget;
  contextId: string;
  usedKeys: string[];
  availableFamilies: string[];
};
export type Selection = { budget: ActionBudget; usedKeys: string[]; unknownFactIds: string[] } & (
  { kind: 'action'; action: RetrievalAction; key: string }
  | { kind: 'stop-unknown'; reason: 'budget-exhausted' | 'no-useful-action' });

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function named(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4000;
}
function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function relativePath(value: unknown): value is string {
  return named(value) && !/[\\:\x00-\x1f]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function factId(question: FactQuestion): string {
  return canonicalSha256({ criterionId: question.criterionId, scope: question.scope, question: question.question });
}
function validateQuestion(question: FactQuestion): void {
  if (!named(question.criterionId) || !relativePath(question.scope) || !named(question.question)
    || typeof question.material !== 'boolean' || !isDigest(question.contextId)) {
    throw new Error('Invalid named missing fact.');
  }
}

// Consume documented pack.json / CLI details fields, never native tool display text or frontier strings.
export function normalizeMissingFact(question: FactQuestion, source: FactSource): MissingFact {
  validateQuestion(question);
  if (!isDigest(source.sha256) || !['scan', 'collect', 'search', 'execution'].includes(source.kind)) {
    throw new Error('Invalid fact source.');
  }
  const gaps = new Set<Gap>();
  const edges: EdgeSource[] = [];
  const data = source.details;
  if (!record(data)) gaps.add('unsupported-input');
  else if (source.kind === 'scan' || source.kind === 'collect') {
    const coverage = data.coverage;
    if (!record(coverage) || !count(coverage.unresolved) || !strings(coverage.frontier)
      || typeof coverage.truncatedBy !== 'string' || !['none', 'max_nodes', 'budget', 'rg_timeout'].includes(coverage.truncatedBy)
      || !Array.isArray(data.nodes) || !Array.isArray(data.edges)
      || (source.kind === 'scan' && !strings(data.skippedAnchors))) gaps.add('unsupported-input');
    else {
      if (coverage.frontier.length) gaps.add('frontier');
      if (coverage.truncatedBy !== 'none' || (Array.isArray(data.skippedAnchors) && data.skippedAnchors.length)) gaps.add('partial-coverage');
      if (coverage.unresolved > 0) gaps.add('unresolved-calls');
      const locations = new Map<string, { path: string; symbol: string; fingerprint: string }>();
      for (const node of data.nodes) {
        if (!record(node) || !named(node.id) || !relativePath(node.path) || !named(node.symbol)
          || typeof node.fingerprint !== 'string' || !/^[a-f0-9]{16}$/.test(node.fingerprint) || locations.has(node.id)) {
          gaps.add('unsupported-input');
          continue;
        }
        locations.set(node.id, { path: node.path, symbol: node.symbol, fingerprint: node.fingerprint });
      }
      for (const edge of data.edges) {
        if (!record(edge) || !named(edge.from) || !named(edge.name) || !count(edge.line) || edge.line === 0
          || typeof edge.resolution !== 'string' || !['exact', 'static_candidate', 'ambiguous', 'unresolved', 'external', 'local'].includes(edge.resolution)) {
          gaps.add('unsupported-input');
          continue;
        }
        const location = locations.get(edge.from);
        if (!location) {
          gaps.add('unsupported-input');
          continue;
        }
        if (edge.resolution === 'exact') continue;
        gaps.add(edge.resolution === 'unresolved' ? 'unresolved-calls' : 'static-dispatch');
        if (edges.length === 64) {
          gaps.add('edge-limit');
          continue;
        }
        edges.push({ ...location, line: edge.line, name: edge.name, resolution: edge.resolution });
      }
    }
  } else if (source.kind === 'search') {
    const coverage = data.coverage;
    if (!named(data.query) || !count(data.totalMatches) || !record(coverage)
      || typeof coverage.status !== 'string' || !['complete', 'partial', 'failed'].includes(coverage.status)
      || !strings(coverage.unvisitedRoots) || !strings(coverage.reasons)
      || ![coverage.omittedMatches, coverage.truncatedMatches, coverage.omittedRelatedCandidates, coverage.omittedPackageRoots].every(count)) {
      gaps.add('unsupported-input');
    } else if (coverage.status !== 'complete' || coverage.unvisitedRoots.length || coverage.reasons.length
      || coverage.omittedMatches || coverage.truncatedMatches || coverage.omittedRelatedCandidates || coverage.omittedPackageRoots) gaps.add('partial-search');
  } else if (data.status === 'setup_error') gaps.add('setup-error');
  else if (data.status !== 'completed' && data.status !== 'target_failure') gaps.add('execution-unresolved');
  if (!gaps.size) gaps.add('interpretation-needed');
  return {
    ...question,
    id: factId(question),
    status: 'unknown',
    gaps: [...gaps],
    source: { kind: source.kind, sha256: source.sha256 },
    edges,
  };
}

function actionKey(action: RetrievalAction, contextId: string): string {
  const { factId: _factId, ...request } = action;
  return canonicalSha256({ contextId, request });
}
function validateAction(action: RetrievalAction): void {
  if (!isDigest(action.factId)) throw new Error('Invalid action fact.');
  const fields = action.kind === 'collect' ? ['target'] : action.kind === 'search' ? ['query', 'path'] : ['familyId'];
  if (Object.keys(action).some(key => !['factId', 'kind', ...fields].includes(key))) throw new Error('Unsupported action field.');
  if (action.kind === 'collect') {
    if (!named(action.target)) throw new Error('Invalid collection target.');
    const target = /^(.*):([1-9]\d*)$/.exec(action.target);
    if (!target || !relativePath(target[1]) || !Number.isSafeInteger(Number(target[2]))) throw new Error('Invalid collection target.');
  } else if (action.kind === 'search') {
    if (!named(action.query) || !relativePath(action.path)) throw new Error('Search needs a named query and explicit scope.');
  } else if (action.kind !== 'family' || !named(action.familyId)) throw new Error('Invalid prepared family action.');
}

// A selection spends a recommendation budget, not execution authority or the runner's cumulative budget.
export function selectNextAction(input: SelectionInput): Selection {
  if (!isDigest(input.contextId) || input.facts.length > 128 || input.actions.length > 64
    || input.usedKeys.length > 128 || !input.usedKeys.every(isDigest) || !input.availableFamilies.every(named)) {
    throw new Error('Invalid selection scope.');
  }
  for (const kind of ['total', 'collect', 'search', 'family'] as const) {
    if (!count(input.budget[kind]) || input.budget[kind] > 128) throw new Error('Invalid action budget.');
  }
  const facts = new Map<string, MissingFact>();
  for (const fact of input.facts) {
    validateQuestion(fact);
    if (fact.id !== factId(fact) || fact.status !== 'unknown') throw new Error('Invalid fact identity.');
    const prior = facts.get(fact.id);
    if (prior && canonicalSha256(prior) !== canonicalSha256(fact)) throw new Error('Conflicting fact identity.');
    facts.set(fact.id, fact);
  }
  for (const action of input.actions) {
    validateAction(action);
    if (!facts.has(action.factId)) throw new Error('Action references a missing fact.');
  }
  const result = {
    budget: { ...input.budget },
    usedKeys: [...input.usedKeys],
    unknownFactIds: [...facts.keys()].sort(),
  };
  if (!input.budget.total || input.usedKeys.length === 128) {
    return { ...result, kind: 'stop-unknown', reason: 'budget-exhausted' };
  }
  const priority = { collect: 0, search: 1, family: 2 };
  const candidates = input.actions.filter(action => {
    const fact = facts.get(action.factId);
    return fact?.material && fact.contextId === input.contextId && input.budget[action.kind] > 0
      && !input.usedKeys.includes(actionKey(action, input.contextId))
      && (action.kind !== 'family' || (input.availableFamilies.includes(action.familyId)
        && !fact.gaps.some(gap => ['setup-error', 'execution-unresolved', 'unsupported-input'].includes(gap))));
  }).map(action => ({ action, key: actionKey(action, input.contextId) })).sort((left, right) => {
    const rank = priority[left.action.kind] - priority[right.action.kind];
    const leftIdentity = `${left.key}:${left.action.factId}`;
    const rightIdentity = `${right.key}:${right.action.factId}`;
    return rank || (leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0);
  });
  const next = candidates[0];
  if (!next) return { ...result, kind: 'stop-unknown', reason: 'no-useful-action' };
  result.budget.total--;
  result.budget[next.action.kind]--;
  result.usedKeys.push(next.key);
  return { ...result, kind: 'action', action: { ...next.action }, key: next.key };
}
