Use only the review instructions, stage prompts, and context supplied by `pi-auto-review`. Do not read other skills unless the user explicitly requests them in this session.

# Pull request context at intake

When the review target is a pull request URL, the PR's own state is evidence, and it is pulled before any agent launches. The URL decides the tool: a `github.com` URL uses `gh`; a Meteorite or Gitstream URL uses `gs`. Run the commands from the reviewed checkout. Reading only: never post, comment, react, resolve a thread, re-run a check, or wait on CI. If the tool fails or the URL matches neither provider, record the exact failure as an intake gap and continue with the user's context and the local diff; do not guess what the PR says.

## 1. Description, range and linked issues

- GitHub: `gh pr view <n> --repo <owner>/<repo> --json number,title,body,state,isDraft,author,labels,baseRefName,headRefName,baseRefOid,headRefOid,url,closingIssuesReferences`
- Meteorite: `gs pr view <n> --json`, which returns `number`, `title`, `body`, `state`, `draft`, `author`, `labels`, `baseRef`, `headRef`, `baseSha`, `headSha`, `htmlUrl`, and `xGitstream.stack` (parent and children PRs).

Save the body verbatim to `pr.md` in the run directory and record a `requirement` map record pointing at it: title, the stated problem, the testing notes, linked issues (`closingIssuesReferences`, issue links in the body, the Meteorite stack parent), labels and draft state. The body is a requirement source alongside the user's context; when they disagree, say so in the requirement record instead of picking one silently.

Use the PR's `baseSha` and `headSha` (`baseRefOid`/`headRefOid` on GitHub) as the exact range. Check both exist locally with `git cat-file -e <sha>^{commit}`; if the head is missing, `git fetch <remote> <headRef>` is allowed because it changes nothing in the working tree. Then call `sparsity_index` with `diff: "<baseSha>...<headSha>"`. If `git rev-parse HEAD` differs from the PR head, say which revision the review covers. Never reset or check out anything.

## 2. Review threads and comments

- GitHub: `gh pr view <n> --repo <owner>/<repo> --json reviews,comments,latestReviews` for review bodies and general comments, and for inline threads with their resolution state:
  `gh api graphql -F o=<owner> -F r=<repo> -F n=<n> -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:20){nodes{author{login} body createdAt url}}}}}}}'`
- Meteorite: `gs pr view <n> --json` returns `reviews[]` (author, state, body, submittedAt, url); `gs pr view <n> --comments` appends the issue and inline comments to the human output.

Classify every thread: human or automated (service accounts such as `*@*.iam.gserviceaccount.com`, names ending in `[bot]`, known review bots), inline with `path:line` or general, and open, resolved or outdated. Save the full text to `pr-threads.md` in the run directory and record one `evidence` record per thread with a one-sentence gist and its classification.

Rules the workers receive: a point already raised and resolved is history, not a finding; an open human thread about a zone becomes a reopened question for that zone's reviewer to settle with current evidence, never a new bug by default; an automated comment is a lead to verify, not evidence; an author's self-audit or checklist comment is not a work list, verify only the claims a criterion depends on and never re-run the author's checklist; the review reconciles against these threads and never repeats one under a new title.

## 3. CI status

- GitHub: `gh pr checks <n> --repo <owner>/<repo> --json name,state,bucket,link,workflow`
- Meteorite: `gs pr checks <n> --json` returns `state`, `requiredChecks[]` with `name`, `state` and `present`, `checkRuns[]` with `name`, `status`, `conclusion` and `url`, and `statuses[]`. Exit code 8 means pending.

Record an `evidence` record: the overall state, each required check with its state and link, and the head sha the checks belong to. If that sha is not the PR head, the checks are stale and the record says so. Grading rules: a failing required check is a stated condition on the merge grade, `medium` at best unless the failure is shown to be unrelated to the change; a missing or pending required check is a disclosed uncertainty, not a defect. Never wait for CI, poll, re-run, or call a blocking wait tool.

## 4. What reaches workers and the report

Every worker mission includes the PR title, two lines on the body's stated problem, the open threads that touch the worker's zone (`path:line`, author, gist, open or reopened), and the CI state in one line.

The final review JSON gets `prContext`: `{ url, provider, number, title, head, base, draft, state, labels, checks: { state, required: [{ name, state }], stale }, threads: { open, resolved, automated }, linkedIssues, files: ["pr.md", "pr-threads.md"] }`, or `null` for a local diff. The main-conversation report spends one sentence on the CI state and one on how existing threads were handled.
