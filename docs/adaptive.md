# Optional adaptive retrieval

The fixed initial scan and one reviewer batch remain the default. An explicitly selected adaptive review can use `agentic_code_review_next_action` during top-level reconciliation. No quality or cost improvement has been measured; P25 remains a separate, gated comparison.

The tool records named missing facts, recommends one collect/search/prepared-family action, and accepts its coarse result. It never launches a tool, model, process or extra reviewer. Existing execution grants, canonical experiment reservations and cumulative runner budgets still apply.

## Inputs and identity

Call `status` with the prepared session/run IDs to obtain `contextId`. It hashes recorded preflight metadata, requirement/criterion map records and `evidenceContext`. This detects recorded drift, not live filesystem changes. Capture changed source/configuration/environment identities before supplying another observation.

For the first `observe`, declare a frozen `{total, collect, search, family}` recommendation budget. Each count is between zero and 128; the total caps selected actions. Later calls can repeat the same limits but cannot refresh them. The journal allows 32 named facts and 128 observation events. These are bookkeeping limits, not additional command or spending permissions.

An observation contains:

- `id`: an event ID unique within this run;
- `contextId`: the context under which the work was requested;
- `question: {criterionId, scope, question, material}`: a map-linked requirement/criterion, repository-relative scope and concrete missing question;
- `source: {kind, sha256, path?}`: `scan`, `collect`, `search` or `execution` evidence;
- `actionKey`: present when returning a selected action's result.

For scan/collect/search, save the actual structured result under the session artifact directory with a run-prefixed path, for example `<runId>.context/pack.json`. Supply its byte hash. The adapter consumes the documented `pi-agentic-search` pack JSON or CLI `{text,details}` boundary, checked against version 0.7.1. Missing or incompatible fields stay `unsupported-input`. Native tool display text is not parsed. Frontier strings are opaque; their presence remains a coverage gap even with zero unresolved edges. Call-local node IDs are used only to resolve locations within that input and never become fact keys. Recorded 16-character definition fingerprints are hints, not full source identities.

Execution observations use only an indexed receipt hash, without a supplied path. Receipt identity is rechecked; this bookkeeping does not replace completion's request/output verification. A selected family requires its matching indexed family summary, not an individual generated trial. Passing observations, setup failures and static resolution never establish requirement truth. Each fact stays unknown until the reviewer supplies a source-backed interpretation in ordinary review artifacts.

## Selection and result handling

Candidates reference returned fact IDs:

- `{kind:'collect', factId, target:'path:line'}`
- `{kind:'search', factId, query, path}`
- `{kind:'family', factId, familyId}`

The pure policy considers current material facts, prefers collection before scoped search before a family, and breaks ties by canonical request identity. The existing execution controller supplies eligible family IDs without issuing a grant or starting work. Setup failures, unsupported inputs and unsettled execution outcomes cannot automatically trigger another family.

Selection spends one total unit and one kind-specific unit. Identical requests cannot be selected again under the same recorded context, even for different questions. A saved pending recommendation survives reload. Until its result arrives, `wait-unknown` forbids another selection or an ambiguous retry. Submit one coarse result per named check or completed family, not a model turn per generated trial.

Identical event retries are idempotent; conflicting reuse is rejected. Results bind to the selected question, kind and original context. Late results cannot replace a newer observation; stale results cannot replace current evidence. Their references remain in the journal. Missing results remain pending rather than being silently retried. `stop-unknown` reports unestablished facts, not success.

The tool owns `<runId>.adaptive.json`, uses the SDK file-mutation queue and atomic publication, and binds writes to its first coordinator. Preserve this journal and cite material gaps in final reconciliation. It is trusted control-plane bookkeeping, not protection against a malicious same-user process or a reviewer editing its own files. Source-only completion remains unchanged.
