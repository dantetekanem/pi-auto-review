Use `agentic_code_review_subscribe` only when an external Pi session has already prepared a review and its exact review session ID, run ID, target, and head are known. This subscription checks the saved review identity and sends one bounded handoff to this session when a matching completed review marker arrives.

It does not prove that this session started the review or that the review is relevant to the current work. The caller is responsible for that decision. Do not use it for a same-session `/code-review`; that review already has its own native watcher. A missing, malformed, failed, or timed-out review ends with a failure handoff instead of a successful review result.

Choose timeoutMinutes from 1 to 60 (default 30). After successful registration, if no other authorized task can advance, call task_wait alone with the receipt's runId as reviewRunId. Registration alone does not pause task continuation. Do not create an unrelated subscription to qualify, arrange an additional scheduler/manual ping, or automatically re-register an ended wait.

Registration is runtime-only and cleared on reload, session replacement, tree navigation or shutdown. Pi must remain running. This tool does not launch or modify a review, prove its runner is healthy, complete a business task, or authorize publishing. Read and reconcile the saved report when it arrives.
