Use only the review instructions, stage prompts, and context supplied by `pi-auto-review`. Do not read other skills unless the user explicitly requests them in this session.

# Deep-collect

Consume the accepted inventory and explain the changed behavior's connected impact. This stage uses different agents from initial collection. Do not restate the diff or turn a search hit into an assumed call graph.

With a pack, your mission is a closed list of entries that need a trace past the pack's depth: an async hop, a host/engine boundary, a dynamic dispatch, a contract a criterion depends on. Trace those entries and nothing else, from the pack's frontier, never from the diff again; stop after the list is settled or after about three hops per entry. Zone reviewers work beside you and do not wait for you; your report is reconciled after theirs.

Reuse the index pack and the collection's `sparsity_collect` node/edge evidence, and check their source fingerprints and limits. The pack's depth-2 signatures and frontier tell you where its tracing stopped; start your hops there. For an uncovered or changed Ruby/JS/TS method/scope, call `sparsity_collect` with `target: path:line`, `max_depth: 3` and `vicinity_check: 20`. Do not repeat an identical traversal just to generate another report. For an edge reported as outside the component root, widen `root` for that anchor when the dependency matters; otherwise record it as the boundary. Follow unresolved or ambiguous edges with direct source evidence; static candidates and depth stops do not prove runtime reachability or complete coverage. If the tool is unavailable, report that limitation and continue authorized inspection without installs.

## Trace from each review unit

Treat the changed symbol as depth 0. Investigate about three relationship hops in both directions, unless an evidenced contract gives a sound earlier stopping point. Read the actual definition of a called method, its important branches, and callers that depend on its result. Follow behavior, not merely matching names.

Relationships include calls/called-by, imports, inheritance/mixins, routes, callbacks, events/consumers, job retries, shared data reads/writes, configuration and feature flags, transaction boundaries, authorization and external side effects. Include unchanged code when it determines the change's consequences.

For each connection, record source and target, relationship, depth, evidence, changed assumptions and observable impact. Mark static resolution, runtime evidence and unresolved dynamic dispatch honestly. A text reference does not establish runtime reachability.

Keep a visited set keyed by repository/revision/symbol. Record cycles without expanding them forever. At high-fanout boundaries prioritize the changed contract and affected consumers; account for the remaining frontier explicitly. Do not quietly sample and claim complete coverage.

Three hops is an exploration budget, not a correctness guarantee. Go further when a concrete question could change the verdict, especially across permissions, money, data, retries or rollback. Record why extra depth is needed. If the run's budget cannot settle it, preserve the unresolved path for grading rather than guessing or asking the user mid-run.

## Explain consequences

- Which assumptions about input, output, state, timing, error handling or permissions changed?
- Which callers or consumers still depend on the old behavior?
- Does a guard, test, framework contract or external control actually protect the path?
- Does success followed by failure leave a retryable or irreversible side effect?
- Does the connection help solve an acceptance criterion, or expose an unrelated change?
- For each `taste.md` lead the inventory recorded: who owns the rule this code applies, where the optional value is produced and who passes nil, whether the stubbed collaborator has callbacks or validations, what the off path does, what a retry or a second caller does.

Check counterevidence before promoting a suspicion. Existing tests may settle a question, but only if they exercise the contract instead of mocking it away. Preserve useful negative results with their searched boundaries.

## Hand off

Return new edges, evidence and corrections linked to existing unit/requirement IDs. Add a short humanReadable handoff, written under the supplied `voice.md`, and available source-linked reviewer provenance under the presentation contract. Use rating: null for the handoff, not a readiness verdict; submitted findings have their own A–F ratings and short humanReadable fields. Each unit needs a coverage record: inspected paths, maximum observed depth, stopping reasons, unexplored frontier and remaining decision-changing questions. Name what final reviewers can reuse and what still requires judgment.

Submit source-backed confirmed bugs through `agentic_code_review_append_finding` with the supplied session/run IDs, criterion/unit/source links and concrete evidence. Return its generated IDs with your traces. Useful optional fixes/nits use their own nonblocking classification. Do not commission another agent merely to reconfirm proven evidence. Keep unproven suspicions in the report with the proof needed to settle them.

Never read-modify-write shared review artifacts. The extension owns finding writes; the coordinator owns the map and final review. If the submission tool is missing or fails, report the persistence gap without falling back to file edits.
