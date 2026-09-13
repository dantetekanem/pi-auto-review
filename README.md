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
When available, its `sparsity_collect` tool gathers bounded Ruby/JS/TS call context with ±20 lines at each anchor.
Deep collectors and reviewers reuse unchanged snippets/fingerprints; static candidates are not runtime proof.
Missing optional tooling remains an explicit coverage gap, not permission to install anything.

## Reports and reusable knowledge

The human summary gets two writing passes: about 20 seconds to read, at most 60.
It is a private draft and is never auto-posted. Source-linked findings include short explanations,
A–F ratings and available model/thinking provenance. Missing evidence is not a proven defect.
Actionable findings belong in source-line comments, not a general blocking PR body.
The [comment guide](prompts/pr-comments.md) requires explicit approval before inline posting; this package does not post.

Run evidence lives in the configured Pi agent directory's `auto-review/<session-id>/`.
Shared `structure.md`, `design.md`, and `framework.md` notes live in `auto-review/codebases/<codebase>/`.
Entries link to their review, revision, and sources. Later runs revalidate useful notes and append corrections.

For a requested re-review, the coordinator links the earlier assessment and reviews the fix plus affected boundaries.
It reuses revalidated evidence, reports prior findings' outcomes, and targets 15 minutes within a 20-minute budget.
This budget is prompt-directed, not an enforced deadline; missing evidence stays explicit.

## Experimental limits

This is prompt-directed behavior, not a deterministic reviewer or a sandbox.
Workers can fail; incomplete coverage is not approval. Merge/deployment grades authorize neither action.
The workflow forbids source edits, automatic retries, installs, publication, merges, and deployments.
Telemetry capture is currently disabled. The [automatic telemetry plan](docs/automatic-telemetry-plan.md)
requires runtime hooks in the companion packages; the manual prototype is not registered or sent to agents.
It does not train model weights or run an endless self-review loop.

See the [workflow](prompts/workflow.md), [evidence contract](prompts/artifacts.md),
[report format](prompts/presentation.md), and [coordinator instructions](prompts/coordinator.md).

## License

[MIT](LICENSE). Copyright 2026 Leonardo Pereira.
