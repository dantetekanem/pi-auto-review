import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseNodeObservation } from '../src/experiments-node.ts';
import { describeRestricted } from '../src/experiments-restricted-contract.ts';
import { startRestrictedRecord, finishRestrictedRecord } from '../src/experiments-receipts.ts';
import { readRestrictedAttempt, compareAttempts } from '../src/experiments-comparison.ts';
import { freezeOracle } from '../src/experiments-oracle.ts';
import { syntheticAttempt } from './experiments-helpers.mjs';
import { digestBytes } from '../src/experiments-contract.ts';

const cases = [
  { id: 'review-restoration-v1', signature: 'completed reviews must hand back once', input: {},
    pass: { restored: true, priorCompletions: 1, notices: 0 }, fail: { restored: true, priorCompletions: 1, notices: 1 } },
  { id: 'review-dispatch-v1', signature: 'review dispatch must use configured teams', input: {},
    pass: { registeredTools: ['agentic_code_review', 'agentic_code_review_complete'], launchTools: ['spawn_swarm_agents'] },
    fail: { registeredTools: ['agentic_code_review', 'agentic_code_review_complete', 'agentic_code_review_wave'], launchTools: ['agentic_code_review_wave'] } },
  { id: 'team-progress-v1', signature: 'final progress must remain visible during cleanup', input: { progress: 'Sending exact report' },
    pass: { frames: Array(4).fill('reporter · Sending exact report · Finishing cleanup') },
    fail: { frames: ['Sending exact report', 'Send', 'Sending exact report', ''] } },
  { id: 'review-thinking-v1', signature: 'review must preserve supported caller thinking', input: { thinking: 'xhigh', supported: true },
    pass: { selected: 'xhigh', launched: 'xhigh', blocked: false }, fail: { selected: 'medium', launched: 'medium', blocked: false } },
];

function execution(c, failed = false, normalized = failed ? c.fail : c.pass) {
  const records = [
    { type: 'test:diagnostic', message: `AR_OBSERVATION ${JSON.stringify(normalized)}` },
    failed ? { type: 'test:fail', name: 'case-contract', code: 'ERR_ASSERTION', message: c.signature }
      : { type: 'test:pass', name: 'case-contract' },
  ];
  return { status: 'completed', exitCode: Number(failed), stdout: Buffer.from(records.map(record => JSON.stringify(record)).join('\n')), stderr: Buffer.alloc(0) };
}
const parse = (c, result) => parseNodeObservation(result, 'case-contract', JSON.stringify(c.input), c.id);
const hash = 'a'.repeat(64);
const request = c => ({
  runId: 'case-run', profile: 'docker-node-v1', caseId: c.id,
  backend: { socketPath: '/tmp/docker.sock', engineId: 'engine', imageId: `sha256:${hash}`, platform: 'linux/arm64', seccompPath: '/tmp/seccomp.json', seccompSha256: hash },
  source: { repository: '/repo', revision: 'b'.repeat(40), paths: ['src/index.ts'] },
  dependencies: { path: '/tmp/deps.json', sha256: hash }, probe: { path: '/tmp/probe.mjs', sha256: hash },
  adapterSha256: hash, targetId: 'case-contract', input: JSON.stringify(c.input), limits: { timeoutMs: 1000, maxOutputBytes: 8192 },
});

for (const c of cases) test(`${c.id} distinguishes its named observation from a different assertion`, () => {
  assert.equal(parse(c, execution(c)).observation, 'passed');
  assert.equal(parse(c, execution(c, true)).observation, 'target_failure');
  assert.equal(parse(c, execution(c, false, c.fail)).observation, 'probe_error');
  assert.equal(parse(c, execution({ ...c, signature: 'optional findings must be nonblocking' }, true)).observation, 'probe_error');
  assert.equal(parse(c, { ...execution(c), status: 'timeout' }).observation, null);
  assert.equal(parse(c, execution(c, false, { ...c.pass, extra: 'unmodeled' })).observation, 'probe_error');
});

test('historical case identity and input are part of the restricted request, not an assertion override', () => {
  const prepared = cases.map(c => describeRestricted(request(c)));
  assert.equal(new Set(prepared.map(item => item.digest)).size, 4);
  for (const c of cases) {
    for (const id of ['unknown', 'constructor', null]) assert.throws(() => describeRestricted({ ...request(c), caseId: id }), /case/i);
    assert.throws(() => describeRestricted({ ...request(c), targetSignature: 'caller assertion' }), /field/i);
    assert.throws(() => describeRestricted({ ...request(c), input: '{"unexpected":true}' }), /input/i);
  }
});

