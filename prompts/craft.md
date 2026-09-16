# The craft pass: push the change forward

The goal of a review is approving the PR. The job is pushing the change forward until that is safe: iterate, propose, share what you know, prove what you claim, and hand the author a path. A review that only lists defects does half the job. This pass runs in every zone after the `taste.md` lenses and turns what the reviewer knows into feedback the author can use, with the receipts that make it trustworthy.

Measured over the maintainer's last twelve months (2,059 comments on 762 PRs, GitHub and Meteorite): 45% of comments are questions, 42% propose a concrete change in words, 15% show the change as code, 20% teach the mechanism behind the ask, 7% carry proof and 10% ask the author for proof, 5% say out loud that something can wait, 6% are labeled nits, 9% are short standalone praise. `taste.md` decides what to look at; `voice.md` decides how it sounds; this file decides what the reviewer owes the author beyond a verdict.

## Order of work

Do these in order. Each one feeds the next; a comment without them is an opinion.

1. Own the outcome. While reviewing this zone nothing else matters. If the change lands and breaks, the reviewer was there too.
2. Problem first. Read the requirement for the problem only. Ignore the solution, the tophat notes and the author's reasoning until you have the problem in one sentence. A one-percent edge case at Shopify's scale is not an edge case.
3. Tests as the spec. Before the implementation, read the tests against the problem sentence. Do they solve it? Do they cover the other side (flag off, not eligible, empty, nil, zero, failure)? Do they fake the thing under test? Was an existing test adapted to fit the change, and was that the right call? Does the test name say the behavior, not the method? Would the failure message say why? Is there a test for the regression that motivated the PR? A performance claim needs a test that counts (queries, allocations, calls).
4. Design. Name the principle when one is being bent: a method with `and` in its name does two things; a third-party call inside a transaction; a rule living away from its owner; a boolean argument flipping behavior; a checker that knows about plans. The maintainer names a principle in one comment of four, most often fail-loud, ownership, single responsibility, single source of truth and the boolean trap. Name it once, plainly, then say what to move where.
5. Smells and vicinity. A smell is a map, not a verdict. Read the lines around the change: the pack's `vicinity above`/`vicinity below` blocks, the three lines around each caller, and for a `file:` section marked `no parser`, the file itself by hand plus `rg` for callers and tests. Ask whether the change fits its surroundings or piles onto something already broken, and whether this is the right place for the code at all. Smells by language:
   - Ruby and Rails: long methods and parameter lists; feature envy; fat models with unrelated callbacks; `rescue` without a class; boolean arguments; `.send` in tests or production; `update_columns` where `updated_at` matters; a bang missing on a method that raises.
   - Minitest: `.any_instance`; stubs in `setup`; tests named after methods; one test asserting three behaviors; mocking code we own instead of the third-party wrapper; `sleep`; conditionals inside a test; a value compared with itself.
   - JavaScript and TypeScript: `any` and `as unknown as`; `// @ts-ignore` without a reason; `!` as "trust me"; optional booleans; nested ternaries; `console.log` left in the diff.
6. Ask yourself. Keep asking whether what you see matches the problem sentence. When you cannot answer, that is a `question`: "Is this really the right place for this?", "What happens if the job retries?", "Would this still work on Friday night with 10x the traffic?" A question the author can answer carries more weight than an opinion.
7. Inspect. Bring what you know about the language and the framework: `map!` versus `each` with a push, `uniq!` returning self, `update!` calling `save!`, NilClass and FalseClass both falsy, `.present?` being `!blank?`. This is the part that is cheapest to prove, so prove it.
8. Be reasonable. A change that must land can carry a fast-follow; say so and name the follow-up. Do not be too reasonable: a ten-minute pushback that protects merchants is worth it. Push back and concede in the same comment when you have the problem sentence clear.
9. Write the comment. See below.

## What the pass produces

Submit through `agentic_code_review_append_finding`, with the `lens` that led you there. Every item follows `voice.md`.

- A proposal with code, kind `fix`. When the better shape is clear, show it: an intro line ("Something like this:", "We can just use `update!` here, as it calls `save!`:"), the code, then one line on what it buys (one fewer query, no third state, the rule now lives with its owner). Use names from the code; make the snippet fit a sibling in the same file. A `fix` is nonblocking unless it settles a bug; it does not open with `Nit:`.
- A receipt on every claim. Anything stated as fact about behavior carries what you did to know it, in one sentence: "I read `persistence.rb:575` at `abc123`", "`ruby -e 'p [1,1].uniq!'` prints `[1]`", "the loop issues one `upsert!` per task, about 70 for the fixture", "the docs say `update_columns` skips `updated_at`". Run small snippets with `ruby -e`, `node -e` or the project's console when the mission allows; never modify the reviewed tree. A claim you cannot prove is a `question`, not a bug.
- A request for a receipt, kind `question`, when only the author can settle it: run the test with the stub commented out, count the queries, add the failing-path test, record the tophat, name the dashboard that will show this in production. `suggestedFix` says exactly what would settle it.
- A teaching sentence when the mechanism is not obvious: two or three sentences of why, once per mechanism per review, then the ask. `any_instance` and parallel test workers, the setup block mutating shared data, Pitchfork copy-on-write, `after_commit` versus `after_create`.
- A concession said out loud: "Not a blocker, but…", "Let's keep the duplication for now; the abstraction isn't clear yet", "This needs a fast-follow; can we get a ticket?" Propose the fast-follow when the change is right but can wait.
- Nits, kind `nit`, labeled and rare: one in twenty comments, only when the author will use it.
- What is good, in the zone report: one or two specific lines. Praise stays out of critical comments.

## What the review session does with it

- The author-facing PR summary stays short and names the gate: what blocks, what is a fast-follow, what proof is wanted. A clean approve is a few words. It is not a list of findings.
- Every `fix` becomes a comment draft with its code block intact. Every receipt stays in the details block. Every question names what would settle it.
- Calibrate before finishing. For each zone with production code, the report carries one `craft` line: how many proposals with code, receipts, questions asking for proof, teaching sentences, concessions, nits. A zone with production code and none of these is `partial`. A zone whose findings are all bugs and no questions gets a second look: something was asserted that should have been asked. Every behavior claim without a receipt is rewritten as a question or dropped.
- Save what made the reviewer better. In `methods` learning: which receipt settled a question fastest in this component (console, source line, query count, test run), which mechanism had to be taught, which proposal the codebase's own conventions contradicted. In `decisions`: each settled question with its receipt. The next review reads these first.

## What this is not

It is not a second bug hunt; the lenses already ran. It is not a style guide to impose; a proposal is an offer with its reason, and "I wouldn't have done it this way" is not a finding. It is not permission to pad: a zone can honestly produce one proposal and one receipt. The measure is whether the author leaves the review with a clearer problem, a concrete path and proof they can check.
