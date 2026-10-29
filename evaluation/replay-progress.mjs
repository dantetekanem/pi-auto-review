// Author-only case adjudication; repaired revisions and observed labels are never reviewer input.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareProgressCase } from './prepare-progress-case.mjs';
import { approveRestricted } from '../src/experiments-restricted-contract.ts';
import { runRestrictedNode } from '../src/experiments-node.ts';
import { readRestrictedAttempt } from '../src/experiments-comparison.ts';
import { canonicalSha256 } from '../src/experiments-oracle.ts';

if (!process.env.PI_AUTO_REVIEW_DOCKER_TEST_BACKEND || !process.argv[2] || !process.argv[3]) {
  throw new Error('Explicit backend, fresh artifact directory and teams checkout required.');
}
const prepared = await prepareProgressCase(process.argv[2], process.argv[3], [
  '20260d6a9479c9c8386d2ffe03493ababc12cbc7',
  '632e181de1b95e0f8564946dde98005ae981d801',
  '5366abb784e11fb9c1f2a9dc641fb1ff31d4c270',
  '9993db51c3a57f9a807dd0613789575fcc1b1445',
]);
const [original, base, head, repaired] = prepared.requests;
const work = [
  { name: 'original-candidate', request: original, expected: 'PASS' },
  { name: 'revised-base', request: base, expected: 'PASS' },
  { name: 'revised-head', request: head, expected: 'FAIL' },
  { name: 'fresh-head-replay', request: head, expected: 'FAIL' },
  { name: 'repaired', request: repaired, expected: 'PASS' },
];
const grant = approveRestricted(work.map(item => item.request), { approvedBy: 'user-authorized-m4-narrow-replay',
  familySha256: canonicalSha256(work), expiresAt: Date.now() + 300000, maxAttempts: 5, maxWallMs: 60000, maxOutputBytes: 524288 });
const attempts = [];
for (const item of work) {
  const saved = await runRestrictedNode(item.request, grant, join(prepared.root, 'attempts'), join(prepared.root, 'active.json'));
  const attempt = await readRestrictedAttempt({ path: saved.receipt.paths.receipt, sha256: saved.sha256 });
  attempts.push({ name: item.name, ...attempt });
  await writeFile(join(prepared.root, 'attempts.json'), JSON.stringify(attempts, null, 2));
  console.log(`${item.name}: ${attempt.status}/${attempt.predicate}; ${saved.receipt.detail}`);
  assert.equal(saved.receipt.cleanup, 'container-removed');
  assert.equal(attempt.predicate, item.expected, JSON.stringify(saved.receipt));
}
assert.notEqual(attempts[2].attemptId, attempts[3].attemptId);
assert.equal(attempts[2].requestDigest, attempts[3].requestDigest);
assert.deepEqual(attempts[2].normalized, attempts[3].normalized);
await writeFile(join(prepared.root, 'summary.json'), JSON.stringify({ caseId: prepared.caseId, status: 'replayed-revised-candidate',
  attempts, tui: prepared.tui, criterion: 'Unchanged final progress remains visible through matching persistence_closed cleanup refreshes.',
  adjudication: 'Original candidate passes. Later context-aware widget extraction introduces the observed refresh regression; use its immediate parent/head pair instead.',
  scope: 'Historical index status producer, renderer and widget with actual TUI width utilities; injected run/fence and fake timers, no live helper/terminal/session.',
  requirementTruthEstablished: false, formalProof: false }, null, 2));
console.log(`Saved ${join(prepared.root, 'summary.json')}`);
