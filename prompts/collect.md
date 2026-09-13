Use only the review instructions, stage prompts, and context supplied by `pi-auto-review`. Do not read other skills unless the user explicitly requests them in this session.

# Collect

Build the evidence inventory. Do not review the whole repository or announce a verdict. Reuse the supplied problem statement, criteria, revision and prior inspected evidence. A source search must state its scope and incomplete coverage.

## Read in this order

1. The request and linked requirement for the problem, not persuasion about the solution.
2. Changed and relevant existing tests as specifications. Map each acceptance criterion to positive, negative and regression evidence, or an explicit gap. Distinguish inspected tests from executed results.
3. The changed-file inventory, including deletions, renames, configuration, dependency and generated/binary changes. Classify mechanical files rather than silently skipping them. For removed behavior, identify callers that still depend on it.
4. Changed symbols and enough surrounding code to identify their responsibilities and direct connections.

For each changed Ruby/JS/TS method or scope, use `sparsity_collect` with its `path:line`, `max_depth: 3` and `vicinity_check: 20` to gather focused context. Calls inside the anchored method/scope drive traversal; nearby displayed methods do not. Keep node IDs, edge records, paths, fingerprints and coverage limits in the inventory; node IDs belong to that specific tool call, not the whole review. Ruby destinations are static candidates, not proven dynamic calls. Deduplicate overlapping results. If the tool/language is unavailable or coverage is partial, record the gap and use direct source inspection for the missing evidence; never install a parser or treat an unresolved edge as absent behavior.

## Record review units

For each coherent behavior, record its zone, paths and symbols, requirement IDs, current contract, changed behavior, relevant tests, direct callers/callees and other known dependencies. List the concrete checks needed before judging it. Keep an unrelated-looking change visible and ask what requirement justifies it within your report.

Record SOLID/design clues as hypotheses: mixed responsibilities, incompatible contracts, excessive knowledge of another layer, broad interfaces and hidden dependencies. State the possible consequence and what deeper inspection would settle it. A long file, `any`, broad rescue, callback or method name containing "and" is not proof of a defect.

## Hand off

Return records compatible with the artifact contract. Add a short humanReadable handoff and available source-linked reviewer provenance under the supplied presentation contract. Use rating: null for collection, not a readiness verdict; any submitted finding has its own A–F rating and short humanReadable field. Include exact source locations, what you inspected, what was unavailable, and which questions need deeper tracing. Cite source revision and distinguish facts from hypotheses. Do not copy whole files or secrets into the report.

The coordinator appends accepted records to the map. Do not edit shared review artifacts. If source evidence already confirms a bug, submit it through `agentic_code_review_append_finding` using the supplied session/run IDs, criterion/unit/source links and concrete evidence; return its generated ID. Use `fix` or `nit` only for useful nonblocking suggestions. Keep hypotheses in your report, not the bug handoff. If submission is unavailable or fails, report the missing persistence without a file-edit fallback.

Hand the next stage a list of unit IDs and unresolved connections so it can enrich the inventory without repeating discovery.
