# Changelog

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
