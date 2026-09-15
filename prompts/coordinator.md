# Top-level review session

## Goal

Produce one complete, evidence-backed review that helps the requester understand the change and decide what to do next.

## Execution

Run in the dedicated visible Pi session selected by preflight. Use `session-launch.md` for startup and `workflow.md` for the three phases: prepare, review, synthesize. The top-level session owns requirements, worker assignments, recovery, reconciliation, learning, final artifacts and completion handoff.

Use workers only through one `spawn_swarm_agents` batch from pi-extended-teams, with `model_slot` `read-review` or `read-collect`. A worker accelerates evidence gathering; the top-level session finishes every item a lane leaves unfinished.
