# Automatic review telemetry: deferred plan

Status: planned, not implemented. The user deferred the cross-package changes on 2026-09-13. Future implementation and publication in the companion repositories require fresh authorization.

The production review entry point does not register telemetry. Agents receive no instrumentation instructions or manual step tool. `src/telemetry.ts`, its isolated tests, and the unused `prompts/step.md` template remain a prototype for the metric/privacy contracts below; they are not active review capabilities.

## Goal

Measure each review step automatically: elapsed time, provider requests, first streamed delta/text latency, token usage, reported cost, tool durations and failures. Instrumentation must not depend on an agent reading a telemetry prompt, calling a telemetry tool, repeating its identity, or supplying telemetry metadata.

Normal review work still uses the seven stage tasks. The runtime must own the link between those task IDs and review stages. If normal task transitions are also to be removed, that requires a separate executable review workflow; existing hooks cannot infer an agent's cognitive phase.

## What the inventory established

These are source observations from Pi 0.85.1 and the companion checkouts, not implemented integration APIs. Revalidate the named functions and event payloads before coding.

| Boundary | Existing behavior | Missing piece |
| --- | --- | --- |
| `pi-auto-review/src/index.ts`: `prepareReview`, `requestCoordinator` | Creates a unique review UUID and invocation session before one correlated teams launch. Metadata includes the run, session and artifact paths. | A runtime-owned registry connecting that launch to actual child sessions and stage tasks. |
| `pi-extended-teams/extensions/agents/read-agent.ts`: child setup | Creates a separate child event bus, loads extensions, creates the actual SessionManager, binds extensions, then prompts the child. | Authoritative child context available before extension binding and the first provider request. |
| `pi-extended-teams/extensions/tools/team-tools.ts`: orchestration and nested spawn | Retains Member metadata and parent lifecycle identity. Restricted nested spawn does not accept model-supplied metadata and uses an outer context. | Freeze the parent's runtime-owned stage at request acceptance, including queued work. |
| `pi-solid-tasks/src/task-store.ts`: `withLock`, `createInBatch`, `update` | Commits store mutations independently of tool response rendering; batch previews use an isolated store. | Committed-change observation and an initialized-store snapshot/request interface. |
| `pi-solid-tasks/src/index.ts`: store resolution and task handlers | Can upgrade a placeholder store when session context arrives. A successful commit can be followed by a failing response-rendering step. | Stable list/store identity and observation after initialization, including UI mutations. |
| Pi extension lifecycle/provider hooks | Supply actual session identity, provider/message/tool events and shutdown. Each event bus is local to its resource loader. | They do not identify review stages or logical review completion. |

The existing teams child-lifecycle probe reports running/queued child counts, not review ownership. Free-form agent progress, task titles, tool completion and model tiers are not authoritative stage signals. Event-bus `emit()` does not await asynchronous handlers.

## Proposed design

These seams are proposals. Do not code against their existence until the owning packages provide them.

### 1. Runtime-owned stage tasks

Add a narrow initialized-store request/snapshot interface in `pi-solid-tasks`, plus committed mutation notifications. Include actual session and list/store identity. Notify after a successful commit, even if later UI or handoff rendering fails. Do not emit preview mutations or expose mutable store objects.

The review runtime creates the seven normal stage tasks and retains their returned IDs in extension-owned state. Map `(review UUID, coordinator session, task-list identity, task ID)` to stage 1–7. Agent-editable task metadata, names and creation guesses must not define that mapping. Preserve normal dependency/ownership checks rather than bypassing task rules.

Subscribe before seeding and reconcile a snapshot afterward. Handle initialization replacement, duplicate notifications, deletion and repeated transitions explicitly. Start stage 1 at coordinator readiness; use committed mapped task transitions for subsequent boundaries. No active mapped stage means unattributed coverage, not a guessed default.

### 2. Child identity before the first request

Add a narrow teams child-runtime context probe before `bindExtensions`. Supply immutable runtime-owned agent/lifecycle identity, actual child session ID and validated parent/review binding. Match it to the original registered review launch; arbitrary spawn metadata alone is not proof of membership.

The child review extension binds its private stream during session startup, before provider requests. Keep provider/tool observers in that child's extension instance. The parent must not duplicate the child's events or assume its event bus receives them.

