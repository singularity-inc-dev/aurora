# Progress: the owner's handover (branch `claude/trusting-archimedes-9s19hs`)

Notes for this branch only (PROGRESS.md is left alone). Built on `claude/handover-alignment`
(PR #7, which contains PR #4), because `main` does not yet have the handover code at all.

## What was asked (6 items) and where it is

| # | Rule | Built | Unit tests | Live tests |
| --- | --- | --- | --- | --- |
| 1 | A handover note per task: what, done when, limits (files, time, budget), in one place | `plugin/migrations/011_handover_notes.sql`, `plugin/src/notes.ts` | `notes.test.ts`, `handoverrunner.test.ts` "1." | m3 (brief on the ticket), m4 (note in the email), rehearsal (note in the email over SMTP) |
| 2 | Hand over now and scheduled run exactly the owner's tickets; the agent cannot add, swap or rewrite | `handOver`, `start-queued` in `plugin/src/handoverrunner.ts`, `plugin/src/handover.ts` | `handoverrunner.test.ts` "2." | m3, v1c, m4, m5 |
| 3 | The tap is the approval; no plan approval | runs are created `approved`; no plan ticket, no `requestConfirmation` | `handover.test.ts`, `handoverrunner.test.ts` "3." | m3, v1c, rehearsal |
| 4 | Only the owner hands over or approves their own tasks | `callerRefused` (`serviceUserId`), `executeLink(..., signedInAs)`, email service sign-in check | `links.test.ts`, `service.test.ts`, `m5.test.ts`, `handoverrunner.test.ts` "4." | integration-test.sh section 8, m4 (Bo's link refused for Ana), v1c, rehearsal (Dee) |
| 5 | Help me plan: optional, off by default, still needs the owner's tap | `helpMePlan` per person, `askForSuggestions`, `suggestTasks` (drafts only) | `handoverrunner.test.ts` "5." | m3 |
| 6 | User-facing text matches | Hand over page, link pages, handback email, agent's brief, tool text, README | `service.test.ts`, `m5.test.ts` | m4, rehearsal |

## Decisions taken in this branch (say if you disagree)

- **Notes table.** `handover_notes` holds one row per task handed over (status draft, queued, handed_over, withdrawn). The event log stays one row per task; claims still live there too (copied from the note) because the pre-handover check and the replay read them there.
- **The tap is the approval.** A run is created already `approved` with exactly the owner's tickets. Old runs still waiting in `proposing` or `awaiting_approval` expire with "plans are no longer approved in Paperclip".
- **Scheduled.** "Hand over at my scheduled time" queues notes. The next scheduled window runs exactly the queued notes (compare-and-swap per note). With nothing queued, the schedule does nothing (no plan ticket, no agent wake-up, no model spend).
- **Pre-handover check on owner work.** An overlap with a teammate's area or held files refuses the whole hand-over; nothing is moved to anyone (the old "move it to the keeper" behaviour, DEVIATIONS B5, is gone for owner work). The overlap is still recorded for the numbers.
- **Limits are enforced, not just shown.**
  - Files: the checks gate adds a `files` check (`git diff --name-only --no-renames`); any committed file outside the note fails the gate.
  - Time: total minutes since the task first started (retries count); past it the task fails. Default = step time-out × (retries + 1), at most the handover length.
  - Budget: agent spend since the task started; at it the task is blocked and the next starts. Default and maximum = the person's cap per handover. The per-handover cap and agent pause stay.
- **Done when is not machine-checked.** The handback prints it as "your words; Aurora does not check this, you do". The WIP branch's test-name grep was dropped as fragile.
- **Only the owner, two layers.**
  - Every plugin route refuses any caller except `serviceUserId` (the Paperclip user who owns the email service's API key; `vt-setup` and `vt-update` fill it from the new `/caller` route). Missing = every route refused, and the route audit (vt-check) says so.
  - Approve/Reject: the email service passes who is signed in to Paperclip in that browser; the plugin refuses anyone but the task's owner before the link is used up. No sign-in = no button.
- **Help me plan.** Per person, off by default. The agent's suggestions become backlog tickets with draft notes on the owner's page; no run, no claims, no approval request.
- **Agent cannot swap.** `handoff_to_teammate` refuses a ticket in its owner's running or queued handover. Editing the ticket text is detected (fingerprint) and shown on the handback; the locked note is what counts.
- **Not renamed.** The plugin is still shown as "Vision and Tom" in Paperclip, because FIRST-REAL-RUN.md and DEPLOY.md (not mine to edit) name it so. Only the conflict email line and the manifest description now say Aurora.

## WIP branch (`claude/handover-alignment-wip`): kept and dropped

- Kept (rewritten): check every ticket before changing anything; lock the note; post it on the ticket; refuse a hand-off of a handed-over ticket; give an owner-written ticket its own worktree.
- Dropped: note columns on `task_events` (the data model says one place of its own); done-when test-name grep; agent proposals approved through Paperclip's "any human" confirmation; the "Vision and Tom" to "Aurora" rename commit (it touches deploy files the first real run uses).

## Blunt list of what is still weak

- **The admin is trusted.** `serviceUserId` is the owner who made the email service's API key, usually the admin. The admin, signed in to Paperclip, can call the plugin's routes directly and so act for anyone. A separate service account would close this; not built.
- **Email links still need the email.** Approve now also needs the owner's Paperclip sign-in in that browser. On a phone that means signing in to Paperclip there once.
- **The agent can still use its own Paperclip key.** It could move a queued ticket out of Backlog or edit its text. The plugin cannot block that; it detects text edits and only ever runs the owner's list.
- **Per-task budget counts the agent's spend**, not the ticket's. That is correct only because tasks run one at a time.
- **The plugin cannot stop a running agent.** Past a task's time or budget the ticket is set to blocked, but a run already going may finish first (same as before; DEVIATIONS B5).
- **`issue.interactions.*` capabilities stay in the manifest** though unused now. Removing them is safe in principle but was not live-tested; a later cleanup.
- **Not yet run with a real Claude agent** (as before).

## Test results (1 November 2026, cloud test machine, Node 24.22.2, Paperclip 2026.1012.0)

- Unit tests: plugin **434 passed**, email service **57 passed**; both typechecks clean.
- Full live suite, cold start, `scripts/integration-test.sh` on commit `66d9c1a`: **383 passed, 0 failed** (about 30 minutes), of which the deployment rehearsal **117 passed, 0 failed**. Run after `scripts/it/lib/setup-test-users.sh` (allowed on throwaway cloud machines, CLAUDE.md 2026-10-25).
- `IT_ONLY=m3`: 61 passed, 0 failed. The SLOW=1 real 5-minute time-out was not run.
- Earlier runs on the way, for the record:
  - Paperclip refused to install the plugin: an apostrophe in a comment of migration 011 (Paperclip reads it as a quote). Fixed; every statement checked with Paperclip's own validator; a unit test now guards new migrations.
  - 116/1: the rehearsal waited 30 s for the handback email, but a server sends mail every 60 s. Test fixed.
  - 382/1: a v1d check printed three results on one line. Test bug, fixed.
- **Live proof of the security hole and its fix:** in the rehearsal, Dee (signed in, operator) calling the plugin's route directly got the plugin's own "403 only the Aurora service may call this". So Paperclip does let any signed-in member reach board routes (CURRENT-STATE S1 was real), and the new guard closes it.
