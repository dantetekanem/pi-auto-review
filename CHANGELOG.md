# Changelog

## 0.7.0 (2026-10-30)

### Added

- Optional evidence support graphs, recorded-identity freshness and receipt-linked execution observations. Completion verifies indexed receipt and output identities; fresh support is not proof of correctness.
- Budgeted adaptive retrieval recommendations and host-approved restricted batches with up to two isolated workers. The default review workflow stays fixed, and recommendations grant no execution authority.
- Four historical replay cases, an independent-judgment scorer and a bounded recorded-evidence benchmark runner. Both pilot variants found 2/2 known defects; full policy comparisons remain unfinished.
- A pinned, host-only TLC adapter for a finite reservation-ownership model. Results are model-only, not TypeScript correctness proofs.
- Per-run `model` and `thinking` options for `agentic_code_review`, validated before launch without changing caller settings or configured worker tiers.

### Changed

- Duplicate experiments are rejected. A fresh replay must identify the latest settled attempt with `replayOf` and still consumes the existing execution budget.

### Fixed

- Completing a review no longer forces a feedback-menu pause in the calling session. Previously authorized work continues; posting, merging and publication still require their own authorization.

## 0.6.0 (2026-10-27)

### Added

- Opt-in `agentic_code_review_execute_experiment` tool for host-prepared checks, pinned inputs, limited execution grants, fresh replay and runner-generated receipts attached to completed reviews. Trusted programs run with host privileges and direct-child-only cleanup.
- Restricted Node execution in disposable Docker containers with no network, read-only inputs, resource limits, protected receipts and no fallback to host execution. The first adapter exercises the committed finding-submission handler; it does not sandbox the Pi review session or support arbitrary repositories.
- Calibrated, seeded experiment families for optional findings, with JSON member-order checks, failure reduction, stability checks and fresh replay. Controls, trials and follow-ups share one execution budget; uncertain outcomes remain inconclusive. Host preparation is still required.

### Changed

- Reviews gather proof and prior project knowledge before examining production behavior and tracing future impact. Reports distinguish source inspection, executed checks, demonstrated test sensitivity and missing evidence.
- Review launches preserve configured tools, skills and context instead of supplying a fixed tool allowlist. Writing guidance uses available local skills rather than fetching instructions from the web.
- Removed the obsolete test that matched exact wording in review prompts; executable review and experiment tests remain.

### Fixed

- Automatic review recovery waits for five quiet minutes, rechecks activity and permits at most one follow-up per run. Reloading does not relaunch a missing review agent or retry an uncertain delivery.

## 0.5.2 (2026-09-16)

### Changed

- The report is the whiteboard. `presentation.md` now exists so the reader can be pulled aside and explain the system this change ships and defend its decisions, without line-level recall. The report opens with a 30-second version a person could say aloud, then draws the system in words, then answers why this and not that, who can hurt it and what stops them, what carries the state and why that shape, and where it fails and how anyone would know; the read, the fixes, the comments and the record follow. Every whiteboard sentence carries `verified`, `inferred` or `unknown`, and an unknown becomes a question to the author. Scope is stated once: customer-facing work gets the whole whiteboard; a proof of concept, demo, experiment or spike gets the 30-second version, the defects, and a flag when it touches a customer path. The 500-word ceiling stays; comment blocks still do not count.
- The report is prose, not a form. The order of content is fixed, the shape is not: no mandatory headers or bullets, sections of uneven length, nothing written to occupy a section. `voice.md` gains a Slop section that follows the anti-slop directive (https://github.com/jalaalrd/anti-ai-slop-writing) and its banned list: no template rhythm, no parataxis or uniform sentence length, no rule of three, bullets only for lists, active voice with a named subject, at most one em dash, specifics over adjectives, one sentence for the counterpoint. Runtime words (`criterion`, `bounded`, `material`, `reconcile`, `surface`) join the table of words never shown to a person.
- The final review JSON carries a `whiteboard` block (`scope`, `scopeSource`, and `{ text, state }` for `system`, `decisions`, `threat`, `data`, `failure`); zone assessments contribute their part, submitting an unknown as a `question`. Choice 4 after the report is "Pull me aside".

### Fixed

- Reloading Pi re-sent the completion handoff of an already delivered review. The delivered-once check looked for a `message` entry with role `custom`, but Pi stores `sendMessage` output as a `custom_message` entry, so the check never matched and every `session_start` re-delivered the marker. The check now reads `custom_message` entries, and the test fixture stores entries in that shape so the reload test fails on the old code.

## 0.5.1 (2026-09-16)

### Added

- `prompts/craft.md`: the pass that runs after the taste lenses in every zone and turns what the reviewer knows into feedback the author can use. It follows the maintainer's method in order (own the outcome, problem first, tests as the spec, design, smells and vicinity, ask yourself, inspect, be reasonable, write the comment) and defines what the pass produces: a `fix` as a proposal with code and one line on what it buys, a receipt on every behavior claim (what was run, read or counted) or a `question` instead, a question for the proof only the author can give, one teaching sentence per non-obvious mechanism, concessions and fast-follows said out loud, rare labeled nits, and what is good. Built from 2,059 of the maintainer's review comments over twelve months (GitHub and Meteorite): 15% show the change as code, 20% teach the mechanism, 7% carry proof, 10% ask for it, 5% concede with a fast-follow.
- Lanes receive `prompts.craft` in their header; `agentic_code_review_read_prompt` accepts `craft`; prepare copies it to `<run>.prompts/`.
- The zone report carries one `craft` line with counts of proposals with code, receipts, proof questions, teaching sentences, concessions and nits. A zone with production code and no craft output is `partial`.
- The review session calibrates before grading: every behavior claim keeps its receipt or becomes a question, every `fix` keeps its code block, an all-bugs-no-questions zone gets a second look. `methods` learning records which receipt settled a question fastest and which mechanism had to be taught.
- Report gains a "What is good" section; "What to fix, ask or improve" separates blockers from fast-follows; "How I looked" lists the receipts behind the claims.

### Changed

- A `fix` comment is a proposal, not a nit: it opens with the observation and an intro line, then the proposed code in a fenced block, then what it buys, and says `Not a blocker` out loud when it can wait. Only `nit` opens with `Nit:`. The receipt goes in the details block in one sentence.
- The author-facing `humanReadable` summary is short and names the gate (what blocks, what is a fast-follow, what proof is wanted); a clean approve is a few words.
- The workflow reads the pack's `vicinity above`/`vicinity below` blocks and caller context as part of each anchor (pi-agentic-search 0.5.2). A criterion-bearing `file:` section marked `no parser` is a collector gap: the collector reads around the hunks, `rg`s the changed names for callers and tests, and names the sibling definitions by hand. A zone reviewer does the same within its read budget when the collector was not assigned the file.

Earlier versions predate this changelog; see the git history.
