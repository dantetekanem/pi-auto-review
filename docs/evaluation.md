# Historical evaluation cases

M4 has four scoped historical cases and a separate setup-failure control. The corpus tests evaluation wiring; it is too small and too related to establish general review quality. The recorded-evidence pilot below has completed; full review-policy comparisons remain open.

- `evaluation/corpus/public.json` contains reviewer-visible revisions, scope and criteria.
- `evaluation/corpus/author.json` contains labels, matching rules, repair history, limitations and hashes of unpublished replay receipts. Keep it out of reviewer input, along with replay scripts and their results.
- `evaluation/scoring.ts` scores supplied independent judgments. It neither reviews code nor decides whether a claim is true.

The two tuning cases cover restored completion and configured dispatch. The nominal holdout covers progress rendering and thinking preservation. All labels have been exposed to the implementation lead. An unrestricted Pi session can read author files; a directory name is not access control. Do not describe this as a blinded lead holdout. Use a reviewer with genuinely separated inputs and independent adjudication, or replace exposed cases before tuning against another holdout. Public history may also be in model training data.

## Replay evidence

The author records link to 17 actual restricted attempts. Each request and captured output was revalidated through `readRestrictedAttempt`. These are fixture observations, not full live Pi sessions or proofs of requirement truth.

| Case | Observed behavior | Limit |
| --- | --- | --- |
| Restored completion | Two fresh head attempts send a duplicate notice; the repair sends none. | Actual SDK0.85.1 entries and historical handler, inert host delivery. Base lacks the feature and is unresolved, so origin is not established by execution comparison. |
| Configured dispatch | Head registers and launches the configured team tools; base intentionally differs. | Launch is inert; prompt policy was inspected, not executed by a model. No whole-commit bug-free label. |
| Progress rendering | Immediate parent passes, revised head fails twice with the same frames, repair passes. The original candidate passes and was rejected. | Historical producer/widget with pinned TUI0.73.1, fake time and injected lifecycle state. The new helper file changes the source path set, so strict machine comparison is incompatible; introduction remains source/reviewer-supported. |
| Thinking preservation | Head preserves high/xhigh and blocks unsupported xhigh; base forces medium. | Inert registry and exec. Coordinator behavior is distinct from worker-tier policy. Subscription behavior is outside this case. |

The restoration missing-dependencies attempt is the setup control. It is `setup_error/UNRESOLVED`, not a fifth review case or a missed defect. Corpus evidence paths are relative to an external replay-evidence directory; the raw files are not published here. The publication copy removes machine-specific locations without changing labels or receipt hashes. `seal.json` identifies both the publication copy and the original evaluated corpus. If the raw artifacts are unavailable, disclose that evidence gap. Do not regenerate or replace them silently.

The `evaluation/replay-*.mjs` scripts prepare fresh artifacts and run the cases with an explicitly supplied existing backend. Their execution requires authorization; source-only inspection and scoring do not. Preparation pins Git blobs and installed dependencies without running historical source on the host. No script installs dependencies, pulls images or starts a service. The worker remains the restricted Node profile, not a sandboxed reviewer.

## Reviewer input preparation

`node evaluation/prepare-benchmark.mjs ABSOLUTE_OUTPUT ABSOLUTE_TEAMS_REPOSITORY` prepares the sealed public corpus without model calls or historical-code execution. The output directory must be new. It reuses the committed-source materializer and writes one hashed packet per case: public criteria, scoped diff and exact base/head source bytes. Author records, repair history, replay results and scorer code are not copied into the packets. Unsupported trees, input drift and private corpus fields reject preparation.

Packets are limited to two MiB each and cover only the declared paths, not every dependency. They do not replace an enforced reviewer tool allowlist, a frozen comparison plan or a fresh holdout after labels were exposed. A later runner must verify packet hashes and supply only authorized inputs to each variant. Preparation does not authorize launching it.

## Frozen evaluation input

Before a comparison, pin both corpus files, the scorer, reviewer variants and their prompts. Build an `EvaluationPlan` with:

- `schemaVersion: 1`, the combined corpus hash, exact coordinator model/thinking;
- each variant's ID and source/prompt hash;
- case IDs, exact base/head revisions and private known-defect IDs;
- the same per-case/variant model-call, input-token, output-token, execution-attempt and USD limits.

Use `evaluationIdentity(plan)` as every run's `planId`. The scorer rejects mismatched plans, duplicate case/variant runs, conflicting findings and unsupported gold links. This binds records to supplied metadata; it does not attest that a model used those settings or enforce execution budgets. Keep actual launch/usage receipts and enforce limits before starting calls.

Each `EvaluationRun` records `caseId`, `variant`, status and finding IDs. Status is `complete`, `incomplete`, `infrastructure-error`, `invalid-fixture`, `unsupported` or `unknown`. Optional usage records contain actual available input/output/cache token counts, wall time, execution time and USD cost. A cost needs `provider-reported` or `usage-times-prices` provenance; a token-price estimate is not an invoice. Subscription quota with no monetary observation stays unknown, not zero.

Optional execution counters record attempts, fresh failing replays, setup failures, invalid fixtures, duplicates and unresolved outcomes, with receipt hashes. Validate those receipts before supplying counters. The scorer totals the supplied counters; it does not authenticate them or promote them to finding truth.

## Independent adjudication and scoring

An adjudication identifies one case, variant and finding, its adjudicator, reason and evidence references. Match cause and impact against the frozen rule, not keywords or an expected line alone:

