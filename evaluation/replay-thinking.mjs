// Author-only intentional-change evidence. No live model or process is launched by the fixture.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareReviewCase } from './prepare-review-case.mjs';
import { approveRestricted, describeRestricted } from '../src/experiments-restricted-contract.ts';
import { runRestrictedNode } from '../src/experiments-node.ts';
import { readRestrictedAttempt } from '../src/experiments-comparison.ts';
import { canonicalSha256 } from '../src/experiments-oracle.ts';

if (!process.env.PI_AUTO_REVIEW_DOCKER_TEST_BACKEND || !process.argv[2]) throw new Error('Explicit backend and fresh artifact directory required.');
const prepared = await prepareReviewCase(process.argv[2], { caseId: 'review-thinking-v1',
  revisions: ['e42b414f08b21043acafcf025d28748f80ab70fc', '4b1e148bd62d215294d0f8044d1bf5bf334f42aa'],
  probe: 'evaluation/fixtures/thinking.mjs', input: { thinking: 'high', supported: true } });
const [base, head] = prepared.requests;
const inputRequest = (request, thinking, supported) => describeRestricted({ ...request, input: JSON.stringify({ thinking, supported }) }).request;
const work = [
  { name: 'base-high', request: base, expected: 'FAIL' },
  { name: 'head-high', request: head, expected: 'PASS' },
  { name: 'base-xhigh', request: inputRequest(base, 'xhigh', true), expected: 'FAIL' },
  { name: 'head-xhigh', request: inputRequest(head, 'xhigh', true), expected: 'PASS' },
  { name: 'head-unsupported', request: inputRequest(head, 'xhigh', false), expected: 'PASS' },
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
await writeFile(join(prepared.root, 'summary.json'), JSON.stringify({ caseId: prepared.caseId, status: 'intentional-change-observed',
  attempts, rationale: 'Head explicitly preserves effective caller thinking instead of forcing medium; unsupported requested thinking is blocked.',
  applicability: 'Head high/xhigh behavior matches the declared new contract; base failure is intentional contrast, not a scored defect.',
  scope: 'Actual exported historical preflight/launch functions with inert registry and exec; no live Pi, provider or pane. Worker tier policy is separate.',
  wholeCommitBugFree: false, requirementTruthEstablished: false, formalProof: false }, null, 2));
console.log(`Saved ${join(prepared.root, 'summary.json')}`);
