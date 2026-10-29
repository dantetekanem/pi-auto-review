import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digestBytes } from '../src/experiments-contract.ts';
import { approveTrustedReplay, describeReplay, runTrustedReplay } from '../src/experiments-replay.ts';
import { readMachineEvidence } from '../src/evidence-receipts.ts';

const runId = 'run-one';
const assessment = (status = 'fresh') => ({ nodes: [{ id: 'claim', kind: 'claim', status, reasons: status === 'fresh' ? [] : ['source-drift'] }] });
async function fixture(t, fails = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'evidence-receipts-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'probe.mjs');
  writeFileSync(script, `console.log('RUNTIME fixture\\n${fails ? 'FAIL value expected 1 got 2' : 'PASS value ok'}\\nRESULT 1 cases, ${fails ? 1 : 0} failures'); process.exitCode = ${fails ? 1 : 0};`);
  const request = {
    runId,
    profile: 'trusted-program',
    revision: 'b'.repeat(40),
    executable: process.execPath,
    script: 'probe.mjs',
    args: [],
    cwd: root,
    environment: {},
    files: [
      { path: script, sha256: digestBytes(readFileSync(script)), copyAs: 'probe.mjs' },
      { path: process.execPath, sha256: digestBytes(readFileSync(process.execPath)) },
    ],
    headers: ['RUNTIME fixture'],
    cases: [{ id: 'value', failure: { prefix: 'expected', contains: 'got 2' } }],
    limits: { timeoutMs: 2000, maxOutputBytes: 4096 },
  };
  const grant = approveTrustedReplay(request, { approvedBy: 'focused synthetic test', maxAttempts: 2 });
  const receipts = [];
  for (let i = 0; i < 2; i++) {
    receipts.push(await runTrustedReplay(request, grant, root));
  }
  const references = receipts.map(receipt => ({ checkId: 'check', path: receipt.paths.receipt, sha256: digestBytes(readFileSync(receipt.paths.receipt)) }));
  const claim = { claimId: 'claim', kind: 'target-replay', requestDigest: describeReplay(request).digest, receipts: references.map(ref => ref.sha256) };
  const verify = (claims = [claim], freshness = assessment()) => readMachineEvidence(claims, references, runId, freshness);
  return { receipts, references, claim, verify };
}

test('exact failing target replay rechecks real trusted-runner bytes without upgrading them to requirement truth', async t => {
  const f = await fixture(t);
  const [result] = await f.verify();
  assert.equal(result.status, 'target-replayed');
  assert.equal(new Set(result.attemptIds).size, 2);
  assert.equal(result.requirementTruthEstablished, false);
  assert.equal(result.formalProof, false);
  assert.deepEqual(result.profiles, ['trusted-program', 'trusted-program']);
  const [single] = await f.verify([{ ...f.claim, kind: 'execution', receipts: [f.references[0].sha256] }]);
  assert.equal(single.status, 'observed-target-failure');
});

test('passing replay and stale support remain explicit unknowns', async t => {
  const pass = await fixture(t, false);
  assert.equal((await pass.verify())[0].status, 'unknown');
  const [stale] = await pass.verify(undefined, assessment('stale'));
  assert.equal(stale.status, 'unknown');
  assert.match(stale.reason, /stale/);
});

test('unindexed, wrong-request, wrong-claim and repeated-attempt claims are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(f.verify([{ ...f.claim, receipts: ['c'.repeat(64), f.references[1].sha256] }]), /indexed/i);
  await assert.rejects(f.verify([{ ...f.claim, requestDigest: 'd'.repeat(64) }]), /request/i);
  await assert.rejects(f.verify([{ ...f.claim, claimId: 'missing' }]), /claim/i);
  await assert.rejects(f.verify([{ ...f.claim, receipts: [f.references[0].sha256, f.references[0].sha256] }]), /distinct/i);
  await assert.rejects(f.verify([{ ...f.claim, confirmed: true }]), /fields/i);
});

test('corrupted output cannot be blessed by an intact receipt index', async t => {
  const f = await fixture(t);
  writeFileSync(f.receipts[0].paths.stdout, 'PASS value fabricated');
  await assert.rejects(f.verify(), /identity|digest/i);
});

test('source-only completion needs neither a graph nor machine evidence', async () => {
  assert.equal(await readMachineEvidence(undefined, [], runId, undefined), undefined);
});
