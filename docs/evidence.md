# Optional evidence support

Source-only reviews remain valid. A review can add `evidenceGraph` and `evidenceContext` to make support dependencies and freshness inspectable at completion. This tracks recorded evidence; it does not scan the live checkout, establish requirement truth, or authenticate reviewer-authored facts.

## Graph

`evidenceGraph` has exactly `schemaVersion: 1`, `runId`, `nodes`, and `incompatibilities`. Every node ID must name an existing record in this run's map. Identical repeated records are allowed; conflicting reuse, cross-run records, dangling links and cycles are rejected. Append corrections with new IDs instead of changing earlier records.

Node shapes:

- `{ id, kind: "evidence" | "assumption", identities }`: a leaf with captured identity bindings.
- `{ id, kind: "support", dependsOn: [nodeId, ...] }`: all dependencies are required. A dependency is a leaf or claim, not another support.
- `{ id, kind: "claim", supports: [supportId, ...] }`: any fresh support suffices. One to four authored alternatives are allowed.

An identity is `{ kind, key, sha256 }`. `kind` is `source`, `config`, `fixture`, `environment`, `probe`, or `criterion`; `key` names its scope; `sha256` is a lowercase SHA256 or `null` when unknown. No duplicate kind/key bindings are allowed. Capture every dependency that matters; an omitted dependency cannot be invalidated automatically.

`evidenceContext` is `{ identities, scopes }`, containing the currently recorded identities and active scope names. Omission means no current identities or known scopes. Cite where those observations came from in the map; copying the old hashes is not revalidation.

An incompatibility is `{ supportId, scope, reason, sourceId }`. It explicitly disables the named support in that scope, with a map record as its source. If active scopes are unknown, it conservatively leaves that support unknown. This does not infer incompatibilities or enumerate ATMS environments.

Completion writes `evidenceAssessment` with graph, context and map hashes and each node's `fresh`, `stale`, or `unknown` status and reasons:

- Drift propagates through required dependencies; another independent fresh support can survive.
- Missing identities and withdrawn/unestablished records remain unknown.
- Stale or unknown support never becomes a false claim automatically.
- Freshness is relative to the recorded identities, not proof that the claim is true. Assumptions remain assumptions.

Limits: 256 nodes, 256 incompatibilities, 32 dependencies per support, 64 identities per leaf/context, 64 active scopes, and a two-MiB/4,096-record map. Exceeding a limit rejects the optional graph rather than dropping evidence silently.

## Machine-linked claims

A review can also supply `machineClaims`, at most 32 entries of exactly:

```json
{
  "claimId": "claim-id-in-the-graph",
  "kind": "execution",
  "requestDigest": "<runner request SHA256>",
  "receipts": ["<indexed receipt SHA256>"]
}
```

Use `execution` with one receipt or `target-replay` with two. A claim ID occurs once. References must come from this run's runner-owned index; supplied paths or receipt-shaped objects cannot replace it. Reference individual `trusted-program` or `docker-node-v1` attempts, not a family summary.

Completion rechecks receipt, request and captured-output identities and reparses the existing adapter's target outcome. It writes `machineAssessment`:

- `observed-pass` or `observed-target-failure` for an established execution outcome;
- `target-replayed` only for distinct attempts of the same request with the same normalized target failure;
- `unknown` when support is stale/unknown, execution is inconclusive, or a failing replay was not established.

Two passing attempts are not a failing replay. These statuses do not establish a requirement, historical origin, sensitivity, or a formal proof. Preserve those limits and the profile's trust boundary in the human report. Comparison/calibration interpretations still use their own existing receipts and reviewer reconciliation; this schema does not certify them.

`evidenceAssessment` and `machineAssessment` are completion-owned projections. Do not author them or repair runner files. Ordinary findings do not need machine evidence, and old completed artifacts are not rewritten merely because this feature exists.

## Duplicate execution and replay

The execution tool reserves a canonical key over the prepared request, oracle/plan identity and schedule before starting. An exact duplicate is rejected while active and after completion; it is never silently reused as fresh evidence. Different check names for identical inputs do not create another opportunity.

For a deliberate fresh check, pass its latest settled attempt ID as `replayOf` together with `checkId`. The request remains host-prepared and the existing attempt/wall/output budgets still apply. Concurrent replay requests cannot consume the same predecessor twice. Prepared families explicitly repeat attempts for trials, stability and reduction under the same rules.

Missing results, unconfirmed cleanup and late results remain fenced. Reservations live within one host-plan instance; the existing durable `.claimed` file prevents restart from refreshing authority. There is no cross-process recovery or automatic retry. A new reservation does not grant execution permission.

## Optional reservation-model check

`formal/ReservationOwnership.tla` checks one finite, handwritten model of reservation ownership and replay. Its separate event history checks `NoUnjustifiedReacquisition`; `TypeOK` checks state domains. The scope ledger records two keys, two callers, three tokens per key, clock values 0–3, deadlines 1–2, assumptions and exclusions. This has no TypeScript semantic frontend or refinement proof.

`src/reservation-model-check.ts` is a macOS host API, not a reviewer tool or an automatic completion step. A trusted host supplies independently approved SHA256 pins for `model`, `config`, `scope`, `source`, `java`, `jar` and `/usr/bin/time`, plus the Java runtime directory digest from `runtimeIdentity`. The four model inputs must match the bundled files. Provision the pinned TLC 1.7.4 toolchain separately; a supplied hash does not establish download authenticity.

Call `prepareReservationCheck({ approvedBy, expiresAt, maxRuns, outputDir, files, runtime })`, then `runReservationCheck(grant, mutation, signal)`. `files` contains the seven `{ path, sha256 }` pins; `runtime` is the directory's `{ path, sha256 }`. `maxRuns` is 1–3. Mutation defaults to `none`; `allow-active` and `ignore-replay` are labeled model sensitivity controls, not historical TypeScript defects. The host must separately authorize every real run. Do not create a fresh output directory to bypass an exhausted or ambiguous approval.

Runs use a private working directory, clean environment, one BFS worker, fixed seed/fingerprint, 128 MiB Java heap, a 60-second deadline (shortened by approval expiry) and 64 KiB combined output. The runner kills its private process group on cancellation or limits. `/usr/bin/time -l` measures peak process memory when it finishes; heap limits do not cap native memory. This is trusted local execution, not an OS sandbox or a machine-wide resource limit. The durable `model.claimed` marker prevents a new host instance from refreshing that directory's allowance.

`readReservationCheck(reference, plan)` rechecks current inputs, the runtime, adapter identity, receipt/output hashes and copied model/config bytes. Keep the original trusted plan and receipt reference. Changed identities reject rather than silently reinterpret old evidence. Complete TLC tool frames, nonempty initialization, exhaustion and successful termination are required for `bounded-model-checked`. A named violation with a finished trace yields `model-counterexample`; partial, contradictory, timed-out or cancelled execution stays `unknown`. The exact pinned GC-performance advisory (2401) is retained without discarding a completed result; other warnings still prevent a passing classification.

Every result remains `kind: "model-only"`, `codeLinkedProof: false` and `typescriptReplay: "not-attempted"`, with its bounds and assumptions. A counterexample needs a separate legitimate TypeScript replay before it becomes a code witness. These receipts are separate from `machineClaims`; source-only reviews still finish without a checker. P32's review-quality and maintenance-cost comparison remains unmeasured.

Pinned protocol sources: https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4 and https://raw.githubusercontent.com/tlaplus/tlaplus/5a47802b5c391f59ecdd44117981f4ff8c0656ba/tlatools/org.lamport.tlatools/src/tlc2/output/EC.java
