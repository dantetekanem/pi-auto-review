# Next evaluation: solo versus one fixed review batch

Status: protocol defined on 2026-11-01; not launched. This document neither authorizes inference spending nor changes the default review workflow.

## Question and scope

Does one fixed two-reviewer batch find more of the frozen known defects than a solo coordinator, or preserve recall at lower nominal cost? Compare source-only native Pi sessions, not recorded observations or runtime experiments. This is a diagnostic of the batch policy on exposed historical cases. It cannot establish production quality, a fresh holdout result, or a concurrency speedup.

## Fixed cases

Use all four cases in `evaluation/corpus/public.json`, with the exact base/head revisions, paths, requests and criteria already recorded there. Do not substitute cases after seeing results.

| Case ID | Base → head (abbreviated; full revisions in the corpus) | Repository |
| --- | --- | --- |
| `restore` | `1a5c875` → `d6b892a` | pi-auto-review |
| `dispatch` | `b4fdb8e` → `c21a3ec` | pi-auto-review |
| `progress` | `632e181` → `5366abb` | pi-extended-teams |
| `thinking` | `e42b414` → `4b1e148` | pi-auto-review |

Freeze the publication corpus identified by `evaluation/corpus/seal.json`: public SHA256 `d0e102345c80df254b7659412d6b759f1ebc45d45205b869898b0c0af14677a8`, author SHA256 `355b9c1db067442e0903c8ef822a146a24b80fb4963bc02c2f63a2e391013813`. The private gold has two defects across these four cases. Cases without gold are legitimate-change checks, not certified bug-free commits. Exclude the missing-dependencies setup control from recall denominators.

The lead has seen the labels. Separate reviewer inputs from author records, repair history, replay results, prior reviews and this protocol; do not call that separation a fresh holdout. The unpublished replay receipts must be available and hash-checked for adjudication. If unavailable, retain a preparation gap rather than silently recreating the evidence or treating labels as independently verified.

## Arms and execution order

- `solo`: one coordinator performs the complete scoped review and synthesis; no workers.
- `fixed-batch`: the same coordinator delegates exactly once to two native `read-review` workers with `completion_group: { delivery: "all-settled" }`, waits for both reports, then reconciles them. No collector, replacement, nested worker or second batch. Freeze disjoint source zones whose union covers the packet before launch; give the solo arm the same zone map and criteria.

Use Sol6.1/xhigh for both coordinators. Resolve and record the actual provider/model ID before launch; refuse an unavailable selection rather than substitute. Retain the configured worker-tier model/thinking, pin their resolved values and report them. This compares the configured batch policy, including its worker models, rather than isolating the effect of agent count.

Both arms receive identical hashed source packets, source-read access and finding format. Pin common review instructions and a minimal arm-specific delegation section; keep all other instructions equal. Start every case/arm with empty session history and learning. Disable adaptive recommendations, execution, observation cards, network retrieval and personal configuration discovery. The benchmark's restricted instructions are not the full production workflow.

Run one sample per case/arm, serially in this order: restore solo, restore fixed-batch, dispatch fixed-batch, dispatch solo, progress solo, progress fixed-batch, thinking fixed-batch, thinking solo. Native worker requests also run serially through the guard. Record per-cell wall time, but do not infer parallel performance from it. No tuning between cells or rerunning an unfavorable result.

## Limits and launch prerequisites

Proposed limits, shared by both arms and counted across coordinator plus children per cell:

| Limit | Per case/arm | Entire comparison |
| --- | ---: | ---: |
| Inference POSTs, including failed attempts and coordinator wake-ups | 6 | 48 |
| Wall time, including tools and settlement | 600 seconds | 4,800 seconds |
| Historical-code execution attempts | 0 | 0 |

Use a 600-second request deadline bounded by the remaining cell time, one-MiB response capture, zero transport retries and the guard's matching-account quota preflight with at least 20% included allowance remaining. A stopped or incomplete cell stops the batch; later cells remain unknown. Preserve partial reports and usage. Never renew an allowance by changing directories or deleting a ledger lease.

