# pi-auto-review

An experiment in automatic, evidence-backed code review for [Pi](https://pi.dev).
Independent agents collect context, trace connected behavior, and review the change.
The final report explains what it does, how it works, and where it falls short.

## Why this exists

A clean diff and a confident model can still hide a wrong assumption.
A useful review starts with the problem, follows the consequences, and shows its evidence.
This experiment separates collection from judgment, keeps failed reviews visible,
and saves verified codebase knowledge so the next run can build on it.
The goal is better understanding, not more comments. You still own the decision.

## Dependencies and installation

Requires Node.js 22+, Pi 0.85.1+, and a configured model provider.
Both companion packages are required:
- [pi-extended-teams](https://github.com/dantetekanem/pi-extended-teams) runs the coordinator and isolated child agents.
- [pi-solid-tasks](https://github.com/dantetekanem/pi-solid-tasks) tracks the coordinator's stages, dependencies, and completion evidence.

```sh
pi install git:github.com/dantetekanem/pi-extended-teams
pi install git:github.com/dantetekanem/pi-solid-tasks
pi install git:github.com/dantetekanem/pi-auto-review
```

Start a new Pi session. In `/agents-extensions`, allow these registered entries for child agents:
- `pi-auto-review/src/index.ts`: the finding and learning tools used during reviews.
- `pi-solid-tasks/src/index.ts`: the coordinator's task tools.

Select their actual installed paths in the picker; a local checkout and a Git installation are different entries.
Preserve your other selections rather than enabling every extension.
Keep tasks session-scoped (`taskScope: "session"`), without a shared `PI_TASKS` override.
Each coordinator needs its own task list outside the reviewed repository. Missing required tools block setup.
Pi extensions have full local access; inspect the source before installing.

## Use

Run this from the codebase you want reviewed:

```text
/code-review Check these changes against the retry contract.
/code-review https://github.com/owner/repo/pull/123
```

Agents can also call `agentic_code_review` with plain-text context.
One coordinator establishes the problem, collects, traces deeper, assigns zones,
reviews, reconciles, then saves and reports. Intake questions return to your original conversation.

For a pull request URL the coordinator first pulls the PR itself through the provider's CLI (`gh` for github.com,
`gs` for Meteorite), read-only: the description becomes a requirement source, existing review threads and bot comments
become evidence to reconcile against rather than repeat, and the CI state with its required checks becomes a grading
input. The [PR context contract](prompts/pr-context.md) has the exact commands and record shapes.

## Collection and agent tiers

| Tier | Work |
| --- | --- |
| `write-critical` | One coordinator: scope, delegation, evidence reconciliation, and saved reports. No source edits. |
| `read-collect` | Initial inventory of requirements, tests, changed files/symbols, and review units. |
| `read-analyze` | Independent deep collection: follow connected behavior, guards, counterevidence, and impact. |
| `read-review` | Normal final review of a bounded responsibility zone and its tests/contracts. |
| `read-critical` | A specific high-stakes security, concurrency, architecture, migration, or data-correctness question. |

Tiers use the models/effort configured in teams; they are not severity grades.
Complexity (1–5) guides zone size and coverage, not a blanket upgrade to the strongest tier.
Collectors trace about three connections and record their stopping points and unresolved paths.

Optional: allow the `pi-agentic-search/index.ts` entry for child agents.
When available, the coordinator starts collection with one `sparsity_index` call over the exact diff:
changed definitions, their resolved calls, callers, tests, removed definitions with surviving callers,
and an explicit recap of unresolved edges, saved as a pack in the run directory. Workers read their anchors from it
and use `sparsity_collect` for one more definition when a zone needs deeper context.
Static candidates are not runtime proof.
Missing optional tooling remains an explicit coverage gap, not permission to install anything.

## Taste as the instrument

Reviewers do not find bugs by scanning for bugs. They notice the optional boolean, the stub in `setup`,
the rule living in a helper, the name that contradicts the flow, and follow it.
The [taste contract](prompts/taste.md) turns those observations into leads: what to notice, what to check,
what it usually hides, and how to ask. It was built from twelve months of the maintainer's review comments,
where one comment in four starts as taste and ends pointing at a defect.

A lead settles into a `bug` (with the `lens` that surfaced it), a `question` for the author,
a `nit`, or nothing. Taste alone never blocks; what it uncovers can.

## Reports and reusable knowledge

Every sentence written for a person follows the [voice contract](prompts/voice.md):
written first as one engineer would say it to another, then checked against the evidence.
The human summary takes about 20 seconds to read, at most 60.
It is a private draft and is never auto-posted. Source-linked findings include short explanations,
A–F ratings and available model/thinking provenance. Missing evidence is not a proven defect.
Actionable findings belong in source-line comments, not a general blocking PR body.
The [comment guide](prompts/pr-comments.md) requires explicit approval before inline posting; this package does not post.

Run evidence lives in the configured Pi agent directory's `auto-review/<session-id>/`.
Shared `structure.md`, `design.md`, and `framework.md` notes live in `auto-review/codebases/<codebase>/`.

## Measuring the pack

A pack whose manifest shows no truncation, no skipped production anchor and no unresolved edge inside a criterion's
anchor is the inventory: no collector runs and zone reviewers start at once. Otherwise the failing items form a closed gap
list for one collector that runs beside the reviewers, never in front of them.

Every final review JSON records `collection` (`pack`, `pack+gaps` or `diff-only`), `collectors` (how many collection
lanes ran) and, for pack runs, the `sparsity_index` metrics (build time, anchors, edges, unresolved rate, inline and
spilled tokens). Add the line `mode: diff-only` to a review's
context to skip the index on purpose. Compare a few runs of each kind with wall time and findings:

```sh
for f in ~/.pi/agent/auto-review/*/*.review.json; do
  jq -r 'select(.status == "complete") | [.collection, ((.completedAt | fromdateiso8601) - (.createdAt | fromdateiso8601)), (.findings | length), (.pack.unresolvedRate // "-")] | @tsv' "$f"
done
```

A lower wall time with the same or more accepted findings is the result to look for; a rising unresolved rate says
where the index needs another resolution rung.
Entries link to their review, revision, and sources. Later runs revalidate useful notes and append corrections.

For a requested re-review, the coordinator links the earlier assessment and reviews the fix plus affected boundaries.
It reuses revalidated evidence, reports prior findings' outcomes, and targets 15 minutes within a 20-minute budget.
This budget is prompt-directed, not an enforced deadline; missing evidence stays explicit.

## Experimental limits

This is prompt-directed behavior, not a deterministic reviewer or a sandbox.
Workers can fail; incomplete coverage is not approval. Merge/deployment grades authorize neither action.
The workflow forbids source edits, automatic retries, installs, publication, merges, and deployments.
Telemetry capture is currently disabled.
It does not train model weights or run an endless self-review loop.

See the [workflow](prompts/workflow.md), [evidence contract](prompts/artifacts.md),
[report format](prompts/presentation.md), and [coordinator instructions](prompts/coordinator.md).

## License

[MIT](LICENSE). Copyright 2026 Leonardo Pereira.
