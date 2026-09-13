# PR summaries and inline comments

There are two different outputs. The human PR summary is the main report for the user and is never auto-posted. Inline findings are separate drafts that may be posted only after explicit approval. This package does not post either output.

## 1. Write the human PR summary

Read the accepted final assessment and its reconciliation, not just the raw `bugs` array. Follow `presentation.md`: two writing passes, 60–90 words ideally, at most 200. Address the author and explain what the change does, how it works, and where it falls short. Return natural paragraphs without model attribution, ratings, template labels, a generic verdict or a blocker list. Store only that prose in the final review's `humanReadable` field.

Keep the detailed evidence, grades and provenance alongside it in the structured report. Important failures still need an explanation in the summary; specific fixes belong at their source lines. Do not turn the summary into a general blocking review body.

Example of the tone, based on the [PR24 description](https://github.com/dantetekanem/pi-extended-teams/pull/24) and its historical comments, not a fresh assessment of its current head:

> Your onboarding command gathers the models, extensions and settings available in the current session, then asks the lead agent to recommend setup steps without applying them. That keeps configuration decisions with the user. The reviewed inventory drops explicit thinking levels, and the update guidance treats moving branches and temporary packages like ordinary installed versions. Those gaps can make the recommendations wrong even though the command itself stays read-only.

Check each statement against the actual run before using this pattern. Do not copy the example as a current review. Give the summary to the user as a private draft; approval of inline comments does not authorize publishing it.

## 2. Prepare source-line findings

For each proposed inline comment:

1. Resolve the submitted ID through the final map and reconciliation. Use the accepted interpretation, including corrections. Keep confirmed bugs, optional suggestions, inherited prerequisites and unconfirmed/refuted history distinct. Never infer acceptance from `blocks: true` in a raw historical record.
2. Verify repository, PR, reviewed head SHA and source location. Select an actual diff line and side (`RIGHT` for the new version, `LEFT` for a deletion). A file/symbol location alone is not enough. If a blocker cannot be anchored, retain it privately and report the placement gap; do not promote it to a general PR-body blocker.
3. Draft a short comment from the finding's `humanReadable`, `rating`, `impact` and technical evidence. Include expected versus actual behavior, the smallest supported fix or missing proof, and whether verification was executed or only source-traced. Preserve origin and counterevidence. Do not repeat the full report.
4. Use the provenance of the assessment that supports this wording. The finding receipt's `reviewer` is runtime submission metadata; later reconciliations may have their own source-linked reviewer. Never credit a rewritten assessment to the original model without evidence. Render unavailable fields as `unavailable`, not a guessed name or thinking level.

Use this inline format, with one literal A–F rating:

```text
Reviewed by Pi - Model: {model}/{thinkingLevel}. Auto-review tooling analysis.

For human: {short, plain-language consequence and supported next step}

--

Impact: {rating} - {evidence state, origin when relevant, and consequence}

Comment: {technical explanation, evidence, verification limits and smallest supported action}
```

The header and rating belong only to the inline draft, never to the human PR summary.

### Unconfirmed history example

The [PR24 dispatch comment](https://github.com/dantetekanem/pi-extended-teams/pull/24#discussion_r3999874815) is a correction, not an established blocker. A short human field could say:

> The code checks whether the agent is idle before loading inventory. We haven't shown that overlapping dispatch can actually happen, so this is history to investigate, not a reason to change the code.

An illustrative `C` rating must retain the qualification: “Unconfirmed, nonblocking review history. A practical overlapping-dispatch failure was not established.” Keep the technical correction about Pi's generic asynchronous extension error. Do not request a guard or label the issue fixed. Draft/post a historical correction only when specifically requested; omit it from an ordinary actionable-finding batch. This example does not re-grade or edit the saved review.

Other references show distinctions the short wording must preserve:
- [PR28](https://github.com/dantetekanem/pi-extended-teams/pull/28#discussion_r3999876813): report loss was source-traced; premature claim release was not established.
- [PR29](https://github.com/dantetekanem/pi-extended-teams/pull/29#discussion_r3999879469): the parent report-loss issue is inherited, not a second newly introduced defect.
- [PR30](https://github.com/dantetekanem/pi-extended-teams/pull/30#discussion_r3999881415): a conditional contention schedule was traced, not runtime-reproduced.
- [PR31](https://github.com/dantetekanem/pi-extended-teams/pull/31#discussion_r3999883716): checkpoint publication can fail while the full report and cleanup fences remain intact.

These are historical presentation references, not permission to review, change or publish on those PRs.

## 3. Approval before any automated inline posting

Preparing a report, grading it, or approving the code is not permission to send a communication. Present the exact PR link, head SHA, selected source lines/sides, proposed inline bodies and submission verdict to the user. Keep the human PR summary outside that payload. Ask for explicit approval of that exact send. Silence, a timeout, a cancelled dialog or a request to draft is not approval.

Only after approval, use the existing configured provider's review tool. For `submit_pr_review`, map the approved target to `provider`, `repo`, `prNumber`, `commitId`, `prAuthorLogin` and checkout `cwd`; map each approved inline to `comments: [{ path, line, side, body }]` (and range fields when needed). Retain the approved comments for any verdict. Do not put `humanReadable` from the final review into the top-level `body`, and do not send a general blocker body. Never approve through the PR author's identity.

Recheck the head and line anchors immediately before submission. Drift invalidates this payload's approval: stop and request revalidation rather than silently rewriting or launching another review. If no valid inline remains, do not send an empty general review as a substitute. After a successful send, retain returned comment/review URLs with the source finding IDs and report them to the user. If the result is uncertain, inspect delivery state before proposing a retry; never duplicate comments on a timeout.

This is an operating guide for a separately authorized send, not a posting implementation or standing authorization. The human PR summary remains a user-facing draft.
