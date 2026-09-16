# pi-auto-review

An experiment in automatic, evidence-backed code review for [Pi](https://pi.dev).
Independent agents collect context, trace connected behavior, and review the change.
The final report explains what it does, how it works, and where it falls short.

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

Both entry points run the same mission. They differ only in where it runs.

`/code-review` preflights the target, exact range, active model and its effective thinking level, writes the run artifacts, then runs the review in the current Pi session. It preserves that level when the selected model supports it. If a medium review needs another model, preflight can choose a medium-capable model; high and xhigh never fall back to medium. The command sets this session to the preflighted model and thinking level, sends the mission as a user message and does not open a pane or ask for confirmation. When the review completes, the same session receives the handoff and presents the report.

Agents call `agentic_code_review` with plain-text context. That tool runs the same preflight, then starts a named Pi session in a new visible Herdr pane. That session prepares the pack, launches one pi-extended-teams batch, reconciles, saves learning and completes a file-based handoff to the invoking session. There is no delegated controller. A genuine intake question appears in the visible review pane.

When a review already runs in another Pi session, `agentic_code_review_subscribe` can register one bounded handoff using the exact review session ID, run ID, expected target, and expected head. It validates those saved artifacts but does not prove this session launched the review or that the caller's relevance decision is correct. Same-session `/code-review` runs keep their native watcher. Missing, malformed, failed, or timed-out artifacts send a failure handoff, not a review result.

For a pull request URL the review session first pulls the PR itself through the provider's CLI (`gh` for github.com, `gs` for Meteorite), read-only: the description becomes a requirement source, existing review threads and bot comments become evidence to reconcile rather than repeat, and CI becomes a process condition. The [PR context contract](prompts/pr-context.md) has the commands and record shapes.

## One batch and two worker tiers

The visible review session uses its preflighted model and thinking level. It calls `spawn_swarm_agents` from pi-extended-teams once, with `completion_group: { delivery: "all-settled" }`, for at most two `read-review` lanes and one `read-collect` lane. The configured worker tiers run both at `medium`; they do not describe coordinator provenance. `read-collect` gets a closed list of criterion-bearing scan gaps; `read-review` judges a bounded responsibility zone and runs every taste lens. Every lane prompt opens with the run-local paths of its contract, `taste.md`, `craft.md`, `voice.md`, `pr-comments.md` and `presentation.md` (prepare copies them to `<run>.prompts/`), plus the run IDs, repository, revision and pack path. A lane whose mission lost a path calls `agentic_code_review_read_prompt` by name instead of searching the filesystem. Lanes report through `report_and_exit`; the grouped report resumes the review session when every lane settles. A lane that ends partial, blocked, failed or stopped leaves its items to the review session. There is no status polling, inbox loop, second batch or stronger tier.

The review session starts with one `sparsity_scan` call over the exact diff: changed definitions with their vicinity (the file lines above and below each definition), resolved calls, callers with three lines around each call site, representative test anchors plus grouped tests, changed hunks for schema/JSON/YAML files and for any file without a parser (with head-file vicinity and a note that callers, tests and siblings must be read by hand), removed definitions with surviving callers, and an explicit recap of gaps. Workers receive exact anchor IDs and pack line ranges. A criterion-bearing `no parser` file goes to the collector, which does the vicinity work manually: reads around the hunks, `rg`s the changed names for callers and tests, and names the sibling definitions. Static candidates are not runtime proof.

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

A lower wall time with the same or more accepted findings is the result to look for; a rising unresolved rate says
where the scan needs another resolution rule.
Entries link to their review, revision, and sources. Later runs revalidate the current blocks, fold corrections in, and keep the superseded claims in the history.

For a requested re-review, the review session links the earlier assessment and reviews the fix plus affected boundaries.
It reuses revalidated evidence and reports prior findings' outcomes. Stage and total timing are recorded for optimization, never used to stop or downgrade the review.

## Experimental limits

This is prompt-directed behavior, not a deterministic reviewer or a sandbox.
Workers and tools can fail internally; the top-level session finishes their required work before handing the completed review back. Missing evidence remains explicit. Merge/deployment grades authorize neither action.
The workflow forbids source edits, automatic retries, installs, publication, merges, and deployments.
Telemetry capture is currently disabled.
It does not train model weights or run an endless self-review loop.

See the [workflow](prompts/workflow.md), [evidence contract](prompts/artifacts.md),
[report format](prompts/presentation.md), and [review session launch](prompts/session-launch.md).

## License

[MIT](LICENSE). Copyright 2026 Leonardo Pereira.