test('missing applicability or incomplete frame observations cannot be a passing case', () => {
  const restoration = cases[0], progress = cases[2], thinking = cases[3];
  assert.equal(parse(restoration, execution(restoration, false, { ...restoration.pass, restored: false })).observation, 'probe_error');
  assert.equal(parse(progress, execution(progress, false, { frames: ['Sending exact report'] })).observation, 'probe_error');
  const unsupported = { ...thinking, input: { thinking: 'xhigh', supported: false }, pass: { selected: null, launched: null, blocked: true } };
  assert.equal(parse(unsupported, execution(unsupported)).observation, 'passed');
  assert.equal(parse(unsupported, execution(unsupported, true, thinking.fail)).observation, 'target_failure');
});

test('thinking levels are scalar values, not coercible arrays', () => {
  const c = cases[3];
  assert.throws(() => describeRestricted({ ...request(c), input: JSON.stringify({ thinking: ['high'], supported: true }) }), /input/i);
  assert.equal(parse(c, execution(c, true, { selected: ['xhigh'], launched: 'xhigh', blocked: false })).observation, 'probe_error');
});

test('case comparisons require one frozen predicate and compatible outcomes', () => {
  const c = cases[0], baseRequest = request(c), headRequest = structuredClone(baseRequest);
  headRequest.source.revision = 'c'.repeat(40);
  const binding = freezeOracle({
    requirement: { id: 'synthetic-restoration', statement: c.signature,
      authority: { kind: 'repository-contract', ref: 'synthetic-unit-contract', sha256: hash },
      entryId: 'registerReview', revisions: [baseRequest.source.revision, headRequest.source.revision], inputClasses: ['restoration'], exceptions: [] },
    oracle: { targetCheckId: 'case-contract', targetSignature: c.signature, normalizerVersion: `node-${c.id}`, normalizerSha256: hash },
  });
  const base = syntheticAttempt({ request: baseRequest });
  const head = syntheticAttempt({ request: headRequest, predicate: 'FAIL' });
  assert.equal(compareAttempts(binding, base, head, 'restoration').status, 'introduced-violation');
  assert.equal(compareAttempts(binding, { ...base, predicate: 'UNRESOLVED' }, head, 'restoration').status, 'unknown');
  const wrong = { ...head, request: { ...headRequest, caseId: 'review-dispatch-v1' } };
  assert.equal(compareAttempts(binding, base, wrong, 'restoration').status, 'incompatible');
});

test('restricted receipt revalidation uses the bound case normalizer and rejects changed observation bytes', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'autoreview-case-receipt-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = cases[0], prepared = describeRestricted(request(c));
  // Synthetic supervisor record: this tests revalidation, not actual container isolation.
  const record = await startRestrictedRecord(root, join(root, 'guard'), prepared.request);
  const result = execution(c, true);
  const saved = await finishRestrictedRecord(record, {
    ...result, detail: '', containerId: 'synthetic', cleanup: 'container-removed', durationMs: 1,
    outputTruncated: false, profileVerified: true,
  }, {
    observation: 'target_failure', normalized: c.fail, requestDigest: prepared.digest,
    adapterSha256: hash, probeSha256: hash, inputSha256: digestBytes(prepared.request.input),
    targetId: 'case-contract', targetSignature: c.signature, normalizerVersion: `node-${c.id}`,
  });
  const reference = { path: record.paths.receipt, sha256: saved.sha256 };
  assert.equal((await readRestrictedAttempt(reference)).predicate, 'FAIL');
  const receipt = JSON.parse(await readFile(record.paths.receipt, 'utf8'));
  const wrong = JSON.stringify({ ...receipt, normalizerVersion: 'node-findings-v1' });
  await writeFile(record.paths.receipt, wrong);
  await assert.rejects(readRestrictedAttempt({ ...reference, sha256: digestBytes(wrong) }), /identity/);
  await writeFile(record.paths.receipt, JSON.stringify(receipt));
  const restored = { ...reference, sha256: digestBytes(JSON.stringify(receipt)) };
  await writeFile(record.paths.stdout, execution(c).stdout);
  await assert.rejects(readRestrictedAttempt(restored), /digest/);
});