At nested request acceptance, read the parent's mapped stage through a trusted runtime callback and freeze it with the queued request. Do not re-read the parent's later stage when the child eventually starts. Keep lifecycle IDs and actual session IDs distinct.

### 3. Lifecycle and coverage

Use teams-owned admission and terminal notifications for queued, cancelled, failed-before-start and completed workers. A worker that never creates a session has no provider stream or actual session ID. Record that lifecycle coverage in a parent-owned stream rather than inventing child metrics.

A provider loop ending, `agent_settled`, an acknowledgement or a completed badge does not prove a review assessment was delivered. Keep operational completion separate from reviewed/partial/unable evidence. A shutdown may be reload or interruption rather than logical completion.

Specify resume/fork behavior before implementation. Do not silently reuse a binding across sessions or pretend a new observer recovers events that happened before capture. A bounded first-launch implementation may explicitly report resumed/forked capture as unsupported.

### 4. Reuse the metric contracts

Replace the prototype's manual binding and stage calls with trusted runtime inputs. Retain these existing, focused-test-backed semantics:

- First nonempty thinking, text or tool-argument delta is a client-observed TTFT proxy; record first text separately.
- Count final assistant usage/cost once per message. Whole-request output tokens per second is not pure decoding speed.
- Snapshot stage ownership when each request/tool begins. Overlapping tools have independent spans.
- Missing or unmatched observations remain null/unavailable. Do not infer provider-internal retries from hook counts.
- Capture queue/startup durations only when their owner records the actual boundaries; otherwise leave them unavailable.
- Record interrupted/open spans honestly. Abrupt termination may leave an unfinished stream.
- Persist only identity, timing, status, usage and error metadata. Never write prompts, content, headers, tool arguments or results.

Keep streams private, uniquely scoped and outside the reviewed repository. Surface persistence failures through runtime-owned coverage/receipts, not a later agent tool call or an instruction asking the model to diagnose instrumentation. Telemetry must not become a new scheduler or change review results.

## Implementation sequence after approval

1. Revalidate Pi and companion versions, extension isolation, current store initialization, and the exact lifecycle/finalizer paths. Preserve unrelated changes.
2. Define the minimal typed task snapshot/commit and teams identity/admission/terminal contracts. Add focused failing tests before each implementation; no review-specific behavior in generic companion APIs.
3. Build one automatic coordinator-stage capture slice, then add worker stage inheritance and queued/failed lifecycle coverage. Integrate through the existing scheduler and task store.
4. Verify privacy, concurrency and failure attribution. Obtain an independent review of the runtime/data-correctness delta before any publication.
5. Publish compatible companion changes only with explicit permission, document required versions, then enable automatic capture in `pi-auto-review`. Remove the manual prototype/template once its useful metric coverage has moved to the new path.

## Acceptance evidence

- A simulated runtime creates a review and executes all seven mapped stage transitions without any telemetry tool call or model-authored telemetry metadata; the resulting spans carry the correct IDs and durations.
- Actual child-session binding occurs before the first provider request. A worker queued during stage 2 keeps stage 2 after the coordinator advances.
- Two concurrent reviews and their children cannot share streams, stage mappings or task lists. Forged metadata and mismatched lifecycle/session identities do not bind capture.
- Both memory and file-backed task stores emit only committed snapshots, including derived changes; batch previews and failed writes emit no successful commit. A post-commit rendering failure does not hide the commit.
- Duplicate events, task deletion, store replacement, resume/fork and shutdown produce the documented bounded outcome without replaying spans or inventing success.
- Cancelled or failed-before-session workers have lifecycle evidence and no fabricated session/provider metrics.
- Existing timing/null/overlap/usage behavior remains covered. Privacy sentinels in every excluded payload field never reach telemetry storage.
- Storage failure is observable without asking an agent to call another tool. Runtime failure does not automatically become a source-code blocker.
- A real extension-loader integration confirms the intended public tool catalog. Inspect delivered prompts directly for instrumentation instructions; do not add source-string tests for prose.
- A separately authorized isolated live-host check confirms ordering and attribution before claiming live coverage. Do not install, reload, launch reviews or publish merely to complete this plan.
