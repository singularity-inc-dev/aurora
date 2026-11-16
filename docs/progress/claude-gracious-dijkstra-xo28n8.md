# Numbers and flags (milestone 6, measurement part)

Branch `claude/gracious-dijkstra-xo28n8`. Plugin 0.11.0. OpenTelemetry and the replay script are **not** part of this branch.

## What was built

1. **Run flags on every task.** Six kinds: tool error, checks failed, not tested, timed out, budget stop, rejected (with its reason).
2. **Flagged work first in the handback email.** A block "Needs your attention first" sits right after the opening line, above notes and conflicts. Each flagged task shows once, there, with its flags, its checks line and its Approve/Reject links. The Ready/Blocked/Failed lists below show only the unflagged tasks and say how many moved up ("Blocked (2, 1 flagged above)").
3. **Numbers page** at `https://<your domain>/vt/numbers`: raw counts per person and per task kind (handed over, ready, approved, rejected, failed, not tested, teammate overlaps, would-be conflicts), a second table with how many tasks carry each run flag, and the definition of every number under the tables.
4. **CSV export of the event log** (one row per task, the columns CLAUDE.md lists, plus the run flags) and **one command** that prints the raw counts: `sudo vt-numbers`.

Raw counts only. A test fails if a percentage, rate, average or median appears anywhere in the counts, the page or the command's output.

## Test results (1 November 2026, Node 24.22.1)

- Plugin: typecheck clean, **447** unit tests pass (was 401). Email service: typecheck clean, **70** pass (was 51).
- Live suite (`scripts/integration-test.sh`, real Paperclip 2026.1012.0, real Postgres, real git, deployment rehearsal): the full run reached **386 passed, 3 failed**; the 3 were wrong expectations in my own new checks (each table line prints twice, once per table). I fixed them and re-ran `IT_ONLY=z_m6` (it runs m2, m3, the v1 scripts and `z_m6`): **170 passed, 0 failed**. I did not re-run the *entire* suite after those three one-line fixes; the parts outside `v1f`/`z_m6` were unchanged and passed in the full run.
- Two earlier full runs failed for reasons outside the code: Node 22 (Paperclip needs 24.11+), and the test users missing (`scripts/it/lib/setup-test-users.sh`, run on this throwaway container as your 25 Oct decision allows). A third run failed in m4 because it crossed an hour boundary: **m4 uses the current UTC hour to build its "night" window, so a run that crosses :00 during m4 fails.** That already existed; not changed.

## Decisions I made (please check)

1. **Base branch.** `main` lacks the handover runner, "not tested" and the shared-files check (they live in PR #4 and #7). This branch is built on #7's head (`e5b6b38`, which contains #4). The PR into `main` therefore also shows #4's and #7's commits until those merge; same pattern as #7 on #4.
2. **"A plugin page" is served by the email service** at `/vt/numbers`, like "Hand over now", not as a Paperclip UI page. A real Paperclip page needs a React bundle, a new dependency and a new capability (`ui.page.register`); Paperclip refuses capability upgrades, so the server would need a reinstall, and I cannot render-test it here. Who can see it: anyone signed in to Paperclip whose email is a person in the plugin settings. Everyone else gets 401/403. Read-only (POST gives 405).
3. **No percentages anywhere.** I removed `handoverYield` from the old `numbers` route and from `vt-numbers`. Tests fail if `yield`, `percent`, `rate`, `average` or `median` appears in the counts. The old measurement sheet still has "Minutes to approve" (a time per task, not a percentage), because the pilot playbook uses it. **The playbook still names "handover yield" as a pass mark (a percentage); it is now not computed by this command.** That is for you to decide.
4. **Flags: three are stored, three are read from the event log** (so they cannot disagree with it): stored = tool error, timed out, budget stop (table `run_flags`, migration 011); read = checks failed, not tested, rejected (+ reason). A flag on checks follows the latest result (failed checks that later pass are not flagged). Timeout and budget flags are history and stay.

## What each number means

Printed under the page tables and by `vt-numbers`. Short version: *handed over* = plan approved; *ready* = a handback email listed it Ready (once per task); *approved* = merged (a pull request still waiting for review is not counted yet); *rejected* includes rejected plans and pull requests closed unmerged, so it can exceed handed over; *failed* = timed out after retries; *not tested* = checks ran with no test command; *teammate overlaps* = pairs of tasks owned by **two different people** that changed a common file, merged cleanly or not (a pair counts once in the team row and once for each of the two people); *would-be conflicts* = those pairs git could not merge. Task kinds are `task` and `handoff` (the only two the event log has).

## Things that are not as good as they sound (blunt)

- **Rejected is not in the handback email.** The email lists undecided work. A rejected task is by definition decided, so the "rejected" flag shows in the numbers and the CSV, not in the email.
- **Tool errors only cover Aurora's own tools** (`run_checks`, `handoff_to_teammate`) on a ticket assigned to the calling agent. Errors inside the agent's own commands are invisible to the plugin. `propose_handover` failures have no ticket, so they are not flagged.
- **Overlaps are counted only from handback emails and the conflicts table.** A pair is found when a handback is built; two branches that are never both Ready at a handback are never compared.
- **Flagged work is a lot of work.** Because "checks failed" and "not tested" are flags, most blocked items will sit in the top block. That is what was asked, but expect the top block to be long on a bad night.
- Not tried: a real Claude agent producing these flags (nothing in this milestone changes that gap), and the page in a real browser (only fetched over HTTPS through Caddy in the rehearsal).

## Files

- Plugin: `flags.ts`, `flagstore.ts`, `counts.ts`, `countstore.ts`, `eventlogcsv.ts`, `csv.ts`, migration `011_run_flags.sql`; routes `counts` and `events-csv`; `briefing.ts` (top block); `handoverrunner.ts` (timeout and budget flags); `worker.ts` (tool errors). Version 0.11.0.
- Email service: `counts.ts`, `numberscli.ts`, `numbers.ts`, the `/numbers` page and route.
- `deploy/bin/vt-numbers`; live checks `scripts/it/z_m6.sh` (new), `m2.sh`, `v1f.sh`, `deploy-rehearsal.sh`; README test list.

## DEPLOY.md is now out of date (I may not edit it)

Lines 305-313 ("The pilot's numbers") say `sudo vt-numbers numbers.csv` prints "handover yield, minutes to approve, decisions per handback...". It now prints the raw counts, and still writes the measurement sheet to `numbers.csv`. Suggested replacement text:

> Type `sudo vt-numbers`. It prints raw counts per person and per task kind (handed over, ready, approved, rejected, failed, not tested, teammate overlaps, would-be conflicts) and how many tasks carry each run flag. `sudo vt-numbers --events events.csv` also writes the event log, one row per task, with its run flags. The same counts are at `https://YOUR-DOMAIN/vt/numbers` for people on the team. `sudo vt-numbers > numbers.csv` no longer writes a CSV: use `--events -` for that.

## On the server

After this is merged into `main`: `sudo vt-update`, then `sudo vt-numbers`.
