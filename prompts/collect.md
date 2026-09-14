Use only the review instructions, stage prompts, and context supplied by `pi-auto-review`. Do not read other skills unless the user explicitly requests them in this session.

# Collect

Your mission is one of two shapes. With a pack, it is a closed gap list: the coordinator names each unresolved edge, frontier definition, skipped anchor or other/generated file and the criterion it bears on, and you settle those entries and nothing else. Without a pack, it is the evidence inventory described below. Do not review the whole repository or announce a verdict. Reuse the supplied problem statement, criteria, revision and prior inspected evidence. A source search must state its scope and incomplete coverage.

On a gap list: read only the pack sections the entries point at, never the whole pack; do not re-verify anything the pack states (definitions, edges, callers, tests are already evidence with their labels); do not open generated schema dumps, lockfiles or vendored code unless an entry names that file; stop after the list is settled or after twelve file reads, whichever comes first, and report the rest as unsettled with what would settle it. Your report is one line per entry: settled or unsettled, the evidence, the label you would give the edge now. Zone reviewers are working beside you and do not wait for you.

When the coordinator supplies a `sparsity_index` pack, start from it: read the manifest, then the anchor sections for your units, then spilled sections by line range only when a unit needs them. Treat its anchors, edges, callers, tests, dangling definitions and recap as the first inventory. The pack reads the changed files at the range head even when the checkout sits elsewhere; its manifest says so in a `revision:` line. Do not re-read changed files with `git show <head>:<path>`, the pack already holds that content; use `git show` only for a file the pack does not cover and only when the manifest shows the checkout differs from the head. Your work is what the pack cannot do: follow unresolved edges that bear on a criterion, read files it listed as other or generated, check contracts that static name resolution cannot see, and record what you inspected versus what you inherited from the pack.

## Read in this order

1. The request and linked requirement for the problem, not persuasion about the solution.
2. Changed and relevant existing tests as specifications. Map each acceptance criterion to positive, negative and regression evidence, or an explicit gap. Distinguish inspected tests from executed results.
3. The changed-file inventory, including deletions, renames, configuration, dependency and generated/binary changes. Classify mechanical files rather than silently skipping them. For removed behavior, identify callers that still depend on it.
4. Changed symbols and enough surrounding code to identify their responsibilities and direct connections.

For each changed Ruby/JS/TS method or scope, use `sparsity_collect` with its `path:line`, `max_depth: 3` and `vicinity_check: 20` to gather focused context. Calls inside the anchored method/scope drive traversal; nearby displayed methods do not. Keep node IDs, edge records, paths, fingerprints and coverage limits in the inventory; node IDs belong to that specific tool call, not the whole review. The tool searches the nearest component root; when an edge says a constant or module is outside that root and the dependency matters to a criterion, call it again with a wider `root` (the area or repository root) for that one anchor instead of reading files by hand. Read each edge's two labels, `[resolution, how]`: `checker`, `typed`, `self`, `lexical`, `constant`, `import` and `same_file` edges are reliable static facts; `assigned` and `ivar` are inferred; `named` and `name_only` are guesses to confirm; `external` is outside the root; `local` is not a gap; `unresolved` is a gap with a reason. No static edge is proof of a runtime call. Deduplicate overlapping results. If the tool/language is unavailable or coverage is partial, record the gap and use direct source inspection for the missing evidence; never install a parser or treat an unresolved edge as absent behavior.

## Record review units

For each coherent behavior, record its zone, paths and symbols, requirement IDs, current contract, changed behavior, relevant tests, direct callers/callees and other known dependencies. List the concrete checks needed before judging it. Keep an unrelated-looking change visible and ask what requirement justifies it within your report.

Record leads from the supplied `taste.md` as hypotheses on each unit: optional booleans and inputs, stubs that hide behavior, rules living away from their owner, positive-only tests, writes without a transaction, names that contradict the flow, repeated lookups, mixed responsibilities and hidden dependencies. State the possible consequence and what deeper inspection would settle it. A match is a lead, not proof of a defect.

## Hand off

Return records compatible with the artifact contract. Add a short humanReadable handoff, written under the supplied `voice.md`, and available source-linked reviewer provenance under the presentation contract. Use rating: null for collection, not a readiness verdict; any submitted finding has its own A–F rating and short humanReadable field. Include exact source locations, what you inspected, what was unavailable, and which questions need deeper tracing. Cite source revision and distinguish facts from hypotheses. Do not copy whole files or secrets into the report.

The coordinator appends accepted records to the map. Do not edit shared review artifacts. If source evidence already confirms a bug, submit it through `agentic_code_review_append_finding` using the supplied session/run IDs, criterion/unit/source links and concrete evidence; return its generated ID. Use `fix` or `nit` only for useful nonblocking suggestions. Keep hypotheses in your report, not the bug handoff. If submission is unavailable or fails, report the missing persistence without a file-edit fallback.

Hand the next stage a list of unit IDs and unresolved connections so it can enrich the inventory without repeating discovery.
