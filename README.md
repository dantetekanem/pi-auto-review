# pi-auto-review

An experiment in automatic, evidence-backed code review for [Pi](https://pi.dev).
Independent agents collect context, trace connected behavior, and review the change.
The final report explains what it does, how it works, and where it falls short.

## What's new in 0.7.1

- `/code-review` isolates reviews from prior conversation while keeping clean sessions in place.
- Completed review panes close after handoff, with an idle-state and session-identity check. Reports remain available if cleanup fails.

## What's new in 0.7.0

- Per-run coordinator model/thinking selection and a completion handoff that does not pause previously authorized work.
- [Evidence support and receipt verification](docs/evidence.md), explicit replay protection and [host-approved two-worker batches](docs/workers.md).
- [Adaptive retrieval recommendations](docs/adaptive.md) with frozen budgets. They do not launch work or grant execution permission.
- [Historical cases and benchmark tooling](docs/evaluation.md), plus a host-only finite reservation-model checker. The checker is not a TypeScript proof.

Source-only reviews and the fixed one-batch workflow remain the defaults. In the eight-review pilot, both variants found 2/2 known defects; no known-defect recall gain was observed. Full production-policy, adaptive, parallel and formal-assisted comparisons remain unfinished.

## Why this exists

A clean diff and a confident model can still hide a wrong assumption.
A useful review starts with the problem, follows the consequences, and shows its evidence.
This experiment separates collection from judgment, absorbs helper/runtime recovery inside the review,
and saves verified codebase knowledge so the next run can build on it.
The goal is better understanding, not more comments. You still own the decision.

## Dependencies and installation

Requires Node.js 22+, Pi 0.85.1+, a configured model provider and [Herdr](https://herdr.dev) for the visible review pane.

```sh
pi install git:github.com/dantetekanem/pi-auto-review
```

Run from a Herdr-managed Pi pane. In `/agents-extensions`, allow `pi-auto-review/src/index.ts` for child agents so they can submit findings; allow the canonical `pi-agentic-search/index.ts` so the top-level review session can build its pack. Select the actual installed paths, preserving other selections rather than enabling every extension. Configure `read-collect` and `read-review` at `medium`. Auto-review never selects another worker tier. Pi extensions have full local access; inspect the source before installing.

## Use

Run this from the codebase you want reviewed:

```text
/code-review Check these changes against the retry contract.
/code-review https://github.com/owner/repo/pull/123
```

Both entry points run the same mission. `/code-review` uses the current session only when its active branch is clean; the agent tool always starts a separate session.

`/code-review` checks the active branch before starting. Prior conversation messages, custom context messages, compaction summaries or branch summaries make it dirty. Startup metadata, system instructions and abandoned branches do not. A clean session adopts the preflighted model and thinking level and runs the mission directly. A dirty session starts a named Pi session in a new Herdr pane without passing its conversation history or changing its own model settings. If the pane cannot launch, a fresh headless process runs the mission. Both paths preflight the target and exact range, preserve supported thinking levels, and return completion to the invoking session. High and xhigh never fall back to medium.

Agents call `agentic_code_review` with plain-text context. That tool runs the same preflight, then starts a named Pi session in a new visible Herdr pane. That session prepares the pack, launches one pi-extended-teams batch, reconciles, saves learning and completes a file-based handoff to the invoking session. There is no delegated controller. A genuine intake question appears in the visible review pane. After completion handoff, the runtime waits up to ten seconds for the reviewer to become idle, checks its session identity and closes only that pane. Cleanup failures show a warning without restarting the review or losing its report. Direct and headless reviews do not close the caller's pane. The tool also accepts optional per-run `model` (`provider/model`) and `thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`) arguments; omitted fields follow the existing selection/inheritance behavior, and explicit values are validated before artifacts or launch.

For example, select a coordinator without changing the invoking session or its worker tiers:

```js
agentic_code_review({
  context: "Review the current changes.",
  model: "openai-codex/gpt-6.1-sol",
  thinking: "xhigh"
})
```

When a review already runs in another Pi session, `agentic_code_review_subscribe` can register one bounded handoff using the exact review session ID, run ID, expected target, and expected head. It validates those saved artifacts but does not prove this session launched the review or that the caller's relevance decision is correct. Reviews started by `/code-review` already have a native watcher in the invoking session. Missing, malformed, failed, or timed-out artifacts send a failure handoff, not a review result.

For a pull request URL the review session first pulls the PR itself through the provider's CLI (`gh` for github.com, `gs` for Meteorite), read-only: the description becomes a requirement source, existing review threads and bot comments become evidence to reconcile rather than repeat, and CI becomes a process condition. The [PR context contract](prompts/pr-context.md) has the commands and record shapes.

## Three review passes

1. **Gather proof.** Read the project's run/test instructions and relevant knowledge from earlier reviews. Establish which runtime and focused checks are available, what setup they need and what would be too costly to run. Inspect assertions and mocks. Where safe and authorized, run the same regression test against the relevant before/defective and proposed implementations to demonstrate red → green; otherwise report the missing proof. A passing test alone does not establish that it catches the regression.
2. **Understand production.** Explain the project's purpose, its consumers and entry points, and the behavior before and after the change. Identify the affected user journeys, API contracts, migrations, shared critical code and operational effects.
3. **Trace future impact.** Follow changed assumptions inside out through callees, callers and consumers. Judge ownership, coupling, compatibility, recovery and test durability against concrete maintenance risks. Start at three call hops and deepen a specific connection when its frontier leaves an important question unanswered.

The report links evidence and gaps for all three passes. Each run saves verified accomplishments, useful test commands and runtime limits, settled questions and review methods so the next review can revalidate and build on them. Focused tests run only after their side effects are checked; broader execution needs authorization. Disposable reproductions stay with the run artifacts, separate from the reviewed tree.

## Opt-in execution

`agentic_code_review_execute_experiment` connects the review to a trusted-program or restricted Node worker. It runs only host-prepared check or family IDs, not commands or probes supplied by the reviewer. With no configured plan it reports unavailable; source-only reviews still work.

After approving the exact program and its effects, the host starts a **fresh Pi process** with `PI_AUTO_REVIEW_REPLAY_PLAN` set to an absolute JSON manifest path and `PI_AUTO_REVIEW_REPLAY_SHA256` set to its SHA256. Run `/code-review` before adding conversation history so the review stays in that clean process. Do not ask the reviewing model to create its own authorization. A prompt, an `approved` field or an old pane does not configure the host.

The manifest has `schemaVersion: 1`, `expiresAt` (UTC timestamp), exact `target`, `checkout`, `base`, `head`, and `checks: [{ id, maxAttempts, request }]`. Each request follows [`ReplayRequest`](src/experiments-replay.ts), without `runId`: an absolute executable and cwd, copied script name, argv, pinned file hashes, allowed environment, exact output headers/case identities and time/output limits. Pin the script, executable and relevant source, fixtures and dependencies. The runtime binds the request to the prepared run. There may be at most six checks and ten total attempts.

The tool snapshots the manifest at startup and binds execution to the original UI session and first matching review. First execution consumes the manifest with an exclusive `.claimed` file; reloads cannot replenish attempts. The model lists available checks without execution, then selects a check ID. A duplicate check is rejected. For a deliberate fresh replay, pass `replayOf` with its latest settled attempt ID; this consumes another approved attempt and uses fresh scratch. A changed pin or exhausted grant prevents execution. Capture, cleanup and receipt writes belong to the runner; the completion tool verifies and attaches the receipt index to the final review.

**This is not isolation for arbitrary PR code.** Approved programs retain host privileges; only their direct child is controlled. File hashes detect drift, not hostile concurrent writers. Dynamic dependencies must be accounted for by the host, and parsed case output is not independent proof. Background processes are unsupported. Use this profile only for inspected, explicitly authorized programs. Never delete a reservation or use raw shell execution to bypass denial.

### Restricted Node worker

A `schemaVersion: 2` plan keeps the same review identity fields and check IDs, and adds `scope: "worker-only"`, `familySha256` and `budget: { maxAttempts, maxWallMs, maxOutputBytes }`. Requests follow [`RestrictedRequest`](src/experiments-restricted-contract.ts), without `runId`. Up to 128 exact requests share one cumulative budget, capped at 64 attempts, ten minutes of summed attempt time and 16 MiB of captured output. Each check also has its own attempt cap. Only approved base/head commits and explicitly labeled sensitivity mutations are accepted.

The worker uses an already-running local Docker Engine and an already-present immutable Linux/arm64 Node image. It never pulls an image, installs dependencies or falls back to host execution. The profile uses a read-only root and sealed input bundle, nonroot UID 1000, no network or socket creation, dropped capabilities, no-new-privileges, private namespaces, 512 MiB memory, 64 tasks, one CPU, and bounded scratch, time and output. The host verifies effective configuration before execution and removes the whole container afterward. An unresolved durable `.active` intent blocks later attempts; do not delete it to retry.

The first adapter invokes the actual committed `registerFindings` tool handler with a pinned `node:test` probe. It projects the real Pi file-mutation queue and Typebox dependencies into a sealed bundle; Pi registration and reviewer context are stand-ins. Git-object materialization does not run hooks, filters, installs or project setup. Symlinks, submodules, attributes, selected LFS pointers and unsupported dependency layouts are refused. Dirty worktrees are not execution snapshots.

Only bounded stdout/stderr cross the worker boundary; receipts and checker state are never mounted inside it. Child observations can still be fabricated by hostile code and are not semantic proof. Container/VM/kernel exploits and a malicious same-user host are outside this profile. **The Pi review session itself is not sandboxed.** Whole-session untrusted execution is unsupported, and missing backend support remains a source-only review gap.

A restricted plan without a family may opt into `workers: 2` for one finite `checkIds` batch. The default remains one worker; the reviewer cannot change concurrency. See [bounded execution batches](docs/workers.md) for resource leases, cancellation and receipt semantics.

### Calibrated experiment families

A schema2 plan may add one [`PreparedFamily`](src/experiments-family.ts) as `family`; `familySha256` must match its canonical hash. It pins the requirement/oracle, generator version and code hash, seed, domain, template check and three control IDs. The current `optional-findings-v1` family accepts at most four distinct fix/nit atoms and generates at most sixteen ordered subsets. Enumerate every permitted input with `enumerateFamilyInputs` and include its exact request in `checks`; all controls, trials and follow-ups share the plan's cumulative budget.

Call the execution tool without either selector to list availability, then use `familyId` instead of `checkId`. One call runs the known-pass, labeled target-failure and setup-error controls before the seeded trials. It records generated, accepted, rejected and executed counts, class distributions and individual receipts. Calibration establishes sensitivity to that control, not the truth of the requirement. The family is consumed once, including when it ends inconclusively; do not refresh it to retry.

Optional `metamorphic: { sha256 }` pins the member-order relation. Its canonical unique-member JSON input and transformed variant must both be approved. This checks only the named-field finding handler, not every JSON consumer. Optional `reduction: { sha256, maxEvaluations }` performs bounded ordered single deletions, two fresh stability repeats, a fresh audit of every final single removal and a final replay. A successful result is 1-minimal within these atoms, not globally smallest. Unknown outcomes, instability, incomplete audits and exhausted budgets stay inconclusive.

The host indexes an `experiment-family-v1` summary alongside the attempt receipts. A labeled mutant remains a sensitivity control, never a historical PR defect. See the [focused integration test](test/experiments-tool.test.mjs) for a complete prepared family. Host preparation is still required; AutoReview does not generate or authorize arbitrary experiments.

## Optional evidence support

Reviews can attach an [evidence support graph](docs/evidence.md) over existing map IDs. Completion computes freshness from recorded source/config/fixture/environment/probe/criterion identities, preserves independent support alternatives, and exposes stale or unknown reasons. Optional receipt-linked claims recheck captured bytes before reporting an observed outcome or failing replay. Fresh support is not proof of correctness, and source-only reviews remain valid.

## One batch and two worker tiers

The visible review session uses its preflighted model and thinking level. It calls `spawn_swarm_agents` from pi-extended-teams once, with `completion_group: { delivery: "all-settled" }`, for at most two `read-review` lanes and one `read-collect` lane. The configured worker tiers run both at `medium`; they do not describe coordinator provenance. `read-collect` gets a closed list of criterion-bearing scan gaps; `read-review` judges a bounded responsibility zone and runs every taste lens. Every lane prompt opens with the run-local paths of its contract, `taste.md`, `craft.md`, `voice.md`, `pr-comments.md` and `presentation.md` (prepare copies them to `<run>.prompts/`), plus the run IDs, repository, revision and pack path. A lane whose mission lost a path calls `agentic_code_review_read_prompt` by name instead of searching the filesystem. Lanes report through `report_and_exit`; the grouped report resumes the review session when every lane settles. A lane that ends partial, blocked, failed or stopped leaves its items to the review session. There is no status polling, inbox loop, second batch or stronger tier.

After proof intake and the initial product map, the review session makes one `sparsity_scan` call with `max_depth: 3` over the exact diff: changed definitions with their vicinity (the file lines above and below each definition), resolved calls, callers with three lines around each call site, representative test anchors plus grouped tests, changed hunks for schema/JSON/YAML files and for any file without a parser (with head-file vicinity and a note that callers, tests and siblings must be read by hand), removed definitions with surviving callers, and an explicit recap of gaps. Workers receive exact anchor IDs and pack line ranges. A criterion-bearing `no parser` file goes to the collector, which does the vicinity work manually: reads around the hunks, `rg`s the changed names for callers and tests, and names the sibling definitions. Static candidates are not runtime proof.

## Taste as the instrument

Reviewers do not find bugs by scanning for bugs. They notice the optional boolean, the stub in `setup`,
the rule living in a helper, the name that contradicts the flow, and follow it.
The [taste contract](prompts/taste.md) turns those observations into leads: what to notice, what to check,
what it usually hides, and how to ask. It was built from twelve months of the maintainer's review comments,
where one comment in four starts as taste and ends pointing at a defect.

A lead settles into a `bug` (with the `lens` that surfaced it), a `question` for the author,
a `nit`, or nothing. Taste alone never blocks; what it uncovers can.

## The craft pass

Finding bugs is half the job. The [craft contract](prompts/craft.md) runs after the lenses in every zone and
turns what the reviewer knows into feedback the author can use: the better shape shown as code with one line on
what it buys, a receipt on every behavior claim (what was run, read or counted), a question for the proof only
the author can give, one teaching sentence per non-obvious mechanism, concessions and fast-follows said out loud,
rare labeled nits, and what is good. It follows the maintainer's own method, in the order that matters: own the
outcome, problem first, tests as the spec, design, smells and vicinity, ask yourself, inspect, be reasonable,
write the comment. Measured over the same twelve months, 15% of the maintainer's comments show the change as
code, 20% teach the mechanism, 7% carry proof and 10% ask for it; the review session calibrates each zone
against that mix before grading and saves what made the reviewer better to `methods.md`.

## Reports and reusable knowledge

Every sentence written for a person follows the [voice contract](prompts/voice.md):
written first as one engineer would say it to another, then checked against the evidence.
The decision narrative is capped at 500 words. Every proposed inline comment appears in full below it with file:line, kind/lens, blocking status and the exact posting body; comment blocks are not hidden behind a follow-up or counted against the narrative cap. The report is private and never auto-posted. Source-linked findings include short explanations,
A–F ratings and available model/thinking provenance. Missing evidence is not a proven defect.
Actionable findings belong in source-line comments, not a general blocking PR body.
The [comment guide](prompts/pr-comments.md) requires explicit approval before inline posting; this package does not post.

Run evidence lives in the configured Pi agent directory's `auto-review/<session-id>/`.
Shared `structure.md`, `design.md`, `framework.md`, `testing.md`, `pitfalls.md`, `decisions.md` and `methods.md` notes live in
`auto-review/codebases/<codebase>/`.

## Reviews that compound

Each topic file carries one `current` block on top, the consolidated text the last finishing run wrote, above the
append-only history of dated run entries. Intake calls `agentic_code_review_read_learning`, which returns only the
current blocks, so the cost of remembering stays flat as runs accumulate. `decisions.md` keeps one line per settled
question (symbol, claim, how it was settled, run, outcome) so a later review does not re-raise it unless that code changed;
`methods.md` keeps what settled questions fastest and what wasted time in each component. HTTPS, bare-host, git and owner/repo spellings share one collision-safe repository key; reads also combine equivalent legacy folders without mixing unrelated checkouts named `src`. At the end, the review session saves a rewritten current block and a delta per topic, and the review JSON records `learning: { reused, refuted, saved }`.

## Measuring the pack

A pack whose manifest shows no truncation, no skipped production anchor and no unresolved edge inside a criterion's
anchor is the inventory: no collector runs and zone reviewers start at once. Otherwise the failing items form a closed gap
list for one collector that runs beside the reviewers, never in front of them.

Every final review JSON records `collection` (`pack`, `pack+gaps` or `diff-only`), `collectors` (how many collection
lanes ran) and, for pack runs, the `sparsity_scan` metrics (build time, anchors, edges, unresolved rate, inline and
spilled tokens). Add the line `mode: diff-only` to a review's
context to skip the scan on purpose. Compare a few runs of each kind with wall time and findings:

```sh
for f in ~/.pi/agent/auto-review/*/*.review.json; do
  jq -r 'select(.status == "complete") | [.collection, ((.completedAt | fromdateiso8601) - (.createdAt | fromdateiso8601)), (.findings | length), (.pack.unresolvedRate // "-")] | @tsv' "$f"
done
```

Compare proven detection and false positives alongside wall time, test-sensitivity evidence and unresolved connections. Finding counts alone do not measure review quality; a rising unresolved rate identifies where tracing needs more work.
Entries link to their review, revision, and sources. Later runs revalidate the current blocks, fold corrections in, and keep the superseded claims in the history.

For a requested re-review, the review session links the earlier assessment and reviews the fix plus affected boundaries.
It reuses revalidated evidence and reports prior findings' outcomes. Stage and total timing are recorded for optimization, never used to stop or downgrade the review.

## Portable review telemetry

Each review exposes a versioned `telemetry` object in its completion tool result, completion handoff and existing `.review.json`. Capture starts before the mission's first model call. It includes coordinator and settled native-team usage, observed models, per-agent and per-model costs and tokens, and elapsed milliseconds. Review time starts at preparation and ends at completion; overlapping agent times are not added together. Later presentation turns are excluded.

Get JSON directly, without opening a log file:

```js
agentic_code_review_export_telemetry({}) // All retained telemetry reports.
agentic_code_review_export_telemetry({ sessionId: "session-id", runId: "review-run-id" })
```

The result's text is JSON; `details` contains the same `{ schemaVersion, exportedAt, reviews, summary, unavailableReviews }` object. The existing review artifacts retain reports across sessions. Historical reviews without telemetry are counted in `unavailableReviews`, not reconstructed from guesses. No separate database or remote upload is configured.

- `cost.knownUsd` is the recorded subtotal. `cost.totalUsd` is null when the recorded total is incomplete. Costs are Pi-recorded estimates, not invoices; `billedUsd` stays null.
- `agents`, `models` and `unattributed` separate native agent usage, observed model identities and auxiliary usage whose model Pi did not record. Configured tiers are not evidence of the model used. External harnesses, legacy receipts, excluded agents and missing usage leave explicit gaps.
- `summary.averageCostPerReviewUsd` averages distinct telemetry-bearing reviews only when their costs are complete. Otherwise it is null; `averageKnownReviewCostUsd`, `costSampleCount` and `incompleteCostReviews` describe the available sample. `summarizeReviewTelemetry` in `src/telemetry-report.ts` combines exports, keeping the newest record for each `(sessionId, runId)`.
- In-process consumers can subscribe to `pi.events.on('pi-auto-review:telemetry', report => ...)`. A late child receipt updates the same review identity. Store updates by `(sessionId, runId)`, using `capturedAt` to ignore older copies. Export can recover the latest saved report if an event was missed.

Generated telemetry excludes prompts, source, tool arguments/results and credentials. It is not a signed accounting ledger. Missing model attribution, unrecorded provider activity and unfinished reviews remain visible; recorded assistant responses are not an exact request count. Telemetry adds no request, spending or elapsed-time limit and never uploads data by itself.

## Experimental limits

This is prompt-directed behavior, not a deterministic reviewer or a sandbox.
Workers and tools can fail internally; the top-level session finishes their required work before handing the completed review back. Missing evidence remains explicit. Merge/deployment grades authorize neither action.
The workflow forbids source edits, automatic retries, installs, publication, merges, and deployments.
It does not train model weights or run an endless self-review loop.

See the [workflow](prompts/workflow.md), [evidence contract](prompts/artifacts.md),
[report format](prompts/presentation.md), and [review session launch](prompts/session-launch.md).

## License

[MIT](LICENSE). Copyright 2026 Leonardo Pereira.
