# PR summaries and inline comments

The main-conversation report explains the PR and its assessment under `presentation.md`. The author-facing `humanReadable` PR summary stays separate in the review artifact and is never auto-posted. Inline findings are separate drafts that may be posted only after explicit approval. This package does not post any of these outputs.

Use fictional examples in packaged prompts. Actual PR/comment links belong to the authorized run context and evidence, not reusable examples.

## 1. Write the human PR summary

Read the accepted final assessment and its reconciliation, not just the raw `bugs` array. Follow `presentation.md`: check technical accuracy, then apply available user-voice guidance and a humanizer pass. Address the author directly and lead with what matters. Include context only when needed to understand the feedback, not a routine feature recap. Write no more than needed, at most 200 words. Return natural paragraphs without model attribution, ratings, template labels, a generic verdict or a blocker list. Store only that prose in the final review's `humanReadable` field.

Keep the detailed evidence, grades and provenance alongside it in the structured report. Important failures still need an explanation in the summary; specific fixes belong at their source lines. Do not turn the summary into a general blocking review body.

Illustrative summary for a fictional setup command:

> We're dropping the explicit thinking levels from the inventory and treating moving branches and temporary packages like regular installed versions. Both can lead to wrong setup recommendations. The command doesn't apply changes, but users still need to be able to trust what it recommends.

Check each statement against the actual run before using this pattern. Do not copy the example as a current review. Give the summary to the user as a private draft; approval of inline comments does not authorize publishing it.

## 2. Prepare source-line findings

For each proposed inline comment:

1. Resolve the submitted ID through the final map and reconciliation. Use the accepted interpretation, including corrections. Keep confirmed bugs, optional suggestions, inherited prerequisites and unconfirmed/refuted history distinct. Never infer acceptance from `blocks: true` in a raw historical record.
2. Verify repository, PR, reviewed head SHA and source location. Select an actual diff line and side (`RIGHT` for the new version, `LEFT` for a deletion). A file/symbol location alone is not enough. If a blocker cannot be anchored, retain it privately and report the placement gap; do not promote it to a general PR-body blocker.
3. Draft a short comment from the finding's `humanReadable`, `rating`, `impact` and technical evidence. Include expected versus actual behavior, the smallest supported fix or missing proof, and whether verification was executed or only source-traced. Preserve origin and counterevidence. Apply the same available user-voice guidance and humanizer pass to the prose without changing the required format below. Do not repeat the full report.
4. Use the provenance of the assessment that supports this wording. The finding receipt's `reviewer` is runtime submission metadata; later reconciliations may have their own source-linked reviewer. Never credit a rewritten assessment to the original model without evidence. Render unavailable fields as `unavailable`, not a guessed name or thinking level.

Use this Markdown inline format, with one literal A–F rating:

```markdown
### {title}

{Short, natural feedback to the author: the consequence and supported next step.}

**Review details (for agents)**

{Technical explanation, evidence state, origin when relevant, verification limits and smallest supported action. Support the opening rather than repeating it.}

Pi auto-review - Model: {model}/{thinkingLevel} - Rate: {rating} **({blockingStatus})**
```

Prefix every optional suggestion's title with `Nit: `, including optional findings recorded as `fix`. Other titles have no status prefix; never use `Blocking: ` in a title. Use `blocking` or `nonblocking` for `{blockingStatus}`, based on the accepted assessment, not the rating alone. Optional suggestions are always nonblocking. Keep the status and its parentheses bold: `**(blocking)**` or `**(nonblocking)**`.

Keep the author-facing feedback first, immediately below the title, without a `For human:` label. Follow it with the exact bold label `Review details (for agents)` and visible technical prose. Do not add `Impact:` or `Comment:` labels, `<details>` wrappers, or `<sub>` tags. Keep attribution and rating on the final line, using actual provenance rather than a fixed example model.

The attribution and rating belong only to the inline draft, never to the human PR summary.

### Unconfirmed history example

Suppose a dispatch finding was corrected because no practical overlapping-dispatch failure was established. The opening feedback could say:

> The code checks whether the agent is idle before loading inventory. We haven't shown that overlapping dispatch can actually happen, so this is history to investigate, not a reason to change the code.

An illustrative `C` rating must retain the qualification: "Unconfirmed, nonblocking review history. A practical overlapping-dispatch failure was not established." Preserve counterevidence, such as the runtime reporting an asynchronous error rather than failing silently. Do not request a guard or label the issue fixed on this evidence. Draft/post a historical correction only when specifically requested; omit it from an ordinary actionable-finding batch. This fictional example does not assess an actual change.

Other fictional cases show distinctions the short wording must preserve:
- Report delivery: report loss is source-traced; premature claim release is not established.
- Inherited risk: a parent report-loss issue is a prerequisite, not a second newly introduced defect.
- Contention: a conditional schedule is source-traced, not runtime-reproduced.
- Partial reporting: a checkpoint can fail while the full report and cleanup fences remain intact.

These examples do not establish findings or authorize review, changes or publication.

## 3. Approval before any automated inline posting

Preparing a report, grading it, or approving the code is not permission to send a communication. Present the exact PR link, head SHA, selected source lines/sides, proposed inline bodies and submission verdict to the user. Keep the human PR summary outside that payload. Ask for explicit approval of that exact send. Silence, a timeout, a cancelled dialog or a request to draft is not approval.

Only after approval, use the existing configured provider's review tool. For `submit_pr_review`, map the approved target to `provider`, `repo`, `prNumber`, `commitId`, `prAuthorLogin` and checkout `cwd`; map each approved inline to `comments: [{ path, line, side, body }]` (and range fields when needed). Retain the approved comments for any verdict. Do not put `humanReadable` from the final review into the top-level `body`, and do not send a general blocker body. Never approve through the PR author's identity.

Recheck the head and line anchors immediately before submission. Drift invalidates this payload's approval: stop and request revalidation rather than silently rewriting or launching another review. If no valid inline remains, do not send an empty general review as a substitute. After a successful send, retain returned comment/review URLs with the source finding IDs and report them to the user. If the result is uncertain, inspect delivery state before proposing a retry; never duplicate comments on a timeout.

This is an operating guide for a separately authorized send, not a posting implementation or standing authorization. The human PR summary remains a user-facing draft.
