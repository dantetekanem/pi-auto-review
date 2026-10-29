import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessEvidenceGraph, validateEvidenceGraph } from '../src/evidence-graph.ts';

const runId = 'run-one';
const leaf = id => ({ id, kind: 'evidence', identities: [] });
const support = (id, ...dependsOn) => ({ id, kind: 'support', dependsOn });
const claim = (id, ...supports) => ({ id, kind: 'claim', supports });
function fixture(nodes = [leaf('read'), support('support', 'read'), claim('claim', 'support')]) {
  return {
    graph: { schemaVersion: 1, runId, nodes, incompatibilities: [] },
    records: nodes.map(({ id }) => ({ id, runId, kind: 'evidence', repository: 'repo', revision: 'head', state: 'observed', sources: [] })),
  };
}
const validate = ({ graph, records }) => validateEvidenceGraph(graph, records, runId);
const identity = (kind = 'source', key = 'component', sha256 = 'a'.repeat(64)) => ({ kind, key, sha256 });
const assess = ({ graph, records }, identities = [], scopes = []) => assessEvidenceGraph(graph, records, runId, { identities, scopes });
const status = (result, id) => result.nodes.find(node => node.id === id).status;

test('each captured identity kind invalidates transitive support only in its scope', () => {
  for (const kind of ['source', 'config', 'fixture', 'environment', 'probe', 'criterion']) {
    const input = fixture([
      { ...leaf('read'), identities: [identity(kind)] },
      support('support', 'read'),
      claim('inner', 'support'),
      support('outer-support', 'inner'),
      claim('outer', 'outer-support'),
    ]);
    assert.equal(status(assess(input, [identity(kind)]), 'outer'), 'fresh');
    const drift = assess(input, [identity(kind, 'component', 'b'.repeat(64))]);
    assert.equal(status(drift, 'outer'), 'stale');
    assert.match(drift.nodes.find(node => node.id === 'read').reasons.join(' '), /identity-drift/);
    assert.equal(status(assess(input, [identity(kind, 'different-component')]), 'outer'), 'unknown');
  }
});

test('an independent OR alternative survives a stale AND dependency', () => {
  const input = fixture([
    { ...leaf('changed'), identities: [identity()] },
    { ...leaf('independent'), identities: [identity('probe', 'other')] },
    support('first', 'changed', 'independent'),
    support('second', 'independent'),
    claim('claim', 'first', 'second'),
  ]);
  const result = assess(input, [identity('source', 'component', 'b'.repeat(64)), identity('probe', 'other')]);
  assert.equal(status(result, 'first'), 'stale');
  assert.equal(status(result, 'second'), 'fresh');
  assert.equal(status(result, 'claim'), 'fresh');
  assert.deepEqual(result.nodes.find(node => node.id === 'claim').validSupports, ['second']);
});

test('missing identity or withdrawn records remain unknown, not false', () => {
  const input = fixture();
  assert.equal(status(assess(input), 'claim'), 'unknown');
  input.graph.nodes[0].identities = [identity('source', 'component', null)];
  assert.equal(status(assess(input, [identity()]), 'claim'), 'unknown');
  input.graph.nodes[0].identities = [identity()];
  input.records[0].state = 'superseded';
  const result = assess(input, [identity()]);
  assert.equal(status(result, 'claim'), 'unknown');
  assert.match(result.nodes.find(node => node.id === 'read').reasons.join(' '), /superseded/);
});

test('scoped incompatibility disables only the named support without inferring falsity', () => {
  const input = fixture([
    { ...leaf('read'), identities: [identity()] },
    support('first', 'read'),
    support('second', 'read'),
    claim('claim', 'first', 'second'),
  ]);
  input.graph.incompatibilities = [{ supportId: 'first', scope: 'production', reason: 'Test-only assumption', sourceId: 'read' }];
  const result = assess(input, [identity()], ['production']);
  assert.equal(status(result, 'first'), 'unknown');
  assert.equal(status(result, 'claim'), 'fresh');
  assert.equal(status(assess(input, [identity()], ['test']), 'first'), 'fresh');
  assert.equal(status(assess(input, [identity()]), 'first'), 'unknown');
});

