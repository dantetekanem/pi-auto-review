# Bounded execution batches

A schema2 host plan without a `family` may set `workers: 1` or `workers: 2`. Omission keeps serial execution. The reviewer cannot change this setting. Trusted-host checks and calibrated families remain serial.

Call `agentic_code_review_execute_experiment` with `sessionId`, `runId` and `checkIds: ['first', 'second']`. These must be distinct IDs from that plan, with distinct canonical inputs. Do not combine `checkIds` with `checkId`, `familyId` or `replayOf`. One batch is allowed per plan, including an inconclusive batch; individual checks retain their existing attempt caps and explicit replay rules.

## Scheduling and resources

The host executes fixed waves in the supplied order. Each wave waits for every worker to settle before reusing its slots. Results retain input order, regardless of completion order. Cancellation or a rejected worker stops later waves and requests cancellation of peers, then waits for their cleanup paths. A late result remains recorded; it does not turn a cancelled batch into success.

Each restricted admission reserves its full time/output allowance against the shared cumulative budget, including allowances held by other active workers. Settlement requires that admission's private lease. A repeated or foreign lease cannot release another worker. Unconfirmed cleanup fences the grant even when a different worker later cleans up successfully. `maxWallMs` accounts for summed attempt duration, not batch elapsed time; cleanup overhead may exceed a workload deadline and is charged afterward.

Worker slots use separate durable `.active-0` and `.active-1` guards. Serial execution retains `.active`. Existing guards are never removed to retry. Each attempt also has a private bundle, scratch namespace, container name and receipt directory. No mutable database, service or port is shared. Two active containers may reserve up to two CPUs, 1 GiB of memory and 128 tasks under the existing per-container limits; this is a per-plan cap, not a machine-wide scheduler.

The host indexes one `experiment-batch-v1` summary alongside individual attempt receipts. It records worker count, peak occupied slots, started jobs, elapsed time and settled/unresolved/unstarted outcomes. These are execution observations, not CPU-time measurements, review-quality results or requirement truth. Interpret target outcomes from the individual verified receipts. A summary marked `completed` means its jobs settled, not that every target passed.

The existing `.claimed` fence prevents restart or another process from refreshing the plan. Missing results, changed ownership or failed receipt publication require reconciliation, not automatic retries. This remains trusted host bookkeeping; the Pi session and malicious same-user processes are outside the restricted worker boundary.

P27's controlled review-quality/cost comparison has not run. The focused serial/parallel integration check demonstrates compatible observations and separate resources for two approved checks only. It does not establish general speedup, cost savings or additional reviewer-round policy.