Before any inference, the host must freeze an `EvaluationPlan` and launch manifest with corpus/scorer hashes, packet and prompt hashes, exact extension/SDK versions, zone maps, model selections, numerical token-budget metadata and the approved retained-ledger identity. Pin the same token-accounting limits for each arm. Publish the preflight's remaining request allowance and conservative nominal USD reservation using the selected models' catalog maxima/prices. The proposed whole-comparison nominal reservation ceiling is USD25; reject a reservation above it rather than shrink inputs or switch models after approval.

The earlier pilot used 10 of 32 requests; its apparent 22 remaining requests cannot cover this plan's 48-request maximum and are not a new grant. A launch needs separate explicit approval covering this plan and any existing-credit spillover risk, reconciled with the retained ledger. Adjudication/preparation model calls need their own declared allowance and cost; they are not hidden inside review-only totals.

The installed adapter does not enforce a server output-token cap. Token metadata and catalog reservations are accounting bounds, not hard billing limits; cancellation does not prove generation or billing stopped. Billed cost stays unknown without a monetary observation. If approval requires a hard dollar cap that the provider cannot enforce, do not launch.

The native-session safeguards and offline tests described in `evaluation.md` are building blocks, not an implemented runner for these arms. Launch preparation must supply and verify the scoped read/report/teams adapters, mandatory child enrollment, input attestation, budget/deadline enforcement and final settlement. `run-benchmark.mjs` runs the earlier one-shot comparison and must not be presented as this policy runner. Adapter implementation, obtaining external case sources and executing the study are follow-up work, outside this documentation change.

## Scoring and acceptance

Freeze judgments with an independent adjudicator who did not produce the reviews; conceal arm identity and usage during judgment. Use the existing author matching rules and `scoreEvaluation`. Count known defects once per case/arm. Keep novel, duplicate, false-positive and unadjudicated findings separate; do not add discoveries to gold midway through the study.

A complete diagnostic requires all eight cells complete, verified launch identities, no input/budget violations, a judgment for every finding, and complete comparable usage/cost provenance. Otherwise report an incomplete diagnostic with the exact gaps; do not declare either arm a winner. Novel findings remain unresolved even when every finding has a judgment.

The fixed batch earns a follow-up on fresh cases only if it has no more adjudicated false positives than solo, does not lose a defect found by solo, and meets either condition:

1. It finds at least one additional frozen defect and its total nominal USD cost is at most 1.25 times solo's.
2. Both arms find 2/2 defects and fixed-batch total nominal USD cost is at most 0.80 times solo's.

These are practical screening thresholds, not statistical significance or deployment acceptance. Compare costs only with complete nonzero totals on the same provenance and price basis. Unknown cost makes the cost criterion undecidable, not a pass. Failure to meet either condition means no demonstrated benefit on these cases, not proof the batch is generally worse. Even a pass does not change defaults or finish P21/P25/P27/P32 acceptance.

## Required result report

Publish a per-case/arm table of status, findings and usage. In the aggregate table, report each arm's all-case recall as `found/2`, runnable-case recall with its actual denominator, completed cells as `n/4`, adjudicated precision with numerator/denominator, false positives, duplicates, novel and unadjudicated findings. Mark zero denominators as undefined. Show paired defect gains/losses, not just percentages.

For each arm report inference calls, input/output/cache tokens, summed wall time, nominal USD with provenance, billed USD separately, and cost per known defect found (undefined if none). Include preparation/adjudication cost separately and an all-in total only when every component is known. Missing metrics retain `knownTotal` and `missingCases`; they never become zero. Link the plan ID, hashed launch/usage receipts, judgments and scorer output without exposing credentials or private raw requests.

No results exist for this comparison yet: recall, cost and threshold outcomes are pending. The earlier recorded-evidence pilot found 2/2 known defects in each arm at nominal SDK estimates of USD0.589842 (source only) and USD0.557746 (recorded observations); billed cost was unknown and assistance/stopped calls were excluded. Those figures are historical context, not results or cost predictions for these native-session arms.
