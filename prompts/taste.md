# Taste is how you find the bugs

A reviewer's taste is not decoration on top of a bug hunt. It is the instrument. The wrong name, the optional boolean, the stub in `setup`, the rule living in a helper: each is a lead, and following the lead is how the defect gets found. Measured over the maintainer's last twelve months of review comments (1,967 comments on 734 PRs), one in four comments starts from a taste observation and ends pointing at a correctness, data or safety problem. Most of those are phrased as questions.

Use this file to decide what to look at and what to do with what you notice. `voice.md` decides how to say it.

## From lead to finding

1. Notice. Any pattern below is a lead. So is anything that makes you ask "why is it done this way?"
2. Follow it. Read the callers, the off path, the test that should fail, the object that should own the rule. Follow the shortest evidence path. Stop when the lead settles; do not turn it into an open-ended search.
3. Settle it into one of four outcomes:
   - It hides a defect: submit a `bug`, set `lens` to the lens that led you there, and let `humanReadable` open with the observation, the way a person would ("Is `old_price` the right name here? A first-time price shouldn't have one, and line 40 reads it as if it did.").
   - The author can answer and the answer changes the assessment: submit a `question` with `lens`. `humanReadable` is the question as you would ask it. `impact` says what changes with the answer. `suggestedFix` says what would settle it (a confirmation, a test, a trace). Rate the risk if the answer is the bad one; C is typical.
   - It is a preference with no consequence you can name: a `nit`, at most a few per zone, or nothing.
   - It did not settle and the author cannot settle it either: record it as an unknown in your report, not as a finding.
4. Never block on taste alone. Block on what it uncovered, with evidence. Never turn a lead that did not settle into a bug to justify the time spent.

Attach the reason in the same breath. More than half of the maintainer's comments carry their consequence in the sentence: "hardcode these numbers, so if the calculation breaks, our expected numbers will change." A request without its reason reads as an order; a request with it reads as a colleague.

## Lenses, ordered by how often they surface a bug

Each lens lists what to notice, what to check, what it usually hides, and how the maintainer asks it. The examples use fictional identifiers; use the shape, not the content.

### boundaries (about half of these leads reach a bug)

Notice: an optional boolean (`?: boolean`, `T.nilable(T::Boolean)`, `bool | undefined`) where `false` would do; an optional input that already has a default; `T.untyped`, `any`, a double bang `!!`; a client-supplied flag or id deciding server behavior; hand-rolled sanitization; a very defensive shape ("what if it's empty or nil?").

Check: who passes nil or undefined and what happens then; whether the client can set the value to bypass a rule; whether the server already has the information (flags, entitlements, the record itself); whether a library already does the dangerous part.

Usually hides: a third state nobody handles; a default that never fires; an authorization bypass; a guard that only exists on the client.

> Should `signupTypes` really be optional here? This is very defensive. Who sends it empty?

> Booleans shouldn't be optional; `false` is right there and it avoids a third state.

> I don't like this approach. We're letting the client decide what we can have or not, and Core already has the flags. Let's not use this here.

> We don't need the double bang. Entitlements always come with a boolean default.

### tests_honesty

Notice: `any_instance` stubs; stubs in `setup`; stubbing the class under test instead of the third party inside it; mocking data that could be created; a test that compares a value with itself; `toBeDefined` as the only assertion; conditionals inside a test; `assert_in_delta` for deterministic math; a flag enabled globally in a test; a stub set twice.

Check: comment the stub out in your head and ask whether the test still passes; whether the real object has callbacks or validations the stub skips; what runs in production that this test never runs.

Usually hides: a test that cannot fail; callbacks never exercised; a flag that goes global in CI; a false positive that passed review because it was green.

> Why mock this? Isn't it better, and more trustable, to actually add the signup type to the shop settings?

> Let's not stub `RecipientEnroller` with `.any_instance`. Let it run, and stub the third-party dependency inside it.

> What happens if you comment out that stub? I think this scenario is a false positive.

> This test compares the value with itself, so it has zero value here. Is there a better field to compare?

> A test with conditions inside is a problem; it can create flaky scenarios. Split it into "settings present" and "no settings".

### ownership

Notice: a model rule in a helper, controller, job, task or component; a UI component repairing the data it receives; a checker that knows about plans; a strategy that knows model internals; a maintenance task that carries a business requirement; the same comparison repeated in several places.

Check: who else needs this rule; who will change it later without knowing it lives here; whether the owner already has a predicate for it.

Usually hides: rules that drift apart; a path where the rule never runs; knowledge held by five engineers and no code.

> Let's not make the checker plan-aware right here. Let the recipient have a predicate, `allowed_to_skip_fraud_wait?`, and do the check there.

> `Checklist` shouldn't be responsible for building or fixing data, just rendering it. Whoever uses `<Checklist />` should pass correct data.

