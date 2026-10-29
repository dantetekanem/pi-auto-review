// Author-only replay. Never include this script, repair IDs or results in reviewer input.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareReviewCase } from './prepare-review-case.mjs';
import { approveRestricted } from '../src/experiments-restricted-contract.ts';
import { runRestrictedNode } from '../src/experiments-node.ts';
import { readRestrictedAttempt } from '../src/experiments-comparison.ts';
import { canonicalSha256 } from '../src/experiments-oracle.ts';

if (!process.env.PI_AUTO_REVIEW_DOCKER_TEST_BACKEND || !process.argv[2]) throw new Error('Explicit backend and fresh artifact directory required.');
const head = 'd6b892a2e84b7895d4047ecfa392691d263b12d0';
const repaired = 'c3bca5ff8623dedb11d956cc8f2199f2aac7b766';
const base = '1a5c8759004bbec52d5cde6e7556e65212053b70';
const prepared = await prepareReviewCase(process.argv[2], {
  caseId: 'review-restoration-v1', revisions: [head, repaired, base], probe: 'evaluation/fixtures/restoration.mjs',
});
const [headRequest, repairedRequest, baseRequest] = prepared.requests;
const work = [
  { name: 'head', request: headRequest, expected: 'FAIL' },
  { name: 'fresh-head-replay', request: headRequest, expected: 'FAIL' },
  { name: 'repaired', request: repairedRequest, expected: 'PASS' },
  { name: 'base-applicability', request: baseRequest, expected: 'UNRESOLVED' },
  { name: 'missing-dependencies', request: prepared.setupRequest, expected: 'UNRESOLVED' },
];
const grant = approveRestricted(work.map(item => item.request), {
  approvedBy: 'user-authorized-m4-narrow-replay', familySha256: canonicalSha256(work),
  expiresAt: Date.now() + 300000, maxAttempts: 5, maxWallMs: 60000, maxOutputBytes: 524288,
});
const attempts = [];
for (const item of work) {
  const result = await runRestrictedNode(item.request, grant, join(prepared.root, 'attempts'), join(prepared.root, 'active.json'));
  const attempt = await readRestrictedAttempt({ path: result.receipt.paths.receipt, sha256: result.sha256 });
  attempts.push({ name: item.name, ...attempt });
  await writeFile(join(prepared.root, 'attempts.json'), JSON.stringify(attempts, null, 2));
  console.log(`${item.name}: ${attempt.status}/${attempt.predicate}; ${result.receipt.detail}`);
  assert.equal(attempt.predicate, item.expected, JSON.stringify(result.receipt));
  assert.equal(result.receipt.cleanup, 'container-removed');
  if (item.name === 'missing-dependencies') assert.equal(attempt.status, 'setup_error');
}
assert.notEqual(attempts[0].attemptId, attempts[1].attemptId);
assert.equal(attempts[0].requestDigest, attempts[1].requestDigest);
assert.deepEqual(attempts[0].normalized, attempts[1].normalized);
assert.equal(attempts[0].normalized.notices, 1);
assert.equal(attempts[2].normalized.notices, 0);
const summary = { caseId: prepared.caseId, status: 'replayed', sdk: prepared.sdk, attempts,
  criterion: 'One previously delivered completion must not be delivered again when a completed review is restored.',
  origin: 'Source-supported introduction; base lacks restoration and cannot establish an execution-comparison origin.',
  scope: 'Actual historical registerReview and SDK SessionManager entries; inert delivery/registration, no live Pi session/provider/pane.',
  requirementTruthEstablished: false, formalProof: false };
await writeFile(join(prepared.root, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`Saved ${join(prepared.root, 'summary.json')}`);
