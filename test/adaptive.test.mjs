import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMissingFact, selectNextAction } from '../src/adaptive.ts';

const hash = 'a'.repeat(64);
const question = { criterionId: 'criterion-1', scope: 'src/handler.ts',
  question: 'Which implementation handles a restored completion?', material: true, contextId: hash };
const node = { id: 'N1', path: 'src/handler.ts', symbol: 'restore', startLine: 10, fingerprint: 'b'.repeat(16) };
const pack = () => ({ nodes: [node], edges: [], skippedAnchors: [],
  coverage: { unresolved: 0, frontier: [], truncatedBy: 'none' } });
const scan = (details = pack()) => ({ kind: 'scan', sha256: hash, details });
const fact = () => normalizeMissingFact(question, scan());
const budget = () => ({ total: 3, collect: 1, search: 1, family: 1 });
const collect = (factId = fact().id) => ({ factId, kind: 'collect', target: 'src/handler.ts:10' });
const search = (factId = fact().id) => ({ factId, kind: 'search', query: 'restore', path: 'src/handler.ts' });
const select = (facts, actions, options = {}) => selectNextAction({ facts, actions, budget: budget(),
  contextId: hash, usedKeys: [], availableFamilies: [], ...options });

test('zero unresolved edges cannot erase a frontier or max-node truncation', () => {
  const details = pack();
  details.coverage.frontier = ['N1 → dependency (max_nodes)'];
  details.coverage.truncatedBy = 'max_nodes';
  const result = normalizeMissingFact(question, scan(details));
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.gaps, ['frontier', 'partial-coverage']);
  assert.equal(result.question, question.question);
  assert.deepEqual(result.source, { kind: 'scan', sha256: hash });
});

test('edge references use stable locations; node renumbering does not change a fact identity', () => {
  const details = pack();
  details.edges = [{ from: 'N1', name: 'deliver', line: 12, resolution: 'ambiguous' }];
  const first = normalizeMissingFact(question, scan(details));
  details.nodes[0] = { ...node, id: 'N88' };
  details.edges[0].from = 'N88';
  const second = normalizeMissingFact(question, { ...scan(details), sha256: 'c'.repeat(64) });
  assert.equal(first.id, second.id);
  assert.deepEqual(first.edges, [{ path: node.path, symbol: node.symbol, fingerprint: node.fingerprint,
    line: 12, name: 'deliver', resolution: 'ambiguous' }]);
  assert.deepEqual(second.edges, first.edges);
  assert.deepEqual(first.gaps, ['static-dispatch']);
});

test('partial search, omitted matches and unsupported display text remain unknown', () => {
  const details = { query: 'restore', totalMatches: 0, coverage: { status: 'partial', unvisitedRoots: ['src'],
    reasons: ['budget'], omittedMatches: 0, truncatedMatches: 0, omittedRelatedCandidates: 0, omittedPackageRoots: 0 } };
  assert.deepEqual(normalizeMissingFact(question, { kind: 'search', sha256: hash, details }).gaps, ['partial-search']);
  details.coverage = { ...details.coverage, status: 'complete', unvisitedRoots: [], reasons: [], omittedMatches: 2 };
  assert.deepEqual(normalizeMissingFact(question, { kind: 'search', sha256: hash, details }).gaps, ['partial-search']);
  assert.deepEqual(normalizeMissingFact(question, scan('No unresolved edges found')).gaps, ['unsupported-input']);
  assert.deepEqual(normalizeMissingFact(question, scan({ ...pack(), coverage: {} })).gaps, ['unsupported-input']);
});

test('setup failures and passing observations never establish a criterion or code defect', () => {
  const observe = status => normalizeMissingFact(question, { kind: 'execution', sha256: hash, details: { status } });
  assert.deepEqual(observe('setup_error').gaps, ['setup-error']);
  assert.deepEqual(observe('completed').gaps, ['interpretation-needed']);
  assert.deepEqual(observe('timeout').gaps, ['execution-unresolved']);
  assert.equal(observe('completed').status, 'unknown');
  assert.deepEqual(fact().gaps, ['interpretation-needed']);
});

