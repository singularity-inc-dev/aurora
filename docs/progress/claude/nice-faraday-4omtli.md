# Progress: `claude/nice-faraday-4omtli` (1 November 2026)

Bug fixes from `docs/design/CURRENT-STATE.md` (branch `claude/architecture-blueprint`, PR #6), one commit each, test first.

## Base: read this first

**`main` does not contain the code these bugs are in.** The handover engine, proposals and claims only exist on
unmerged branches. This branch is built on `claude/handover-alignment` (PR #7, unchanged, commit `e5b6b38`),
which already contains `main`. So:

- The pull request into `main` shows PR #7's changes as well as these four commits until PR #7 is merged.
  **Merge PR #7 first**; then this pull request shows only the four commits below.
- "Rebase on the latest origin/main" was a no-op: `main` is still `041fe60`, already in this branch. A literal
  `git rebase` flattened PR #7's merge commit and rewrote 39 of its commits, which would have clashed with #7,
  so it was undone.

Not touched: FIRST-REAL-RUN.md, DEPLOY.md, PROGRESS.md, the plan ticket text and the handover note/handover
wording (Owner_Handover owns those). No new plugin capability, no settings change, no migration, so the plugin
version and manifest are unchanged and an update needs no reinstall.

## The fixes

| # | Bug (CURRENT-STATE) | Commit | What changed |
| --- | --- | --- | --- |
| 1 | B1 orphaned claims | `dea7e29` | A proposal that fails after storing claims releases them before returning the error. Once the run is saved, the claims belong to it and are kept. A crash or time-out skips that, so every tick also releases an owner's claims that no handover lists, unless that owner still has a plan in "proposing" (it may be mid-proposal). A crashed proposal holds files at most until its plan expires. |
| 2 | B4 late work rejected-only | `95cd88b` | "Blocked" is no longer final. When a handback is built, a blocked task that is Ready by the normal rules (ticket done or in review, worktree clean, checks passed on exactly the branch head) has its outcome cleared and gets a normal Approve link. The handback waits up to one step time-out (default 60 min) after the window for the task the window cut off. A task cut off by the window keeps its board status (the plugin cannot stop the run). Budget-cap stops still flip it to blocked. |
| 3 | Time-outs and retries everywhere | `d1b7526` | Plugin: git commands are killed after 2 min; each person's tick is waited for at most 2 min, then the loop moves on and that person is skipped until it settles; waking the agent and moving tickets are retried with backoff (0.5 s, 1 s); comments are best effort and come after the wake; planning gets a time-out and retry (re-wake on the plan ticket, no new text). Email service: every HTTP call has a 30 s limit; GET and "mark sent" are retried with backoff on network errors, time-outs and 5xx; git push has a 5 min limit; SMTP has explicit limits. |
| 4 | B5, its real-night effect | `2cc0597` | Same rule as #2 for "failed": a task failed by its time-outs whose work lands later and is Ready gets Approve. |

### Why #4 is B5 and what B5 really is

I read Paperclip 2026.1012.0's server code (package `@paperclipai/server`, `modules/wake-queue/application/use-cases.js`,
`services/issues.js` `clearExecutionRunIfTerminal`). A ticket has an execution lock (`executionRunId`). A wake on a
ticket whose lock is held by a running run is **coalesced into that run or deferred until it ends**. So a retry does
**not** start a second run in the same worktree. This comes from reading the code. **Not live-tested** (roadmap 1.16 is still open).

What does happen on a real night: the retry is wasted, because the first run is still going. A task that honestly
needs more than 2 hours (60 min + 1 retry) is marked failed while the agent keeps working. Before #4 that work
could only be rejected.

### Other bugs in the list, and why they were not done

- **B2** (crash between storing a handback and its link rows): needs a crash in a window of milliseconds. Unlikely on one night. Fix is the operations journal (roadmap 1.13).
- **B3** (undecided tasks hold claims forever): shows from the second night on if an owner skips a decision, not within one night. The fix (release after N handbacks, and say so in the email) changes handback text, so it was left for its own change.
- **B6** (tasks one at a time): a design limit, roadmap phase 3.
- **B7** (merge commit locally vs squash on GitHub): not a night problem.
- The S-items are security findings, not night bugs. **S1 (board routes do not check who calls) is still the most serious open problem in the code.**

## Blunt list of what is still broken or unproven

- **Not live-tested by a real agent.** The new behaviour is covered by unit tests with real git and the SDK test
  harness, plus the existing live suite (results below). No live check was added for late work or for retries,
  because the live test bed cannot make a Paperclip call hang on purpose.
- **Orphan tickets.** B1 now frees the claims, but tickets created by a proposal that failed halfway stay in the
  agent's backlog. They show up in the next plan as "Tickets already waiting for you", so the agent can propose
  them again by issueId. They are not cancelled automatically.
- **Planning retries need the agent's old run to be over.** Re-waking the plan ticket while the old planning run
  still holds the lock is deferred by Paperclip (same as tasks). If the agent is truly stuck, the plan still
  expires at the usual time.
- **After a task fails, the next task's wake may wait behind the slow run.** If the agent can run only one thing at
  a time, the next task does not start until the slow run ends. That is B6 territory and was not changed.
- **A GitHub merge that times out after GitHub actually merged** is reported as failed and the task comes back next
  morning. This already happened on any network error; the new 30 s limit makes it a little more likely on a very
  slow GitHub. The waiting-PR sync does not cover this case.
- **Wording of new log messages only.** The only new user-visible text is in the plugin log. Handback reasons and
  ticket comments are unchanged.
- Dependency drift seen, not caused here: the email service's lockfile has nodemailer 10.1.7; CLAUDE.md says 10.0.16.

## Tests

Unit (after all four commits): plugin **425 passed** (was 401), email service **59 passed** (was 51). Typecheck is clean in both.

New test files: `plugin/tests/latework.test.ts` (real git, real Approve link: late work approved and merged,
never finishing, finishing after the handback, failed checks stay Reject-only, slow failed work approved),
`plugin/tests/timeouts.test.ts` (backoff, a stuck `git` on PATH, a stuck person's tick, a flaky wake, a failing
comment, the planning retry), `email-service/tests/timeouts.test.ts` (silent and flaky servers, no retry for
one-time actions or 4xx, a stuck push, SMTP limits). B1 tests are in `plugin/tests/handoverrunner.test.ts`.

Live (`scripts/integration-test.sh`, cold start, includes the deployment rehearsal): **running; result to follow in this file.** A first run failed in the deployment rehearsal only (38 passed, 71 failed) because this fresh cloud machine had no OpenSSH and no test users; `scripts/it/lib/setup-test-users.sh` was then run (allowed on throwaway cloud test machines, CLAUDE.md 2026-10-25) and the suite restarted from a cold start.

## How to test it yourself

1. `. ~/.nvm/nvm.sh`
2. `cd plugin && pnpm install --frozen-lockfile && pnpm test` (expect 425 passed)
3. `cd ../email-service && pnpm install --frozen-lockfile && pnpm test` (expect 59 passed)
4. Just the new behaviour: `cd plugin && npx vitest run tests/latework.test.ts tests/timeouts.test.ts tests/handoverrunner.test.ts` and `cd email-service && npx vitest run tests/timeouts.test.ts`
5. Live: `scripts/integration-test.sh` from the repository root
