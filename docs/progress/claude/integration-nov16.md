# Integration branch `claude/integration-nov16` (16 November 2026)

One branch with the whole tested stack, so one pull request into `main` replaces nine. Built from
`origin/main` at `307a000` (which already contained PR #14, and through it PR #7, #4 and #3, merged
earlier today). The branches were merged in the order asked, with `git merge --no-ff` (never squashed),
so GitHub marks each pull request merged when this branch lands.

Order: #7, #5, #8, #9, #12, #13, #10, #14, #11. Rule for behaviour clashes: PR #12 wins (the owner chooses
the tickets, one note per task, the owner's tap is the approval, no plan ticket).

## What each merge brought

| PR | Branch | Merge commit | Commits included |
| --- | --- | --- | --- |
| #7 | `claude/handover-alignment` | already in `main` (`307a000`), merge was "Already up to date" | `0bb40c6` .. `e5b6b38` (36 commits: thin version 1 pieces A to G, the first-real-run steps 1 to 5, the Top 10 fixes) |
| #5 | `claude/intent-audit` | `1976ec5` | `d1ccaa5`, `3417fec` |
| #8 | `claude/intent-audit-pr7` | `0ffadeb` | `b1726f0`, `50bc39e` (plus #5's two, shared) |
| #9 | `claude/replay-wording` | `3b3fa97` | `25554ae` |
| #12 | `claude/trusting-archimedes-9s19hs` | `eeda763` | `66808a8`, `84caa88`, `ee29e9a`, `b6bcf34`, `3fb7b51`, `39d258b`, `66d9c1a`, `2b54631` |
| #13 | `claude/collision-audit-measurement-86prrn` | `5092775` | `e3dacaa`, `973df14`, `567cddf`, `42c0288`, `33ebe55`, `67d0bec`, `69dce32`, `08ccce7` |
| #10 | `claude/nice-faraday-4omtli` | `1db26d8` | `dea7e29`, `95cd88b`, `d1b7526`, `2cc0597`, `4c208e0`, `ac259ae` |
| #14 | `claude/gracious-dijkstra-xo28n8` | already in `main` (`307a000`), merge was "Already up to date" | `4dbf5e8` |
| #11 | `claude/modest-noether-zvi0eg` | `e490f40` | `87515c6`, `828fc97` |

Then one integration commit, `ccf740a`: plugin version 0.12.0 (the manifest gained two migrations and three
routes since 0.11.0), PROGRESS.md line 124 totals (272 replays, 144 clean replays, 1 conflict).

Every PR branch head is an ancestor of this branch (checked with `git merge-base --is-ancestor`).

## Migration renumbering

