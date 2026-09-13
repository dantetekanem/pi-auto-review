# Human-first review reports

Use this contract for collector handoffs, zone assessments, findings and the final review. It describes presentation, not permission to publish or a substitute for technical evidence.

## The PR summary comes first

The final review's `humanReadable` field is the main deliverable: a short explanation addressed to the author, so the user can understand the change. Explain what it does, how it does it, and where it falls short. Describe preserved behavior when it matters. If no failure was established, say what the evidence covers and what remains unverified; do not invent a problem to fill the format.

Aim for 60–90 words, roughly 20 seconds of reading. Never exceed 200 words, roughly 60 seconds. Use one or two natural paragraphs. Keep source detail in the evidence records.

Make two writing passes:
1. Check technical fidelity. Trace each claim to the accepted evidence and current revision. Preserve uncertainty, inherited behavior, counterevidence and whether checks were executed. Explain cause and effect without turning a suspicion into a defect.
2. Apply humanizer principles. Read it as feedback from one engineer to another. Use familiar words, concrete actions and natural sentences. Remove filler, hype, repetition and unnecessary jargon. Recheck that editing did not add or drop a claim; shorten to the reading budget.

Return only the second pass. The prose has no model header, rating, `For human:` label, impact template, generic verdict or blocker checklist. Explain a failure in context without using the summary as a general change-request comment. Actionable requests belong in separate source-line comments.

This summary is a private final-report draft for the user. Never auto-post it, even when inline comments have been approved. Grades, evidence, provenance and approval conditions remain separate structured fields; do not discard them to make the prose shorter.

## Fields and scope

- Final review: `humanReadable` as above; `reviewer` for the coordinator's available runtime provenance; each assessed `grades.merge` / `grades.deploy` object adds `rating` alongside its existing `grade`, `reason` and `conditions`. An unrequested assessment stays null.
- Zone assessment: `humanReadable`, `rating`, `reviewer`, the existing recommendation and evidence. Rate only your assigned scope. An unable assessment has no recommendation and `rating: null`; retain its evidence and failure explanation.
- Collector/deep-collector handoff: a short `humanReadable` account of what was found and what the next stage still needs, plus available `reviewer` provenance. Use `rating: null` for the handoff because collection is not a readiness verdict. Submitted findings still need their own ratings.
- Each submitted finding: `humanReadable` (about 25–40 words, at most 400 characters) and `rating` (one letter A–F). Explain the observed consequence and supported next step. Keep `impact`, `suggestedFix`, source locations and technical evidence intact. The append tool records `reviewer` from the executing context and returns it; do not supply your own attribution.
- Map findings and reconciliation corrections: carry the summary and rating with the explicit evidence state and original finding ID. A correction supersedes the interpretation, not the historical submission's bytes.

## Rating guide

Ratings describe the safety of the stated scope under the available evidence. They are not confidence scores, complexity scores, votes or automatic blockers.

| Rating | Meaning | Existing assessment grade |
| --- | --- | --- |
| A | Safest supported assessment: criteria met, material scope examined, no accepted issue remains. This is not a guarantee. | safe |
| B | Criteria met; only minor, nonblocking improvements remain. | safe |
| C | Bounded residual risk or an unconfirmed concern needs a named precaution or further proof; no blocking defect is established by this letter. | medium |
| D | Do not proceed on present evidence: a blocking defect, unmet essential criterion or material coverage gap remains. Say which. | risky |
| E | A confirmed serious failure threatens important functionality, data integrity, security or availability. | risky |
| F | Worst: a confirmed critical failure has catastrophic or irreversible consequences under a supported scenario. | risky |

Use A–F, including E, without numbers or suffixes. A finding's rating describes that finding, not the entire PR. Derive the overall assessment from requirements, accepted findings and coverage; do not average letters or copy the worst historical allegation. A rating never overrides `blocks`, evidence state or reconciliation. Fixes/nits remain nonblocking. A material incomplete review cannot earn A–C; use D for missing proof without fabricating an E/F defect. Leave deployment null if it was not assessed.

Keep `confirmed`, `unconfirmed`, `refuted`, `superseded` and inherited/pre-existing origin explicit. Do not call an inherited bug newly introduced. Do not call a refuted suspicion fixed or turn unconfirmed history into a change request. Preserve its limits in the human wording, not just in hidden metadata.

## Provenance and compatibility

Use `reviewer: { model: string | null, thinkingLevel: string | null }`. Finding provenance comes from the actual submission context. For reports without a finding receipt, use that agent session's available runtime report metadata. Record the source link in coverage; use null when unavailable. Never substitute a configured tier, another agent, a marketing name or a copied PR header. If several models contributed, keep their per-report provenance rather than crediting all work to one model.

New prepared artifacts carry `presentationVersion: 1`. Their finding submissions require both fields; the tool checks shape and length, not truth or readability. Older runs without the marker may still submit the old shape. Supplied new fields must be valid together even for an older run. Preserve old records and grades without backfilling invented summaries, ratings or provenance. Final-report wording and rating consistency remain coordinator-verified prompt contracts, not runtime semantic validation.

For separate approval-gated inline drafts, follow the sibling `pr-comments.md` guide. The human-only PR summary is never part of that automated payload.
