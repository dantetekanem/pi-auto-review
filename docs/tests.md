# Test runs during a review

A review can run the repository's own tests against the change. Tests already control their environment: they load what the code needs, set up state and stub the outside world. So the review uses them as the harness instead of booting the application. Setting up the environment stays the developer's job. The tool never runs setup commands, installs dependencies or starts services; when the tests cannot run with the checkout as it is, the review stays source-only and names the gap.

The four kinds follow the safe / mutant / control / counterexample contract of the [reservation model check](evidence.md#optional-reservation-model-check), applied to code:

| Kind | Contract | What runs | Outcome when it passes | Outcome when it fails |
| --- | --- | --- | --- | --- |
| `baseline` | safe | the selected tests at the reviewed head | `passed` | `failed` |
| `revert` | control | the change's non-test files back at base, its test files at head | `failed-without-change` | `passed-without-change` |
| `break` | mutant | one changed line edited to turn off a safeguard | `killed` | `survived` |
| `edge` | counterexample | a new test file the reviewer writes for one edge case | `holds` | `breaks` (bug candidate) |

A run that times out, is cancelled or cannot start is `unknown`. `revert` and `break` need a passed baseline with the same command and working directory; the tool runs that baseline first when it is missing and returns both results. An `edge` command must name its new test file or a directory that contains it (`node --test` needs the file itself). One that names the file cannot run as a baseline, so any passed baseline in the same directory counts for it, and without one the edge run is refused before it starts. One that names a directory needs a baseline with the same command, which the tool runs first.

## Using the tool

`agentic_code_review_run_tests` belongs to the visible top-level review session. Reviewers propose breaks and edge tests in their reports; the top-level session runs them. A session without a UI, such as an in-process reviewer or a headless review, can read `plan` but cannot run anything.

- `operation: "plan"` runs nothing. It returns whether runs are available and why not, the sandbox setting, the budget, the timeout, the base and head, the copied components, the changed files with their head line ranges, suggested tests and up to 40 break candidates (changed lines of code files with conditions, comparisons, returns or raises).
- `operation: "run"` with `kind`, `command` (an argv array; there is no shell, and the program must resolve before a run is consumed) and `cwd` (a repository-relative directory inside a copied component; it defaults to the component when there is only one). A `break` adds `mutation: { path, line, before, after, safeguard }`: `line` must be a changed head line of a non-test file, `before` must occur exactly once on it, and `safeguard` names what the edit turns off. An `edge` adds `edgeTest: { path, content, codePath }`: a new file whose path looks like a test, inside a copied component, at most 64 KiB, with `codePath` naming what it probes.

The result gives the outcome, grade, exit code, duration, the receipt path, the last 40 lines of output and the remaining budget. The first `run` binds the tool to the calling session for that review; runs are serial.

## The copy

Workspaces live under the run's artifact directory, in `<runId>.tests/workspaces/`. Each component that holds a changed file (the nearest directory with `component.yml`, `package.json`, `Gemfile`, a `.gemspec`, `go.mod`, `Cargo.toml` or `pyproject.toml`, else the repository root) is cloned with APFS copy-on-write, so dependencies such as `node_modules` come along without copying their bytes. Every other entry of the checkout becomes a symlink, and the repository's `.git` is left out. The checkout and the review history must sit on the same APFS volume, and the history must not sit inside the checkout; otherwise runs are unavailable. A copy is built in a temporary directory and moved into place only when it is complete.

For a pull request, files that differ between the checkout and the head commit are rewritten from the head commit inside the copied components, and `revert` uses the merge base of base and head, the same range the review reads. A local review copies the working tree as it is and reverts to `HEAD`; if `HEAD` moved since the review started, runs are unavailable. Git reads of the checkout use a private copy of its index and run without hooks (including hooks defined in git config), filters or lazy fetches, so nothing is written to its `.git`. A file stored through a filter, such as Git LFS, is written to the copy as its stored blob, and one whose timestamps changed counts as changed. In a partial clone, objects missing locally make runs unavailable instead of being fetched.

Each run's own edits (the revert, the break or the edge file) are undone afterwards; files the tests themselves write stay for later runs. After every run the copy moves to a fresh path before the tool touches it again, and every tool write is refused if its path passes through a symlink or leaves the copy. A background process that leaves the run's process group keeps running until it exits. With the sandbox on, it can only write inside the path it started in, which the tool never uses again, or through files it already holds open.

## Sandbox and limits

With `tests.sandbox` on (the default), each run starts under `/usr/bin/sandbox-exec`. The profile denies the test's own network access, except unix sockets inside the copy; writes outside the copy, removal or replacement of the copy itself, and changes to file flags such as immutability; preference writes, which a system service would otherwise make on the test's behalf; opening apps or URLs through LaunchServices; Apple events; signals to processes outside the sandbox; and writes to terminals. Everything else stays allowed. Reads work everywhere, including files in your home directory, so a test can read the linked parts of the checkout. Other system services stay reachable too, such as the window server, screen capture, the Dock and file coordination; what a test can do with them depends on the permissions macOS has granted the terminal that runs Pi. Without the sandbox, the test code runs with your user's full permissions, and a test that writes outside its component can reach the checkout through those links; turn it off only for code you trust.

Runs get a copy of the environment without variables whose names contain `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PASSPHRASE`, `CREDENTIAL`, `API_KEY`, `PRIVATE_KEY`, `ACCESS_KEY`, `SESSION`, `COOKIE`, `AUTH` or `DSN`, or end in `_KEY`, `_PASS`, `_PWD` or `_PW`, and without variables that point git at a repository (`GIT_DIR`, `GIT_WORK_TREE` and similar). Other variables, such as database URLs, pass through. If the tests need one of the dropped variables, the baseline fails and the review says so. `TMPDIR`, `TMP` and `TEMP` point inside the copy, and `GIT_CEILING_DIRECTORIES` keeps git in a test from finding a repository above it. A run that passes the timeout gets `SIGTERM` for its whole process group, then `SIGKILL` after five seconds, and whatever is left in the group is killed when the leader exits. Only the last 1 MiB of each output stream is kept.

Settings live in `~/.pi/agent/auto-review/settings.json` under `tests`:

| Key | Default | Range |
| --- | --- | --- |
| `enabled` | `true` | `true` or `false` |
| `sandbox` | `true` | `true` or `false` |
| `maxRuns` | `12` | 1 to 40 runs per review, counting automatic baselines and interrupted runs |
| `timeoutSeconds` | `300` | 10 to 1800 seconds per run |

The first run freezes `sandbox`, `maxRuns` and `timeoutSeconds` for the rest of that review. Setting `enabled` to `false` stops further runs at once.

The feature needs macOS: it relies on APFS clones and `sandbox-exec`. Elsewhere `plan` reports it unavailable and the review continues from source.

## Receipts and completion

Each run writes `<runId>.tests/<index>-<kind>/` with `receipt.json`, `stdout.txt`, `stderr.txt` and `change.diff`. The receipt records the command, working directory, sandbox state, the validated change and its hash, the baseline it relied on, timing, exit status, outcome, grade and output hashes. The index `<runId>.tests.json` lists every run with its receipt hash, and `<runId>.tests.active` exists only while a run is in flight. A run interrupted by a crash or reload keeps its receipt when that receipt was fully written; otherwise it is recorded as `interrupted`. Either way it counts against the budget and the next run gets a fresh copy. The run's process group is killed when its leader is still the process that started it; members left behind can only write to a path the tool never uses again. While the process that started the run is still alive, the tool refuses to recover it and names the intent file.

`agentic_code_review_complete` refuses to finish while a run is in flight, when any receipt or output no longer matches its recorded hash, or when a finding cites a test run that is not in the index. On success it adds `testRuns: { path, runs, sandbox, outcomes, receipts }` to the review JSON and deletes the copies; receipts stay with the run. The hashes catch drift, not a same-user process that rewrites a receipt and the index together.

## What the outcomes do and do not prove

- A killed break shows that the selected tests notice that one edit, not that they catch every defect.
- A surviving break shows that no selected test notices it. Other tests in the repository might; the finding names the tests that ran.
- A revert that still passes means no selected test depends on the change. That is expected for a change that preserves behavior, such as a refactor.
- An edge test that holds counts only when the output shows it ran. One that breaks is a bug only when its output shows the asserted behavior failing; a load, syntax or setup error is not a reproduction.
- Outcomes rest on exit codes. The tool does not parse test-runner output, and that output comes from the reviewed code, so the review reads it as data before drawing a conclusion.
- The runs assume the change's tests are not written to deceive. A hostile test can fake its own outcomes, for example through a background process that keeps a file in the copy open across runs. The sandbox and the moving copy protect your checkout, not the honesty of the results.