`main` already had `011_run_flags.sql` (PR #14). Two open PRs also claimed 011:

| Was | Now | From |
| --- | --- | --- |
| `011_handover_notes.sql` | `012_handover_notes.sql` | PR #12 |
| `011_replay.sql` | `013_replay.sql` | PR #11 |

Order on a fresh install: 001 .. 010 (unchanged, 005 and earlier are installed on servers), 011 run flags,
012 handover notes, 013 replay (adds `task_events.checks_base` and `saved_tasks`). Nothing numbered 005 or
lower was touched.

Comments in migrations 011 to 013 now contain no apostrophe and no semicolon:
- `011_run_flags.sql`: one comment had a semicolon ("One row per task and kind; a repeat updates the detail."), now a full stop. The SQL is unchanged.
- `013_replay.sql`: one comment had an apostrophe ("a task's work"), reworded. The SQL is unchanged.
- The guard test from PR #12 (`plugin/tests/notes.test.ts`) now refuses both characters in comments of migrations 011 and up, and a new test checks the numbering is unique and unbroken (001 .. 013).

PR #12's and PR #14's own progress notes still say "migration 011" for their tables; those notes are
history and were left as written.

## Conflicts and how each was resolved

### Merging PR #12 onto main (PR #14's run flags and counts page), 8 files

| File | Conflict | Resolution |
| --- | --- | --- |
| `email-service/src/pages.ts` | imports; the page CSS; `signInFirstPage` | Both import lines kept. CSS merged: PR #14's wide numbers page and tables plus PR #12's textarea, fieldset and ticket styles. `numbersPage` (PR #14) kept; `signInFirstPage` keeps PR #14's title parameter with PR #12's default title "Hand over". |
| `email-service/src/server.ts` | imports | Both kept (numbers page from PR #14, hand-over form types from PR #12). The hand-over page routes are PR #12's. |
| `plugin/src/briefing.ts` | `TaskFacts` fields; `gatherFacts`; the item renderer | Both fields kept (`flags` from PR #14, `digest` from PR #12). PR #14's `renderItem` (flagged tasks first) kept and extended with PR #12's note lines (what, done when, files, limits, "ticket edited" warning) in text and HTML. |
| `plugin/src/briefstore.ts` | `BriefingItem` fields | Both kept (`flags`, `note` and `ItemNote`). |
| `plugin/src/handoverrunner.ts` | imports | PR #12's runner (no plan ticket) with PR #14's flag imports. PR #14's `recordHandoff` and `HANDOFF_ORIGIN` imports dropped: the "move the ticket to the keeper" path they served was removed by PR #12 (an overlap now refuses the whole hand-over). PR #14's timeout and budget-stop flags were already in the auto-merged body. |
| `plugin/src/worker.ts` | imports | Union; PR #14's `proposeHandover` and `startHandoverNow` imports dropped (those functions no longer exist; PR #12's `handOver` replaces them). |
| `plugin/tests/fakedb.ts` | table list | Both tables (`run_flags`, `handover_notes`). |
| `scripts/it/v1f.sh` | the numbers checks | PR #14's shape (counts only, no yield or percentage, the two-table vt-numbers output) with PR #12's totals (7 work orders, 1 accepted, 1 rejected, 5 undecided; per owner 6 and 1). PR #12 expected a `handoverYield` of 0.14, which PR #14 removed from the numbers on purpose. |

Follow-ups inside the same merge commit:
- PR #14's five "run flags from the handover" tests in `plugin/tests/handoverrunner.test.ts` used the plan-ticket helpers (`proposedNight`, `approve`) that PR #12 deleted. They were ported to `handOver(...)` and keep their assertions, with two wording changes: the final time-out flag reads "its time limit of 120 minutes was reached" (PR #12's note limit, 60 minutes x 2 attempts, is what fails the task now, where PR #14 said "timed out 2 time(s) after 60 minutes"), and "a rejected plan is a rejected flag" became "a rejected task is a rejected flag" (there is no plan to reject; the outcome comes from the Reject link).

### Merging PR #13 (collision measurement), 2 files

`tools/collision-audit/_audit.py` and `tests/test_audit.py` were add/add conflicts: `main` has these files
from commit `0137939` unchanged, and PR #13 copied the same commit and added to them (a fixed end date and
tests of the truncated-clone guard). PR #13's versions taken whole. 24 Python tests pass.

### Merging PR #10 (B1, B4, B5, time-outs) onto PR #12, 4 files

PR #10 was written against the plan-ticket flow. Kept from it, now applied to PR #12's owner hand-over:
retries with backoff on every Paperclip call (`again`), bounded per-person ticks (`bounded`, `PERSON_TICK_MS`),
git time-outs, the window cut-off rule (`StepClose.cutOff`, `WINDOW_ENDED`, `waitingForCutOffTask`: a task the
window cut off keeps its board status and the handback waits up to one step time-out for it), late blocked or
failed work shown Ready with Approve in the next handback (B4, B5), the orphaned-claims sweep (B1), and the
email service time-outs.

| File | Conflict | Resolution |
| --- | --- | --- |
| `plugin/src/checks.ts` | imports | Both (`changedFiles` and `fileAllowed` from PR #12, `GIT_TIMEOUT_MS` from PR #10). |
| `plugin/src/handover.ts` | `StepClose` and constants; the `proposing` / `awaiting_approval` cases | Both constants kept (`BUDGET_STOP_REASON` from PR #14, `WINDOW_ENDED` and `cutOff` from PR #10). The old statuses expire at once (PR #12); PR #10's planning time-out and approval reading are gone with the plan ticket. |
| `plugin/src/handoverrunner.ts` | 10 hunks | Imports: union, minus the plan-flow names. `readApproval`, `proposeAndAsk`, `planDetails` and the planning retry: dropped (no plan ticket). `expire`: PR #10's retried update first, then PR #12's `noticeTicket` comment. `retry-step`: PR #12's task-only retry with PR #14's flag, PR #10's "wake first, then comment" order and retries. `advance`: PR #14's flags plus PR #10's cut-off rule. `suggestTasks`: PR #12's (drafts only, no claims, so B1's release-on-failure does not apply). |
| `plugin/tests/handoverrunner.test.ts` | one block of tests | PR #12's tests kept (see "tests dropped" below for PR #10's). |

A real behaviour clash found while testing, fixed in the merge commit: PR #10's `releaseOrphanedClaims`
releases any claims that no handover run lists. PR #12 stores the claims of a note queued for the next
scheduled handover before any run exists, so the sweep would have freed those files on the next tick and
the pre-handover check would no longer have protected them. The sweep now takes the queued task ids and
keeps them (`releaseOrphanedClaims(db, company, owner, keep)`); a new test covers it.

Tests from PR #10 adjusted to PR #12's rules:
- `plugin/tests/latework.test.ts` (5 tests): the config gets `serviceUserId` and the route calls use that user (PR #12 refuses every route to anyone else); Approve passes `signedInAs` (PR #12 refuses an Approve without the owner signed in); section headings follow PR #14's "flagged above" wording where the task carries a flag.
- `plugin/tests/timeouts.test.ts`: the "running handover" helper now comes from the owner's tap (`handOver`) instead of a proposed and approved plan; the "one slow person" test queues a ticket for each owner and checks the scheduled start.
- `email-service/tests/timeouts.test.ts`: `execute(token, reason)` gained PR #12's third argument, the signed-in owner.

### Merging PR #11 (replay and tracing), 6 files

All additions on both sides: `plugin/src/manifest.ts` (routes `counts`, `events-csv` and `replay-save`),
`plugin/src/worker.ts` (imports and the three route handlers), `plugin/tests/fakedb.ts` (tables),
`email-service/src/paperclip.ts`, `email-service/tests/m5.test.ts` and `tests/service.test.ts` (the plugin
API and its doubles). Everything kept. `plugin/tests/replaysave.test.ts` gets PR #12's service user for its
route calls.

## Tests dropped (contradict PR #12) and tests ported

Rule: keep every test; where two contradict, keep PR #12's and list the other here.

Dropped, because they exercise the agent's plan ticket, the `propose_handover` tool and Paperclip's plan
approval, none of which exist after PR #12 (the owner chooses the tickets and the tap is the approval):

| From | Test | Why it cannot exist now |
| --- | --- | --- |
| PR #10 `handoverrunner.test.ts` | "a GitHub team in CODEOWNERS: the plan warns, naming the team, and the admin's view lists it" | No plan. PR #12's own version ("warns the owner about GitHub teams in CODEOWNERS") checks the same warning on the owner's hand-over. The `codeowners` data view is unchanged and still covered by the route audit. |
| PR #10 | "a later claim on the same files goes to the owner who claimed them first" | Overlaps are refused, not moved (PR #12). PR #12's "files a teammate's handed-over task holds are refused until that task is decided" covers the rule. |
| PR #10 | "claims end when the task is decided or its plan expires" | No plan expiry; PR #12's tests cover release on decision and on withdraw. |
| PR #10 | B1: "on failure: asking for the plan approval throws" | No plan approval. |
| PR #10 | B1: "on failure: the run changed while proposing" | No proposing state. |
| PR #10 | B1: "a failure after the run is saved keeps the claims" | No proposal. |
| PR #10 | B1: "on restart or time-out: claims a crash left behind end when that plan expires, never while it is still proposing" | Ported (below) without the "proposing" half. |
| PR #10 | B1: "claims of tasks a handover lists are never swept" | Ported (below). |
| PR #10 | "never passes on a guess: an unreadable repository refuses the proposal" | PR #12's "warns the owner about GitHub teams ... never passes on a guess" asserts the same refusal on the owner's hand-over. |
| PR #10 `timeouts.test.ts` | "an agent that never proposes is woken again on the plan ticket, once, then the plan expires as before" | No planning step. |
| PR #10 `timeouts.test.ts` | "a plan the agent already proposed is never re-woken" | No planning step. |
| PR #14 `handoverrunner.test.ts` | "a rejected plan is a 'rejected' flag ..." | Ported as "a rejected task is a 'rejected' flag ..." (the Reject link sets the outcome). |

Ported, in `plugin/tests/handoverrunner.test.ts`, describe "claims a failed hand-over left behind end on a later tick (B1, PR #10)":
- "claims that no handover and no queued note lists (what a crash mid hand-over leaves) are released, and the files are free again"
- "claims of tasks a handover lists, and of notes queued for the next scheduled handover, are never swept" (the second half is new; it is the clash described above)

Also ported: PR #14's five run-flag tests (see the PR #12 section).

### Live checks adapted (first full run: 448 passed, 9 failed)

- `scripts/it/z_m6.sh` (PR #14's counts checks, 7 of the 9): they expected PR #14's m4 data (5 work orders, Ana as
  `ana@example.com`, one teammate conflict pair, a budget-stopped ticket with one flag). Under PR #12 the same bed
  has 7 work orders owned by the signed-in Paperclip user (only the owner can hand over), the hand-over into Bo's
  files is refused instead of run (so v1e's only replay conflict is between Ana's own two tasks: no teammate pair),
  and the budget-stopped ticket also carries a tool-error flag from PR #12's refused hand-off. The checks now say
  so, the same way PR #12 had already adapted v1f. Commit `db4bbec`.
- `scripts/it/m3.sh` SLOW section (2 of the 9): see below under "not reconciled".

## Not reconciled, say so plainly

- **m3 with `SLOW=1`, "a step past its time limit is retried" and "retry releases the task to the agent again": fail,
  and were not made to pass.** Cause, read from the ticket and the plugin data: in the test bed no agent really runs,
  and Paperclip 2026.1012.0's own heartbeat recovery marks the idle ticket `blocked` about 2.5 minutes after it is
  released ("Paperclip exhausted the bounded original-owner disposition repair"). The plugin then sees a stopped task
  ("agent marked the task blocked") and ends the handover, so its 5-minute step time-out never gets to retry. PR #12
  said this SLOW check was never run on its branch; PR #11 ran it (passing) on PR #7's code, where the slow task
  came from the agent's proposal. The plugin's retry itself is covered by unit tests (`timeouts.test.ts`,
  `handoverrunner.test.ts` "a stuck task is retried once within its time, then fails", and the ported run-flag
  tests). Worth knowing for a real run: a real agent whose run truly hangs may also be blocked by Paperclip's
  recovery before our step time-out, and would then be reported as blocked, not retried.

- PR #12's progress notes and PR #11's notes still describe their migration as 011 and the plugin as 0.11.0. Left as written; this file is the record.
- PR #12's hand-over page and PR #14's numbers page share `page()` in `email-service/src/pages.ts`; the merged CSS serves both. Not checked in a browser, only through the service tests.
- PR #10's "planning retry" idea has no equivalent now: with no plan step there is nothing to retry before work starts. If an agent never picks up a ticket, the task's own step time-out and retry (PR #12 and PR #14 flags) apply.

## Test results

RESULTS_PLACEHOLDER