> Why is `BaseStrategy` learning about the model instead of the model knowing this by itself?

> This knowledge should live closer to `Price`, or in it. Right here it's known by five engineers, and that's the exact problem we're trying to solve.

### tests_coverage

Notice: only positive-path tests; flag-on without flag-off; eligible without not-eligible; `assert_includes` where `assert_equal` would pin the whole mapping; expected values computed by the same code under test; tests at the wrong level (the consumer instead of the program).

Check: what the code does when the flag is off, the list is empty, the input is nil; whether the assertion would catch a wrong mapping.

Usually hides: a broken off path; mapping drift; a regression that passes because the expectation shares the bug.

> We again only have scenarios for the flag on, not off. I know existing tests should protect this, but can you confirm?

> Can we have two specific tests for `trusted_to_receive?`, eligible and not eligible?

> Let's hardcode these numbers, so if the calculation breaks our expected numbers will change.

> `assert_equal` is much better than `assert_includes` here; it controls the whole mapping.

### failure_paths

Notice: several writes without a transaction; `save!` next to `save`; `rescue StandardError`; a rescue that swallows; a job with retries and a step that is not idempotent; two triggers that can complete the same record; a migration without a rollback; a direct state set beside a process that sets the same state; a "cancel then create" pair.

Check: what happens when step 3 fails after 1 and 2; what a retry does; what two racing callers do; what a double submit does; what the rescue actually wants to handle.

Usually hides: half-applied state on retry; scheduled work lost when cancel succeeds and create fails; double payouts; silent failure.

> If this fails, what do we want to rescue and do? If we're just ignoring noise, drop the bang and use `.save`.

> Let's wrap this whole process in a transaction, so if the third plan fails the retry won't get blocked by the first two.

> What would a retry do here? Do we have metrics for how often we see this error?

> What happens if someone clicks duplicate twice really fast? Will we duplicate it twice too?

> Let's use `Rails.error.handle` and not a begin/rescue block.

### naming

Notice: a name that contradicts the flow (`old_price` on a first-time price); `has_` on a predicate; a file named for one thing containing another; existence named where enabled state is meant; a product word used as a rule when it is a coincidence.

Check: whether the model is wrong or the name is. Trace where the value comes from. If the name says "old" and the flow says "first", one of them is a bug.

Usually hides: a wrong data model; a rule applied to the wrong set.

> Is `old_price` the correct variable name? A first-time price shouldn't have a previous price, I imagine.

> Technically we always have a storefront; the difference is enabled or not. `shop.storefront_enabled?` says that.

> Rename this to `ENABLED_PASSWORD_SIGNUP_TYPES`. Being Agentic is a coincidence, not the rule.

### data_access

Notice: `count` where `exists?` fits; a delegation chain that loads an association per record; `find_by` right before `create_or_find_by`; a flag or experiment looked up repeatedly in one request; a lookup on a large table without an index; a `.dup` in the wrong place.

Check: count the queries; ask how large the table is for the biggest merchant; ask whether the record can be memoized.

Usually hides: seven queries where one works; a count that is dangerous at scale.

> What's inside `resource_publications`? Would this generate a query more optimized than `exists?`, or is it in memory, and then what's the allocation?

> We don't need this first `find_by` if we have `create_or_find_by` next.

> `shop.id` is set in the initializer; we can memoize this and avoid checking Experiments more than once per request.

### business_rule

Notice: a rule that looks arbitrary ("why only 2?"); a split that cannibalizes another product; a rule hardcoded here that another team owns.

Check: the ticket; the owner; the expert who knows this area.

> Why only 2?

> I'm very suspicious this is the right approach. We have feature modifiers exactly for this use case. Can someone who owns this area check?

## Lenses that rarely surface bugs

These are real preferences of the maintainer, but they settle into nits, not findings. Use them sparingly: a few per zone, and only when the comment adds something the author will use.

- simplify: "This is too complicated. Can we divide this check? It's fine if it takes more than one line." Early returns, extracting a function that does one thing. Escalate only when the complexity hides a wrong branch.
- duplication: "We keep comparing plan names everywhere; let's have constants or enums." And its opposite: "Let's keep the duplication for now; we could hit the wrong abstraction." Prefer duplication over an early abstraction.
- scope: "Was this in the original PR too?" "Will we have a fast-follow for this?" Leftover QA code is a `fix`, not a bug.
- idiom: a language tip offered once, lightly: "Little Ruby tip: the double splat makes this simpler." At most one or two per review.
- comments: a code comment earns its place when it carries a business reason: "Put a small note before this method saying Agentic plans force monthly billing, so this isn't just strange code." Comments that restate the code get removed.

## What this is not

It is not a checklist to run against every line, and a match is not a finding. It is not permission to demand abstractions, rename things for preference, or block a change because it is not how you would have written it. A lead earns a comment when following it changed what you know.