- `known` links to an existing gold defect. Only its first occurrence is a true positive; repeats are duplicates.
- `false-positive` requires a reason the particular claim is wrong. A case's legitimate intent does not disprove every possible new defect.
- `novel` remains unresolved pending independent validation. A finding without a judgment is separately counted as unadjudicated.
- `duplicate` links directly to another adjudicated finding in the same case/variant. Missing targets, self-links and chains are rejected.

`scoreEvaluation(plan, runs, judgments)` returns per-variant counts and fractions with numerators and denominators:

- Precision covers adjudicated known true positives and false positives only. Novel and unadjudicated findings remain visible beside it.
- All-case recall includes every selected known defect. Runnable-case recall includes only cases whose review completed.
- A complete review that misses a known defect counts as a miss. A noncomplete case leaves unfound defects unassessed, not missed runnable defects. A valid finding saved before a failure can still count after independent adjudication.
- Missing case/variant runs appear as unknown. The setup control is excluded from review-case denominators.
- Every numeric total reports `knownTotal` and `missingCases`. `total` is null while any selected case lacks that metric. Missing usage never becomes free execution.

Review completion and runtime success are separate. A completed source review can have setup failures in its optional runtime checks; those failures remain in execution counters and do not establish a code defect.

## Bounded recorded-evidence comparison

`evaluation/run-benchmark.mjs` runs a frozen paired one-shot comparison with no tools or inherited Pi session: source only versus the same source plus preselected historical observations. This measures evidence consumption, not autonomous experiment choice, the production reviewer or full P21/P25/P27/P32 acceptance. The common prompt is `prompts/benchmark-review.md`. Observation selection can reveal where the author looked; report that bias and independently adjudicate findings.

The host pins the plan, packets, observation cards, prompt and installed SDK inputs before calling `node evaluation/run-benchmark.mjs PLAN SHA256 OUTPUT`. The output directory must be new and remains claimed after failure; never remove it to retry a cell. Each cell makes at most one inference POST through SSE with retries disabled. The first incomplete cell stops the batch and leaves later cells unknown. Raw requests, bounded response bytes, parsed messages, usage and hashed receipts remain local. Credentials are read without refresh and never written to artifacts.

The pilot used a 32-request cumulative budget, serial execution, a 600-second request deadline and a one-MiB response limit. A fresh matching-account usage GET precedes each request and rejects less than 20% included allowance remaining. Usage snapshots cannot exclude existing-credit spillover; the runner requires explicit approval of that risk. It does not purchase credits, reload them, change billing settings or substitute a provider/model. The host must subtract prior requests from its authorized budget when preparing a later plan; a fresh directory does not renew that allowance.

The installed Codex adapter does not send `max_output_tokens`. Client cancellation and capture limits do not cap server generation or prove charges stopped. A conservative nominal reservation uses request-byte counts as an input-token allowance and the catalog's output maximum and highest listed prices, with a USD25 ceiling. This is conditional catalog accounting, not an invoice or enforceable server billing limit. Monetary cost remains unknown unless separately observed. Record these distinctions alongside any scorer plan's token-budget metadata; do not claim matched hard-token budgets.

## Recorded-evidence pilot (2026-10-28)

Eight isolated Sol6.1/xhigh reviews completed: four source-only cases paired with the same cases plus recorded observations. Independent adjudication found no known-defect recall gain.

| Metric, four reviews per arm | Source only | Recorded observations |
| --- | ---: | ---: |
| Known defects found, all/completed cases | 2/2 | 2/2 |
| Other findings outside frozen gold | 4 | 3 |
| Adjudicated false positives / within-run duplicates | 0 / 0 | 0 / 0 |
| Input / output tokens | 171,246 / 24,735 | 174,148 / 20,945 |
| Summed wall time | 760.617 s | 507.489 s |
| SDK nominal token-price estimate | $0.589842 | $0.557746 |

The seven other findings represent four distinct candidates. Three restoration causes have source support, with runtime impacts still conditional; the dispatch candidate needs an unverified Herdr status assumption. They remain `novel`, not new gold or runtime-proven defects. The scorer's 2/2 precision denominator excludes them and must not be presented as overall 100% precision. No finding was left without an adjudication.

This is one sample per arm/case with preselected observations and lead-exposed labels, not a fresh holdout or evidence of a causal speedup. No new Docker or TLC attempt ran. The eight calls' $1.147588 SDK estimate excludes preparation/adjudicator assistance and two earlier stopped calls; billed cost is unknown. Those attempts, one missing-prompt failure and one 180-second timeout, remain preserved outside the paired score. Ten of the 32 authorized benchmark requests were used; timeout usage is missing, not zero.

The score, paired results, judgments and evidence records are retained outside this repository; launch SHA256 `d2bbd397d025cd9d5a298e356a7584076b97b264d630191829e69ec0117b02c6`. Raw requests/responses, account observations and earlier attempts are not published. This summary is not independently reproducible from the repository alone; do not regenerate missing artifacts silently.

## Full policy comparisons still pending

P21 requires a matched source-only/runtime comparison and a frozen held-out evaluation. P25 and P27 need their own policy/concurrency comparisons; these scripts and synthetic scoring tests do not substitute for them. Explain the selected provider, subscription quota versus API billing, exact run limits and remaining maximum cost before spending the authorized evaluation budget. Sol6.1/xhigh is the requested coordinator choice; do not silently substitute a different model or effort. Worker tiers retain their configured values.
