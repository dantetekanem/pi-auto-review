# Auto-review runtime

## Goal

Return one complete, decision-ready code review. The requester sees the change, the judgment, every proposed comment, the evidence limits, process conditions and reusable team learning. Internal helper and runtime recovery never becomes client work.

## Inputs

- Review context: PR URL or local change, plus optional direction.
- Current Pi model and effective thinking level. Preflight preserves that level when a selected model supports it. A medium review can choose a medium-capable model; high and xhigh require an exact-level model.
- Local checkout. Preflight reuses the newest matching reviewed checkout or the caller-supplied path.

## Preflight

1. Resolve provider, PR title, base/head and local checkout.
2. Fetch a missing named ref without checking it out. If the object remains unavailable, save the provider patch for diff-only review.
3. Fetch PR body, threads/comments and CI into run-scoped files. Record unavailable optional inputs as gaps.
4. Validate model and the requested thinking level.
5. Show target, range, checkout, model, thinking and artifact path.
6. Start the mission. `agentic_code_review` starts a dedicated Pi session in a new Herdr pane; if pane launch fails twice, it runs the same mission in a headless Pi process. `/code-review` sets the current session to the preflighted model and thinking level and sends the mission there as a user message; no pane or watchdog is involved.

## Pack

Call `sparsity_scan` once with the exact range and no root override. The pack supplies:

- production anchors and resolved call edges;
- representative test anchors plus grouped tests;
- callers and tests by name;
- changed schema, JSON, YAML and generated-file hunks;
- dangling definitions, unresolved edges and frontier;
- component roots and scan metrics.

If scanning is unavailable, continue from the saved provider patch or one local diff. The scan accelerates review; it is not a completion dependency.

## Review batch

Call `spawn_swarm_agents` from pi-extended-teams once with:

- `completion_group: { delivery: "all-settled" }`;
- at most two `read-review` lanes;
- at most one `read-collect` lane for a closed list of criterion-bearing gaps;
- `model_slot` per lane; the configured tiers run both at `medium`;
- a fixed header per lane: run-local paths of its contract, `taste.md`, `voice.md`, `pr-comments.md` and `presentation.md` from `review.json.prompts`, the session/run IDs, repository, revision and pack path;
- exact unit IDs, pack section ranges and assigned questions;
- `defaults.cwd` set to the reviewed checkout.

Prepare copies the lane prompts to `<run>.prompts/` so each run freezes the text it used. A lane missing a path calls `agentic_code_review_read_prompt` by name; it never searches for prompt files.

End the turn after spawning. The grouped report resumes the session with every lane's full report and settlement state. A lane that ends partial, unable, blocked, failed, cancelled, interrupted or stopped leaves its assigned items unfinished; the top-level session completes those items directly. There is no lane retry or second batch. One `get_agent_status` snapshot is allowed; `check_teammate` follows a suspected stall and `stop_teammate` is only for a truly stuck lane.

## Synthesis

1. Finish every worker `unfinished` item through the shortest focused source check.
2. Reconcile each requirement against implementation, tests, connected impact and counterevidence.
3. Settle every submitted question and dangling definition.
4. Grade code. CI, stack order, approvals and deployment are process conditions, not rating inputs.
5. Render the decision-first report and every proposed comment.
6. Save current/delta codebase learning, including decisions and methods.
7. Write final artifacts as `complete` and call `agentic_code_review_complete`.

## Recovery

- Model mismatch: ask for the preflighted model and thinking level in the visible pane and resume.
- Provider input unavailable: use the available metadata/patch and ask once only when a decision-changing input is required.
- Scan failure: review diff-only.
- Lane failure or stop: top-level session completes its assigned items.
- Session exits without a marker: parent watchdog resumes a pane session; if unavailable, launch one fallback session. A `/code-review` run in the current session has no watchdog; the user resumes it by asking.
- Herdr unavailable: use the headless review session.
- Parent reload: reattach to durable completion markers and deliver each handoff once. Pane runs without a marker get a fallback session; current-session runs only get their watcher back.

Timing records measure preflight, pack, review and synthesis so later work can improve them. Timing never stops work or changes status or grade.

## Outputs

- Complete review JSON and bug/finding handoff.
- Evidence map and pack artifacts.
- Every proposed inline comment in the initial presentation.
- Codebase current/delta notes for continuity.
- One idempotent completion marker that wakes the invoking session.