test('optional graph leaves legacy source-only artifacts unchanged', () => {
  assert.equal(validateEvidenceGraph(undefined, [], runId), undefined);
});

test('typed supports retain AND dependencies and separate OR alternatives over map IDs', () => {
  const input = fixture([leaf('source'), { ...leaf('assumption'), kind: 'assumption' },
    support('first', 'source', 'assumption'), support('second', 'source'), claim('conclusion', 'first', 'second')]);
  const result = validate(input);
  assert.deepEqual(result, input.graph);
  input.graph.nodes[2].dependsOn.push('later');
  assert.deepEqual(result.nodes[2].dependsOn, ['source', 'assumption']);
});

test('identical repeated records are idempotent, conflicting ID reuse is rejected', () => {
  const input = fixture();
  input.records.push(structuredClone(input.records[0]));
  input.graph.nodes.push(structuredClone(input.graph.nodes[0]));
  assert.equal(validate(input).nodes.length, 3);
  input.records[3].state = 'refuted';
  assert.throws(() => validate(input), /conflicting.*read/i);
  const other = fixture();
  other.graph.nodes.push({ ...leaf('read'), kind: 'assumption' });
  assert.throws(() => validate(other), /conflicting.*read/i);
});

test('missing map records, dangling references and cross-run records fail closed', () => {
  const missing = fixture();
  missing.records.pop();
  assert.throws(() => validate(missing), /map record.*claim/i);
  const dangling = fixture();
  dangling.graph.nodes[1].dependsOn = ['missing'];
  assert.throws(() => validate(dangling), /dangling.*missing/i);
  const crossRun = fixture();
  crossRun.records[0].runId = 'another-run';
  assert.throws(() => validate(crossRun), /cross-run/i);
  crossRun.graph.runId = 'another-run';
  assert.throws(() => validate(crossRun), /run identity/i);
});

test('cycles and references of the wrong type are rejected', () => {
  assert.throws(() => validate(fixture([claim('claim', 'support'), support('support', 'claim')])), /cycle/i);
  assert.throws(() => validate(fixture([leaf('read'), claim('claim', 'read')])), /claim.*support/i);
  assert.throws(() => validate(fixture([leaf('read'), support('one', 'read'), support('two', 'one')])), /support.*dependency/i);
});

test('empty support, excess alternatives and unknown schema fields are not evidence', () => {
  assert.throws(() => validate(fixture([support('empty')])), /dependencies/i);
  const input = fixture([leaf('read'), ...Array.from({ length: 5 }, (_, i) => support(`s${i}`, 'read')),
    claim('claim', 's0', 's1', 's2', 's3', 's4')]);
  assert.throws(() => validate(input), /four alternatives/i);
  const typo = fixture();
  typo.graph.nodes[2].support = ['support'];
  assert.throws(() => validate(typo), /fields/i);
});

test('identity bindings are typed, scoped and non-conflicting', () => {
  const input = fixture();
  input.graph.nodes[0].identities = [{ kind: 'source', key: 'component', sha256: 'a'.repeat(64) }];
  assert.deepEqual(validate(input).nodes[0].identities, input.graph.nodes[0].identities);
  input.graph.nodes[0].identities.push({ kind: 'source', key: 'component', sha256: 'b'.repeat(64) });
  assert.throws(() => validate(input), /conflicting identity/i);
  input.graph.nodes[0].identities = [{ kind: 'confidence', key: 'component', sha256: 'a'.repeat(64) }];
  assert.throws(() => validate(input), /identity kind/i);
});

test('explicit incompatibility targets a support and a recorded scope with a reason', () => {
  const input = fixture();
  input.graph.incompatibilities = [{ supportId: 'support', scope: 'production', reason: 'Fixture assumes test-only behavior', sourceId: 'read' }];
  assert.deepEqual(validate(input).incompatibilities, input.graph.incompatibilities);
  input.graph.incompatibilities[0].supportId = 'read';
  assert.throws(() => validate(input), /incompatibility.*support/i);
});
