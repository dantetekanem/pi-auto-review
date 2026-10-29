// Author-only intentional-change evidence, not a whole-commit bug-free label.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareReviewCase } from './prepare-review-case.mjs';
import { approveRestricted } from '../src/experiments-restricted-contract.ts';
import { runRestrictedNode } from '../src/experiments-node.ts';
import { readRestrictedAttempt } from '../src/experiments-comparison.ts';
import { canonicalSha256 } from '../src/experiments-oracle.ts';

if (!process.env.PI_AUTO_REVIEW_DOCKER_TEST_BACKEND || !process.argv[2]) throw new Error('Explicit backend and fresh artifact directory required.');
const prepared = await prepareReviewCase(process.argv[2], { caseId: 'review-dispatch-v1',
  revisions: ['b4fdb8e76b3777afa50b900d49fb3f51eb392cf7', 'c21a3ec1d62c497d7dfeca1b6ee867a6adb3d1ab'], probe: 'evaluation/fixtures/dispatch.mjs' });
const grant = approveRestricted(prepared.requests, { approvedBy: 'user-authorized-m4-narrow-replay',
  familySha256: canonicalSha256(prepared.requests), expiresAt: Date.now() + 120000, maxAttempts: 2, maxWallMs: 30000, maxOutputBytes: 262144 });
const attempts = [];
for (const [index, request] of prepared.requests.entries()) {
  const saved = await runRestrictedNode(request, grant, join(prepared.root, 'attempts'), join(prepared.root, 'active.json'));
  const attempt = await readRestrictedAttempt({ path: saved.receipt.paths.receipt, sha256: saved.sha256 });
  attempts.push({ name: index ? 'head' : 'base', ...attempt });
  await writeFile(join(prepared.root, 'attempts.json'), JSON.stringify(attempts, null, 2));
  console.log(`${index ? 'head' : 'base'}: ${attempt.status}/${attempt.predicate}; ${saved.receipt.detail}`);
  assert.equal(attempt.predicate, index ? 'PASS' : 'FAIL', JSON.stringify(saved.receipt));
  assert.equal(saved.receipt.cleanup, 'container-removed');
}
await writeFile(join(prepared.root, 'summary.json'), JSON.stringify({ caseId: prepared.caseId, status: 'intentional-change-observed',
  sdk: prepared.sdk, attempts, rationale: 'Head commit explicitly replaces unapproved raw worker dispatch with the configured single team batch.',
  applicability: 'The configured-team criterion applies to the declared head behavior; base failure is intentional contrast, not a scored defect.',
  scope: 'Actual registration and launch argv, with inert exec and no launched Pi/provider/agent. Prompt batch policy inspected separately.',
  wholeCommitBugFree: false, requirementTruthEstablished: false, formalProof: false }, null, 2));
console.log(`Saved ${join(prepared.root, 'summary.json')}`);