test('structured enums cannot be supplied as coercible arrays', () => {
  const details = pack();
  details.coverage.truncatedBy = ['none'];
  assert.ok(normalizeMissingFact(question, scan(details)).gaps.includes('unsupported-input'));
  details.coverage.truncatedBy = 'none';
  details.edges = [{ from: 'N1', name: 'deliver', line: 12, resolution: ['exact'] }];
  assert.ok(normalizeMissingFact(question, scan(details)).gaps.includes('unsupported-input'));
});

test('selection is deterministic, charges one action and does not mutate inputs', () => {
  const facts = [fact()];
  const actions = [search(), collect()];
  const before = structuredClone({ facts, actions });
  const decision = select(facts, actions);
  assert.deepEqual(decision.action, collect());
  assert.deepEqual(decision.budget, { total: 2, collect: 0, search: 1, family: 1 });
  assert.deepEqual(decision.unknownFactIds, [fact().id]);
  assert.equal(decision.usedKeys.length, 1);
  assert.deepEqual(select(facts, [...actions].reverse()), decision);
  assert.deepEqual({ facts, actions }, before);
  assert.equal(select(facts, [collect()], { usedKeys: decision.usedKeys }).reason, 'no-useful-action');
});

test('only material current facts and named available families are eligible', () => {
  const current = fact();
  const family = { factId: current.id, kind: 'family', familyId: 'prepared-family' };
  assert.equal(select([current], [family]).kind, 'stop-unknown');
  assert.deepEqual(select([current], [family], { availableFamilies: ['prepared-family'] }).action, family);
  assert.equal(select([{ ...current, material: false }], [collect()]).kind, 'stop-unknown');
  assert.equal(select([current], [collect()], { contextId: 'd'.repeat(64) }).kind, 'stop-unknown');
  assert.equal(select([current], [collect()], { budget: { ...budget(), total: 0 } }).reason, 'budget-exhausted');
  assert.equal(select([current], [collect()], { budget: { ...budget(), collect: 0 } }).kind, 'stop-unknown');
});

test('a setup failure cannot trigger another experiment family automatically', () => {
  const failed = normalizeMissingFact(question, { kind: 'execution', sha256: hash, details: { status: 'setup_error' } });
  const family = { factId: failed.id, kind: 'family', familyId: 'prepared-family' };
  assert.equal(select([failed], [family], { availableFamilies: ['prepared-family'] }).kind, 'stop-unknown');
  assert.equal(select([failed], [search(failed.id)]).kind, 'action');
});

test('different questions cannot reserve the same retrieval twice', () => {
  const other = normalizeMissingFact({ ...question, criterionId: 'criterion-2', question: 'Who calls restoration?' }, scan());
  const first = select([fact(), other], [collect()]);
  const next = select([fact(), other], [collect(other.id)], { usedKeys: first.usedKeys });
  assert.equal(next.kind, 'stop-unknown');
});

test('invalid questions, budgets and unscoped actions are rejected before selection', () => {
  assert.throws(() => normalizeMissingFact({ ...question, question: '' }, scan()));
  assert.throws(() => normalizeMissingFact(question, { ...scan(), sha256: 'not-a-hash' }));
  for (const invalid of [-1, Infinity, 1.5, 1000]) {
    assert.throws(() => select([fact()], [collect()], { budget: { ...budget(), total: invalid } }));
  }
  assert.throws(() => select([fact()], [{ ...search(), path: '' }]));
  assert.throws(() => select([fact()], [{ ...search(), path: '../other-repo' }]));
  assert.throws(() => select([fact()], [{ ...collect(), target: 'src/handler.ts:0' }]));
  assert.throws(() => select([fact()], [{ ...collect(), target: ['src/handler.ts:10'] }]));
  assert.throws(() => select([fact()], [{ ...collect(), nonce: 'bypass-deduplication' }]));
  assert.throws(() => select([fact()], [collect('missing-fact')]));
  assert.throws(() => select([fact(), { ...fact(), question: 'conflicting identity' }], [collect()]));
});
