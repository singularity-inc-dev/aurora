# Progress

Updated after every phase. Newest phase first.

## Ready for the first real run (spec gap 3): steps 1 to 5 done

Five steps, one commit each. Nothing real was rented, signed up for or contacted. Your next step is **FIRST-REAL-RUN.md**.

**Final full live run** (cold start, all five steps): **356 passed, 0 failed** (basic 20, M2 30, M3 33, M4 39, M5 39, deployment rehearsal 109, v1a 24, v1b 13, v1c 12, v1d 15, v1e 10, v1f 12; it was 320 before these steps). Unit tests: plugin 388, email service 51, collision audit 9. All four lockfiles audit clean.

**Works live** (against real Paperclip 2026.1012.0, real git, real SMTP with STARTTLS, Caddy HTTPS, PostgreSQL 16 and the real deploy kit, with stand-ins for GitHub and Claude):
- The patched Paperclip install, from the lockfile.
- A crash mid-approval: the email service was killed while GitHub merged, and the recovery finished it after a restart.
- A join failing halfway, then finishing with the same account and one agent.
- The CODEOWNERS team warning, in `vt-check`.
- `vt-stop` / `vt-start`.
- `vt-update` forward and back.

**Unit-tested only:**
- An invite try taken over after 10 minutes, and the five-try limit.
- "Saved but not reported" joins.
- The tick finishing an interrupted local merge, and releasing an interrupted Reject or a GitHub approval older than a day.
- Recovery when the pull request was closed or the branch moved.
- The team warning on a plan (live: the plugin's view of it).
- `vt-update` refusing during a running handover.

**Unverified** (needs a real server or real accounts, FIRST-REAL-RUN.md):
- Real GitHub (branch protection with a second person's review), a real email provider, a real Claude sign-in and agent run.
- systemd, a real reboot, and `vt-stop` holding across it.
- `vt-update` downloading from the real GitHub with the `vt-download` token.
- An update that changes the Node, Caddy or Paperclip versions (rehearsed: a Paperclip restart caused by a changed service file).
- The 7 Dependabot alerts the audit here does not show (step 1).

### Step 1. Dependency vulnerabilities (done)
I could not open GitHub's Dependabot page from the cloud session, so I listed the same advisories (GitHub's Advisory Database) with `pnpm audit` / `npm audit` on the four lockfiles GitHub scans.

| Where | Package (version) | Severity | Advisory | Fixed by |
| --- | --- | --- | --- | --- |
| plugin, email service (tests only) | vitest 3.2.4 | critical, moderate | GHSA-5xrq-8626-4rwp, GHSA-82fw-gwwq-j7x9 | vitest 4.1.12 |
| plugin, email service (tests only) | @vitest/mocker 3.2.4 | moderate ×2 | GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8 | comes with vitest 4.1.12 |
| plugin, email service (tests only) | tinypool 1.1.1 | critical ×2 | GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr | no longer used by vitest 4 |
| email service (server) | nodemailer 10.0.16 | moderate ×3 | GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h | nodemailer 10.1.7 |
| Paperclip on the server (inside paperclipai 2026.1012.0) | zod 4.1.11 | high | GHSA-mrhx-c7xc-m3w5 | override to 4.6.7 |
| same | body-parser 2.3.0 | high | GHSA-27r3-jxmh-p828 | override to 2.4.0 |
| same | multer 2.4.0 | high | GHSA-q7qp-rjg7-q26m | override to 2.5.0 |
| same | uuid 10.0.0 | moderate | GHSA-w5hq-g745-h8pq | override to 11.1.1 |
| Claude Code for the agents | (none) | | | |

- **Paperclip stays pinned at 2026.1012.0.** The four packages inside it are replaced only in their vulnerable ranges (pnpm `overrides` in `deploy/paperclip/package.json`); the lockfile changed in those four packages only. uuid 11 is a new major version; Paperclip's only user of it (svix) calls `v4()`, which is unchanged.
- I took the smallest jump that carries each fix. Most fixes are only 3 to 14 days old (body-parser and multer: 3 days).
- After the fixes, all four audits report **no known vulnerabilities**.
- **Not fixed:** nothing on the server. The local test bed still starts Paperclip with `npx` (without our overrides), so it runs the old inner packages; it listens on 127.0.0.1 only and holds test data only. The deployment rehearsal installs Paperclip from the patched lockfile, as the server does.
- **Found by the live run and fixed:** the handover tick sometimes failed at once with "invalid invocation scope". Paperclip refuses a plugin call made outside any request (the tick loop's list of companies) while another request is in flight. The tick now retries that call and otherwise uses the last list that worked (2 unit tests). The merge-replay live test (v1e) also stops cleanly if a task gets no worktree, instead of writing its test files into the current folder.

**Tests:** unit: plugin 369, email service 39. Full live run (cold start): **320 passed, 0 failed** (rehearsal 83 of them, which installs Paperclip from the patched lockfile).

**GitHub's own count.** On push, GitHub reported 26 alerts on the default branch `main` (8 critical, 3 high, 15 moderate). The audit here finds 19 on `main` (the table above). The other 7 are only on the Dependabot page, which this session cannot open, and the network here does not allow the other public database (osv.dev). Dependabot alerts are for `main`, so they close only when this branch is merged. **Please look at github.com/singularity-inc-dev/aurora/security/dependabot** and send me any alert that is not in the table above.

### Step 2. Robustness (spec gap 27) (done)
**A join that fails halfway no longer uses up the invite.**
- A failed try gives the invite back, with what it already made (the account, the agent). The page says "Your invite link still works". After 5 failed tries it is used up; it still expires after 48 hours.
- Every join step is safe to repeat. An account from an earlier try is signed in with the same password (another password shows the form again: "type the same password you chose then"). A person already in the company is not added again. The agent made earlier is found by its own environment and locked down again, never made twice. A settings row already saved is not saved twice.
- One try at a time (compare-and-swap on a new `attempts` counter, migration 009). A try that never reports back (the email service stopped mid-join) is taken over after 10 minutes, and its late report is ignored. If the settings were saved but the report was lost, the next visit records the join ("You have already joined").

**A crash mid-approval no longer leaves a task "in progress".**
- The email service marks each approval it is publishing as in flight. Every 10 minutes (with the pull-request check) it asks the plugin for approvals still in progress after 15 minutes (`links/stuck`, board-only) and finishes each one on GitHub: if GitHub already merged the approved commit, that is recorded; if its pull request was closed, the approval is given up; otherwise the publish runs again, which is safe to repeat (same commit, no force push, the open pull request is reused, GitHub merges only that head). The result goes back through `links/recover`. A given-up approval releases the task, which comes back in the next email with fresh links.
- The plugin's handover tick finishes the rest after 15 minutes: an approval without GitHub (the local merge, version check included), a Reject (its reason was lost, so the task is released), a click whose task was already decided (only the link record is closed). A GitHub approval the email service could not finish within a day is released.
- Plugin version 0.10.0 (two new routes; no new permissions).

**Tests:** unit: plugin 380 (invite retries, take-over, five-try limit, saved-but-not-reported; stuck approvals listed only after 15 minutes, recovered once, released; local merge finished by the tick; interrupted Reject; the version check), email service 51 (second try reuses account and agent; another password; last try; in-flight marking; recovery against the stand-in GitHub with real git: not yet published, already merged, waiting for review then merged, closed, branch moved, GitHub unreachable). Live (`IT_ONLY=m5` and the rehearsal):
- **M5, 39 checks, 0 failed** (8 new). Approve was held at GitHub's merge step, then the email service was killed. The task was stuck "in progress" (decision held, nothing merged). After a restart, the link said "in progress", and within two minutes the recovery finished it: accepted, ticket done, merged once through the same pull request at exactly the approved commit.
- **Rehearsal, 93 checks, 0 failed** (10 new, over HTTPS on the real kit). Fay's join failed halfway (Paperclip refused her agent after her account and membership were made). The page said the link still works, and the link still opened. A try with another password showed the form again. A try with the same password joined: her account from the first try was reused, she has exactly one Paperclip account and exactly one agent, locked down, and the link was then used up. The audit then had one thing left for her, choosing her own Claude access, and accepted every agent after she chose it.


### Step 3. CODEOWNERS teams (done)
A GitHub team entry (`@org/team`) matches nobody, because Aurora cannot see who is in a team. So the pre-handover check protects nobody in that area. Now it says so, naming each team and its lines:
- **Every plan** the owner approves starts its notes with: "WARNING: CODEOWNERS names GitHub teams @acme/leads (line 1), @acme/web (lines 2, 3). Aurora cannot see who is in a team, so nobody is protected in those areas. Ask your admin to list the people instead (their GitHub login, e.g. @ana, or their email), next to or instead of the team."
- **`sudo vt-check`** (the admin's check) prints `WARNING  CODEOWNERS names the GitHub team @acme/web (line 1); ...`, one line per team, and ends "All good, but 1 warning(s) above." A warning does not make the check fail. With people only, it says "CODEOWNERS names people only (no GitHub teams)".
- Behind it: a read-only plugin data view `codeowners` (the committed file at the project's main branch, as the pre-handover check reads it).

**Tests:** unit: plugin 384 (team entries told apart from people; the warning text; an area owned only by a team lets a task through, which is why the warning matters; the plan shows the warning; the admin's view lists the team). Live: v1a to v1d **84 passed, 0 failed** (the plugin's view names `@acme-v1d/ops` and line 3, with the plan's warning text); rehearsal **94 passed, 0 failed** (`vt-check` on the real kit names `@acme/web`, line 1, and does not fail for it).

**Test machine change (your answer: allowed on cloud test machines):** `scripts/it/lib/setup-test-users.sh` now also makes a fourth test agent user, `vt-agent-cy`. The rehearsal's third stand-in was the checks user, whose home is read-only, so Paperclip could not use it for Fay's agent once she really joined (step 2's new checks); `vt-check` reported that.

### Step 4. FIRST-REAL-RUN.md and an emergency stop (done)
- **FIRST-REAL-RUN.md**: a short checklist for the first real run: the server (DEPLOY.md steps 1 to 11), one email account used only for sending, one protected test repository (CODEOWNERS naming people, a required review by a second person, because GitHub never lets an author approve their own pull request), your own Claude sign-in for your agent, one real handover from a backlog ticket to a merged pull request, what you should see at each step, and how to stop everything. 🔑 marks the steps only you can do. README.md and DEPLOY.md point to it.
- **`sudo vt-stop`** stops everything at once: Paperclip, every agent (including programs an agent left running under its own user) and the email service, so Approve, Reject and invite links do nothing. It stays stopped after a restart of the server, until **`sudo vt-start`**, which ends with `vt-check`. Nothing is deleted; Caddy and the backups keep running. The guide also lists the outside stops only you can do: revoke the `vt-push` token on GitHub, power the server off.

**Tests:** rehearsal **98 passed, 0 failed** (4 new: an agent's leftover program is ended, Paperclip and the email links answer 502, everything comes back with `vt-start` and `vt-check` passes). Found while testing: right after a program is ended it can still be listed for a moment, so `vt-stop` once reported a leftover that was already gone; it now re-checks for up to 10 seconds and does not count such ended programs.

### Step 5. Updating a running server: `sudo vt-update` (done)
`vt-update` (or `vt-update NAME` for a branch, tag or commit) changes the version without a full reinstall:
1. Downloads the new version and shows what changes: the old and new commit, the plugin's version, and whether Node, Caddy or Paperclip change.
2. Refuses a folder changed by hand, and refuses while a handover is running (`--now` overrides).
3. Makes a backup.
4. Stops the email service and the plugin, then runs `install.sh` from the new version, which only changes what is different.
5. Restarts Paperclip and Caddy only if what they run changed.
6. Takes the plugin back into Paperclip: a new version is reinstalled (its settings and data are kept), the same version is restarted.
7. Starts the email service again and ends with `vt-check`.

If any step fails, it prints the line that goes back (`vt-update <old version>`) and the backup made in step 3.

**Found by the rehearsal and fixed:**
- Paperclip watches the plugin's folder, so it restarted the half-built plugin during the update and then refused the new version ("Worker already registered"). The plugin is now stopped before its files change.
- Paperclip's settings file got a new timestamp on every install, which would have restarted Paperclip on every update. It is now rewritten only when a setting changes.
- The rehearsal's stand-in for systemd started a second copy of a service that was already running; like systemd, it now does nothing.

The rehearsal now installs the app with `git clone`, as DEPLOY.md step 6 does.

**Tests:** rehearsal **109 passed, 0 failed** (11 new):
- "nothing new" makes no backup and changes nothing; a hand-changed folder is refused.
- An update to a new version (plugin 0.10.0 to 0.10.1, and a changed Paperclip service file, so Paperclip restarts while Caddy keeps running): backup first, the app at the new commit, the new plugin ready in Paperclip, three people and their used invite links kept, Fay still signs in, `vt-check` passes.
- Going back to the old commit: plugin 0.10.0 ready again, the data still there.

## Thin version 1 for the pilot (done)

Milestone names now follow the spec (see CLAUDE.md, "Milestones" and "Built so far").

**Full live run on 25 October** (`scripts/integration-test.sh`, cold start): **320 passed, 0 failed**. By part: basic 20, M2 30, M3 33, M4 39, M5 31, deployment rehearsal 83, v1a 24, v1b 13, v1c 12, v1d 13, v1e 10, v1f 12. Unit tests: plugin 367, email service 39, collision audit 9.

| Piece | What | Status |
| --- | --- | --- |
| Step 1 | Project files realigned with the spec; decision register and the M5 answers in CLAUDE.md | Done |
| A | Agent isolation (spec gap 1) | Done, live-tested |
| B | Each owner's agent on their own Claude subscription or API key (gap 2) | Done, live-tested with stand-ins |
| C | Handover any time ("Hand over now") and night names renamed to handover | Done, live-tested (full run: 284 passed, 0 failed) |
| D | Claims and the pre-handover check | Done, live-tested (v1d; M2 to M5 with claims in the full run) |
| E | Merge replay at handback | Done, live-tested (v1e) |
| F | Numbers from the event log, CSV export | Done, live-tested (v1f, rehearsal) |
| G | Collision audit (M0) | Done, tested on a made-up team repository and on this repository |

### A. Agent isolation (done)
Each person's agent runs as a system user of its own (`vt-a-...`), which Paperclip reaches over SSH on 127.0.0.1 (Paperclip's own "ssh" environment). That user is not in Paperclip's group. Paperclip puts run tokens on command lines, so nothing started over SSH can see other users' processes (`ProtectProc=invisible`). Checks (tests, lint) run as the owner's own agent user through `deploy/bin/vt-check-runner`, in a fresh folder each time, never as Paperclip's user. The plugin refuses to work for an agent that is not isolated.

**Checked live** (`scripts/it/v1a.sh`, 24 checks; real Paperclip running a hostile stand-in agent over SSH):
- The agent ran as `vt-agent-ana`; its commit came back to the task's branch on the host.
- Refused: Paperclip's master key, signing keys, config and `.env`; its data folders and the repositories; Bo's files; the SSH keys; the company's secrets API with its own run token (403); the link signing key and the checks keys through Paperclip's agent-secret route (403).
- It saw 0 other processes, got no Paperclip secret in its environment, and the signing key's value was in nothing that came back.
- Tests ran as the agent's user; agent-written check code could not read the master key. The checks key can only start the runner.
- The audit flags an agent in someone else's environment, or one on an adapter that always runs as Paperclip's user (`process`).

**Deployment rehearsal** (77 checks, 0 failed): `vt-setup` and `vt-invite` make the user, the keys (deleted from disk once Paperclip has them) and Paperclip's SSH environment. The owner's and Dee's agents log in over SSH as their own users. The agent's user cannot read Paperclip's config, data, database password or backups, and cannot log in to PostgreSQL. `vt-check` checks all of this. The rehearsal found a real bug: sshd reads a user's key file as that user, so the keys now live in `/etc/ssh/vision-and-tom/`.

**Unit tests:** plugin 287, email service 36.

**Not verified:** a real Ubuntu SSH service with `ProtectProc=invisible` (rehearsed with this machine's sshd and a private `/proc`); a real Claude Code run over SSH (the stand-in is a script).

**Known limits:** Paperclip's built-in laptop database has a fixed password, so never run real agents on it. An agent can interfere with its own owner's checks; Hardy's locked sandbox is M4.

### B. Each owner's own Claude access (done)
`sudo vt-model-access <email> subscription "<their SSH public key>"`: the owner's own key may only start Claude Code's own sign-in (`claude auth login`) on their agent's user. The login stays in that user's home. `sudo vt-model-access <email> api-key <secret>`: the owner stores their own key in Paperclip; their agent alone gets it. DEPLOY.md step 12 is rewritten.

**Checked live** (`scripts/it/v1b.sh`, 15 checks, stand-ins only, no real account): Ana signed in through the stand-in sign-in and her agent's run used that login; Bo's run used his own key; Bo's agent could not read Ana's login; Bo's key cannot also go to Ana (never one shared account); a key typed into a subscription agent is flagged; the owner's key can run nothing else. Rehearsal: both tools on the real kit.

**Unit-tested:** a scan of every Aurora source file shows no code reads, copies or logs Claude login files (only `vt-check` tests that Paperclip's own user has none, without opening it).

**Not verified:** a real Claude subscription sign-in and a real API key.

### C. Handover any time (done)
- **Hand over now.** While signed in to Paperclip, open `https://YOUR-DOMAIN/vt/handover` and tap the button. Your agent plans at once; work starts as soon as you approve the plan, and the handback email comes when it is done. The scheduled handover stays as it was. Only one handover per person runs at a time.
- **Names.** "Night" is now "handover" everywhere you see it: settings (`handoverStartHour`, `maxTasksPerHandover`, `handoverBudgetCapCents`, the `handover` box), the agent's tool (`propose_handover`), tickets and emails ("Your handover of ..."). The database tables were renamed by a migration.
- **Safe migration.** Settings saved under the old names keep working; `vt-setup` (run it again on the server) rewrites them to the new names, and the route audit lists any old names left.

**Checked live** (`scripts/it/v1c.sh`, 12 checks, with the scheduled hour 12 hours away): old names accepted and listed, gone after the migration; Hand over now opens the plan at once; a second one is refused; someone not on the team is refused; after approval the task starts right away; finished when its task is done. The older live tests still post the old setting names, so every run also proves they work. Rehearsal: the page refuses without sign-in and from another site, and starts the signed-in owner's handover over HTTPS.

**Found by the live tests:** a scheduled handover first kept the window it was given when its plan opened, so moving your start hour after that had no effect. It now follows your current schedule for that day (a Hand over now keeps its own window). Unit test added.

**Unit tests:** plugin 301, email service 38.

### D. Claims and the pre-handover check (done)
- **Claims.** Every task an agent proposes lists the files and folders it may change (`claims`, for example `src/ui/`, `README.md`, `src/**/*.css`). A task without claims, or with a path that leaves the repository (`..`), is refused.
- **Owner areas** come from the repository's committed `CODEOWNERS` (GitHub's places and rules: `.github/`, the top folder, `docs/`; the last matching line wins). People are matched by email or by the new optional setting `githubLogin`. Vision and Tom reads the file at the project's main branch, never the working folder an agent might have changed. If the repository cannot be read, the proposal is refused (the check never passes on a guess).
- **The check.** A task that reaches into another person's area, or into files another person's open task claimed first, is not run. It becomes a waiting ticket for that person's agent (like a hand-off): the area owner keeps the files first, otherwise the earlier claim. Plans already proposed are never changed. When the repository has the file, a file is known to be a file; otherwise a path counts as a possible folder too, so the check errs towards "overlap".
- **At most three questions.** The plan the owner approves lists the kept tasks with their claims, then at most three questions about what was moved (past three, the rest are folded into the third), then notes such as "no CODEOWNERS file".
- **Recorded for F.** Each overlap is a row in the new `overlaps` table; each kept task's claims are stored with it and end when it is decided or its plan expires.
- **Hand over now keys** now include seconds, so a new Hand over now right after one finishes is not refused (found by the live test).
- Paperclip permissions added: `projects.read`, `project.workspaces.read` (read-only). Plugin version 0.8.0.

**Checked live** (`scripts/it/v1d.sh`, 13 checks, real Paperclip and a real repository): a task without claims is refused; Bo claims `docs/`; Ana proposes one task in her area, one in Bo's area (`@bo-v1d` in CODEOWNERS) and one on Bo's claimed files. Only the first stays; the other two are waiting tickets for Bo's agent, which name the CODEOWNERS line from the committed file (an uncommitted edit giving everything to Bo was ignored). Ana's plan asks exactly two questions and shows the kept task's claims.

**Unit tests:** plugin 340 (claims matching, CODEOWNERS reading, the check, the questions, the runner with a real git repository), email service 38.

**Known gaps:** two proposals at the very same moment can both pass (the merge replay in E is the backstop); CODEOWNERS team entries (`@org/team`) are not matched to people; "fixes the order" (dependencies between work orders) waits for work orders with dependencies.

### E. Merge replay at handback (done)
- When a handback email is built, every ready branch in it is test-merged with `git merge-tree --write-tree` against the owner's other ready branches and against every other owner's ready, undecided branch. This works on git's stored objects only: no branch, working folder or file changes, and nothing is merged.
- Conflicts are listed at the top of the email ("CONFLICTS FOUND BY THE MERGE REPLAY"), with the files both change, and counted in the subject. Approve and Reject stay as they were: the owners decide which goes first.
- The other owner hears about it too. If their task was already handed back to them, they get a short email right away ("A teammate's new work conflicts with yours") with fresh links; otherwise their own handback email shows it. Each conflict is announced once (table `conflicts`, one row per pair of branch versions), but is listed in every email while both are undecided.
- Pairs that cannot be replayed (for example, a missing commit) are reported as a note, never called clean.

**Checked live** (`scripts/it/v1e.sh`, 10 checks, after M4 in the same company): Ana's agent claims only `notes.txt`, so the pre-handover check lets it through, but it also writes `CHANGELOG.md`, which Bo's ready branch adds too. Ana's email lists the conflict with Bo's task and the file, and counts it in the subject; Bo gets the notice naming Ana's task; both still have their Approve links; `main` and both worktrees are unchanged.

**Unit tests:** plugin 354 (replay against real git branches, the notice sent once, own-branch conflicts, email text), email service 38.

**Also fixed:** the deployment rehearsal's check "after the reboot: data is still there" ran before the plugin had started; it now waits up to a minute for the plugin to answer.

### F. Numbers from the event log (done)
- **Handover yield**: work orders approved (and merged) out of all work orders handed over (in a plan its owner approved). Approve merges only the exact version whose checks passed, so an approved work order was approved without edits.
- **Minutes to approve**: from the handback email being sent to the owner's last decision on it (the median per handback). This is elapsed time, not the time spent reading: the event log cannot see that.
- **Decisions per owner**: items that needed a decision, per handback email.
- **Overlaps caught before** (the pre-handover check, piece D) and **conflicts found after** (the merge replay, piece E).
- All of it per owner and for the team. The **CSV** has the playbook's measurement-sheet columns that the event log can fill, one line per work order. Agent-written titles that a spreadsheet would run as formulas get a leading apostrophe.
- On the server: `sudo vt-numbers numbers.csv` writes the sheet (readable by root only) and prints the measures. Behind it are two board-only plugin routes, `/numbers` and `/numbers/csv`. Paperclip 2026.1012.0 sends plugin route bodies as JSON and drops their headers (found by the live test), so the CSV travels inside JSON and `vt-numbers` writes the file.

**Checked live** (`scripts/it/v1f.sh`, 12 checks, on the M4 and v1e company: 5 work orders, 1 approved, 1 rejected, 3 undecided, 1 conflict; and v1d's company: 2 overlaps caught). The rehearsal runs `vt-numbers` as the admin.

**Unit tests:** plugin 367, email service 39.

### G. Collision audit (done)
`tools/collision-audit/collision-audit PATH-TO-CLONE OWNER/NAME` runs the playbook's five steps on a team's own clone and writes `summary.md`, the one page for the team. The five scripts have the playbook's names and arguments (`measure_overlap.py`, `replay_pairs_v2.py`, `classify_overlap.py`, `conflict_rates.py`, `weekly_estimate.py`); they were not in the repository, so they were rebuilt from the playbook's method (see `tools/collision-audit/README.md`).
- **Read-only.** Replays write to a temporary object folder that is deleted afterwards; the tests check that the clone's refs, index, files and objects are unchanged.
- **Sends nothing.** There is no network code, and git runs with no global or system config and every remote protocol refused (tested).
- **Method.** Same-day changes by two people to the same code file. Each is replayed as if done in parallel: the later change is moved onto the earlier one's base with `git merge-tree --write-tree`, then the two are merged. The pair counts as a conflict when that file conflicts; pairs that cannot be moved cleanly are left out. A "follow-up" (the later change edits lines the earlier one wrote, by `git blame`) is not independent. The output is the rate with a 95% Wilson interval, would-be conflicts a week, and the same at three days of work per handover and at three times the pace.

**Tested:** 9 tests on a made-up team repository (three people on branches, a clash on one line, a far-away change, a bot, a README change, a follow-up, a change older than the window), on Python 3.11, 3.12 and 3.13; the code also parses as Python 3.9. A smoke run on this repository worked (no overlaps: one main author). **Not tested:** Python 3.9 itself (not installed here), and a real team's repository.

### Recorded as later (not built in thin version 1)
- Approvals as each owner's own GitHub review (spec gap 13). The email Approve stays as it is for the pilot.
- Risk tiers in the inbox (needs you, review suggested, passed under your rules).
- The scope and cost gauge and the 6-hour caution.
- Master agents with sub-agents.
- Slack, WhatsApp and iMessage.
- Generated screens (and MCP Apps).
- The cross-model judge for conflicts in meaning.

## Milestone 5: server kit, invite links, real SMTP, Approve on GitHub (done; M6 not started)

### Your M4 answers, built
1. **24-hour links; anything undecided comes back.** Every morning's email lists the tasks from earlier emails that are still undecided, with fresh links. This also happens on a morning when no night ran.
2. **No second step.** "Email account approval power" is recorded below as a known gap.
3. **Approve publishes to GitHub.** It pushes the task branch, opens a pull request and squash-merges it. When branch protection blocks the merge, the pull request stays open: the confirmation page says "Waiting for review" and the next email lists it under "Waiting for review". The token that can push and merge lives only in the email service. It is never in Paperclip, never an environment variable, and never on a command line.

### Checked live in the cloud session
`scripts/integration-test.sh` runs M1 to M5 plus the deployment rehearsal: **216 checks, all passing from a cold start** (122 for M1 to M4, 31 for M5, 63 in the rehearsal).

**M5 live part** (against the Paperclip test bed; GitHub is a local stand-in running real git and the same pull-request calls):
- **Approve merges on GitHub.** GitHub got the task branch at exactly the approved commit, and `main` got one squashed commit. The pull request shows as merged, the event log says `accepted`, and the ticket is `done`. A second click did nothing.
- **Branch protection.** The page said "Waiting for review" with GitHub's reason and the pull request. `main` was unchanged and the ticket was "in review". After a reviewer merged it on GitHub, the next check (within a minute here; every 10 minutes on the server) recorded `accepted`.
- **Real SMTP.** The morning email went through a mail server that requires a password and STARTTLS (Mailpit with its own certificate). With a wrong password, the invite command said the email could not be sent and printed the link instead. The password never showed.
- **The GitHub token, proven out of reach:**
  - Paperclip refuses a token in the plugin settings (HTTP 400).
  - It appears nowhere in Paperclip's database dump or data folder, and not in the environment of Paperclip or its plugin workers.
  - It is not in the email service's own environment or log.
  - Another system user cannot read the token file or the email service's process details.
  - GitHub saw it on every request, so it really was used.

**Deployment rehearsal** (`scripts/deploy-rehearsal.sh`, 63 checks). It runs the real `deploy/` scripts inside a folder:
- **Install.**
  - Node 24.22.1 and Caddy 2.11.7 were downloaded and matched their pinned checksums.
  - Paperclip 2026.1012.0 and Claude Code 2.1.293 were installed from lockfiles.
  - PostgreSQL 16 is the database.
  - Paperclip runs in authenticated mode on 127.0.0.1 only and shows nothing without signing in.
- **HTTPS through Caddy.** The certificate was verified, plain HTTP redirects to HTTPS, and public sign-up is refused (403). Paperclip and the email service can't be reached from outside directly.
- **vt-setup.** It made the owner's account and made the owner admin. It created the company, the plugin with valid settings, the owner's own agent, the project clone, and the email service behind HTTPS.
- **Invite link over HTTPS.**
  - The invite was emailed through the STARTTLS server.
  - Opening it created nothing.
  - Submitting it created Dee's account (she signs in and sees the company), her agent (engineer, cannot create agents or skills, 30 USD monthly budget, passes the route audit) and her settings row.
  - A **used** link was refused, both when opened and when submitted.
  - An **expired** link (1-minute lifetime, after 65 seconds) was refused and made no account.
  - A forged link was refused.
- **Backup and restore.**
  - The backup file is root-only, with the database, the files and checksums.
  - Then the database was dropped and all of Paperclip's files deleted, and `vt-restore` brought it all back. The owner and Dee sign in, both settings rows are there, Dee's used invite is still refused, and a new invite is signed (so Paperclip's encrypted secrets survived).
  - The old data was moved aside, not deleted.
  - A damaged backup is refused before anything changes.
- **Simulated reboot.** Everything was stopped, then started from the installed unit files. HTTPS and the data came back. The units restart on failure and start at boot, the backup timer catches up after downtime, and `systemd-analyze verify` found no errors.
- `vt-check` (the owner's "is everything OK" command) says "All good."

### Unit tests
- Plugin: 184 tests. New ones cover:
  - the GitHub publish path, including a changed branch, merged, waiting, closed and failed
  - carry-over of undecided tasks into the next morning
  - invite links: one-time, expired, forged, an Approve link used as an invite, and finishing only when the settings bind the new agent
  - no place for a token in the settings
- Email service: 33 tests. They run against the stand-in GitHub on real git repositories:
  - squash merge
  - waiting for review, then a reviewer merges
  - reuse of an open pull request
  - a changed branch, a branch on GitHub with other commits (never overwritten), a wrong token
  - option-like branch names
  - **the token never appears on any git command line** (checked with a wrapper that records every command line)
  - the join page and the order of the join steps, failure halfway, secrets read from files

### Not verified (only possible on a real server or with real accounts)
- **A real server.** This machine has no systemd and runs everything as root. The unit files were used to start the services, but systemd itself, a real reboot and the separate system users were not exercised. In particular, these permissions are designed but untested:
  - Paperclip reading the root-owned plugin folder
  - the email service reading Paperclip's worktrees through group access
- **Real Let's Encrypt certificates** (the rehearsal used Caddy's local certificate authority), a real email provider, and the real GitHub.
- **"Comes back in tomorrow's email" end to end.** The live test can't move the calendar forward a day, so this was proven with unit tests (controlled clock). Live, the pull-request state and the email footer were checked.
- **Agents connected to Claude** (DEPLOY.md step 12).

### Known gaps
- **Email account approval power** (your answer 2). Anyone who can read your email can use its Approve and Reject links. There is no second step.
- **Agents share a system user with Paperclip.** A misbehaving agent could read Paperclip's database and its stored secrets. That includes the link signing key, so in principle it could forge an Approve link.
  - It still can't read the GitHub push token or push or merge by itself.
  - Branch protection with a required review (DEPLOY.md step 4) is the backstop: even a forged Approve only opens a pull request that waits for a human.
  - The proper fix is running agents in Paperclip's "ssh" or "sandbox" environment.
- **Failed joins use up the link.** If a join fails halfway (for example, an account with that email already exists), the link is used up. The page says to ask for a new one.
- **Crash during an approval.** If the email service crashes between pushing to GitHub and reporting back, that task's approval stays "in progress". Its link says so, and the task is not offered again.

### How to test on your laptop
```bash
cd aurora && git pull
(cd plugin && pnpm install && pnpm test)          # 184 passed
(cd email-service && pnpm install && pnpm test)   # 33 passed
```
The live M5 checks and the rehearsal need Linux and root (they are built for the cloud machine): `IT_ONLY=m5 scripts/integration-test.sh`. To put it on a real server, follow **DEPLOY.md**. The steps only you can do are marked 🔑.

### Open questions for you
1. **Isolating the agents.** Should agents run as a separate user or machine (Paperclip's "ssh" environment), so they can't read Paperclip's own data? This closes the forged-approval gap above. It would be its own step, not M6.
2. **Server size.** The minimum (2 vCPU, 4 GB) is an estimate. Should I measure memory during a real night once you have a server?
3. **Who may invite.** Only you, on the server (`vt-invite`). Do teammates need to invite people too?
4. **Invite lifetime.** 48 hours. Shorter or longer?
5. **Signing agents in to Claude.** API key or Claude subscription login? (DEPLOY.md step 12 is not done yet.)

## Milestone 4: morning email with signed links (done)

### Checked against live Paperclip (2026.1012.0), Mailpit and the email service, in the cloud session
`scripts/integration-test.sh` runs M1 to M4 live: 124 checks, all passing from a cold start (with `SLOW=1`). The M4 part plays one night for Ana (3 tasks) and Bo (1 task):
- **The email:**
  - One email per person arrives in Mailpit after their night ends. Nothing is sent during the night, and nothing is merged during the night.
  - Subject "Your night of …: 2 ready, 1 blocked, 0 failed", with Ready, Blocked and Failed sections.
  - Each task shows what changed in one line ("Add greeting: 1 file changed, 1 insertion(+)"), its checks result (and why, when blocked), Approve for Ready tasks and Reject for every task.
- **Opening a link changes nothing.** It shows a page with a button.
- **A double click equals one merge.** Two simultaneous clicks gave exactly one merge commit in `main`, one "Merged" page and one "Already done" page. A third click also did nothing. The event log says `accepted` and the ticket is `done`.
- **A changed branch blocks the merge.** After a commit was added to the branch post-email, Approve answered "the branch changed after the email was sent". Nothing was merged and the task stayed undecided.
- **Forged and expired links are refused.** A link with one character changed got "Link not usable". After the links' 4-minute test lifetime, Bo's untouched Approve link got "Link expired" and merged nothing.
- **Another person's link is refused.** The test holds the real signing key and builds correctly signed links that point Bo's link at Ana's task, or claim Ana's task for Bo. Both were refused, and nothing was merged.
- **Reject asks for a one-line reason and stores it.** Without a reason, the page asks again and the link stays usable. With one, the event log shows `rejected` / "Too risky for one night". A second click changes nothing. Reject also works on a task the night routine had blocked.
- **Budget cap pauses the agent** (your answer 4). Checked live in the M3 part: the agent's status is `paused` after the cap.

### Unit tests only
- Plugin: 164 tests, including signed links (tampering, other secret, garbage), action tiers, Ready/Blocked/Failed rules, email content and escaping, and merges on real git repos (double approve, moved branch, conflict, `main` not checked out).
- Email service: 11 tests, including that opening a link never acts, the reason form, oversized requests, bad tokens never reaching Paperclip, a briefing only marked sent after sending, and Paperclip being down.
- A "Failed" task in the email is unit-tested; making one live needs two real time-outs (about 11 minutes).
- A merge conflict refused by Approve (unit-tested on real git repos).

### Unverified
- A real mail server (SMTP with login and TLS). Only Mailpit was used, as you asked; nothing was really sent.
- Paperclip in authenticated mode, where the email service needs a board API key (`PAPERCLIP_API_KEY`). That's M5.
- Pushing merges to GitHub. Merges go into the repository's local `main`; pushing is in the "never" tier until M5 decides how.

### How to test on your laptop
```bash
cd aurora && git pull
(cd plugin && pnpm install && pnpm test)          # 164 passed
(cd email-service && pnpm install && pnpm test)   # 11 passed
scripts/integration-test.sh                       # about 10 minutes
IT_ONLY=m4 scripts/integration-test.sh            # just the M4 part, about 6 minutes
```
On a Mac, install Mailpit first with `brew install mailpit` (I didn't do that for you, since it installs a global tool). To read the test emails yourself, run `KEEP_RUNNING=1 IT_ONLY=m4 scripts/integration-test.sh` and open http://127.0.0.1:8025 while the M4 part runs (Mailpit stops when the script ends).

### Open questions for you
1. Link lifetime: 24 hours by default. Shorter? A link that expires before you wake up is useless; one that lasts days stays usable for a forwarded email.
2. Anyone holding your email can use its links (that's how one-tap links work). Do you want a second step later, e.g. a short code, or being logged in to Paperclip?
3. Merges land in the repository's local `main` for now. In M5, should Approve push to GitHub, or open and merge a pull request there?

## Phase C: milestone 3 (done; M4 not started)

### Checked against live Paperclip (2026.1012.0, in the cloud session)
`scripts/integration-test.sh` now runs 82 live checks (84 with `SLOW=1`), all passing from a cold start. The milestone 3 part:
- **Evening plan:**
  - In each person's evening window the night job opens exactly one "Evening plan" ticket for their agent, and a second tick doesn't open another.
  - The agent proposes tasks with `propose_tonight`. More than the person's limit is refused.
  - Proposed tasks wait in backlog, each set up for its own worktree. `proposed_at` lands in the event log.
- **One-tap approval:**
  - The plan ticket carries a Paperclip approve/reject request that only humans may answer.
  - The agent's own attempt to approve was refused by Paperclip (`403 This issue-thread interaction is human-only`).
  - The owner's tap moves the night to "approved". A "Not tonight" with a reason marks every task `rejected`, with that reason in the event log.
- **Night routine:**
  - Nothing starts before the night.
  - At night start the first task goes to the agent, and Paperclip creates its own worktree on a `vt/` branch.
  - The second task waits until the first is done. `started_at` and `finished_at` are logged.
- **Budget cap:** after 300 cents of spend was recorded for the agent, the next tick stopped the night, blocked the running task and logged outcome `blocked`.
- **Time-out and retry (`SLOW=1`):** after the 5-minute step limit, the task was released to the agent again as attempt 2.

### Unit tests only (116 tests)
- Every rule of the night decision engine (17 tests). Among them:
  - an unanswered plan expires
  - a cap of 0 means no work
  - spend from before the night doesn't count
  - a second time-out fails the task and moves on
  - the night ending blocks the running task
- The full evening-to-night flow through the SDK test kit, with an in-memory database (11 tests).
- The night clock in different timezones, including nights that start after midnight.

### Unverified
- The second time-out turning into "failed" in live Paperclip (unit-tested only, to keep the live test short).
- A real AI agent proposing tasks by itself. The test bed calls `propose_tonight` through Paperclip's tool API with the agent's real run, exactly as an agent would.
- The night job firing by itself every 5 minutes over a whole night. The test triggers it on demand; Paperclip shows the schedule `*/5 * * * *` as active.

### Known limits (recorded in CLAUDE.md Decisions)
- At the budget cap the plugin blocks the task and starts nothing more, but it can't kill a run that is already in progress. Also set a monthly budget on each agent in Paperclip as a hard backstop.
- Any human board member can approve any plan for now. Per-owner approval arrives with M4's signed email links.

### How to test on your laptop
```bash
cd aurora && git pull
(cd plugin && pnpm install && pnpm test)   # expect 116 passed
scripts/integration-test.sh                # expect: Result: 82 passed, 0 failed
SLOW=1 scripts/integration-test.sh         # optional, +6 minutes: 84 passed
```
To click through it yourself, follow README "How to test milestone 3", part B.

### Open questions for you
1. Should approval be limited to the plan's owner already in M3? Paperclip can only say "humans only", not "this human". M4's email links will be per owner.
2. At the budget cap, do you also want the agent paused? The plugin would need Paperclip's "pause agent" permission, which I left out on purpose.
3. Defaults OK? Plan opens 2 h before night, the night lasts 8 h, 60 min per task, 1 retry.

## Phase B: milestone 2 (done)

### Checked against live Paperclip (2026.1012.0, in the cloud session)
All of this runs in `scripts/integration-test.sh`: 50 live checks, all passing, from a cold start.
- **Routes between agents:**
  - Paperclip itself refuses to let an agent wake or invoke another agent, change its own permissions, or call a tool while pretending to be another agent.
  - The plugin's `route-audit` view flags Paperclip's default agent permissions (agents may create agents and skills).
  - Once the owner turns those off, the audit passes and an agent can no longer create a helper agent.
- **Hand-offs:**
  - `handoff_to_teammate` creates a board ticket assigned to the teammate's agent, tagged as a Vision and Tom hand-off, asking for its own worktree, and in `backlog` so the teammate's agent waits for approval.
  - An agent can also reassign its own ticket.
  - Hand-offs to non-teammates are refused.
- **Worktree per task:** with Paperclip's isolated-workspaces setting on, starting a ticket creates a real git worktree on its own `vt/<ticket>-<title>` branch, separate from the shared checkout.
- **Checks gate:**
  - `run_checks` runs in that worktree and attaches a report document to the ticket.
  - It passes a small clean change, and fails on a leaked key (the report names the file and line but not the key) and on a change over the size limit.
  - Another agent can't run checks on your ticket.
- **Event log:** rows land in the plugin's own database table: `handed_off_to` for hand-offs, `checks_result` for checks.

### Unit tests only (77 tests)
- Every refusal path of the hand-off rules and the checks tool.
- Secret-scan rules for each key type, plus redaction of keys printed by test commands.
- Check commands get no Paperclip tokens or other keys in their environment, and are stopped at the time limit.
- The manifest never asks for agent-to-agent, merge, send, delete or spend permissions.

### Unverified
- The hand-off's worktree is only created when the teammate's agent starts the ticket, which comes after approval in M3. The same mechanism was verified on a board-created ticket.
- The checks gate with a real `pnpm test` / `pnpm lint` in a real project. The test bed uses tiny stand-in commands.
- A real AI agent (Claude, Codex…) calling the tools. The test bed calls them through Paperclip's tool API exactly as an agent run would, using real run ids.

### How to test on your laptop
```bash
cd aurora && git pull
(cd plugin && pnpm install && pnpm test)
scripts/integration-test.sh          # at milestone 2: Result: 50 passed, 0 failed (now 82)
```
To look around afterwards: `KEEP_RUNNING=1 scripts/integration-test.sh`, then open http://127.0.0.1:3199. In the "VT M2 …" company, open ticket 1: the comments and the `vt-checks-…` documents are the check reports.

For real use you need the one-time setup in README "How to test milestone 2", part B: the isolated-workspaces setting, the project policy, locking the agents, and the check commands.

### Open questions for you
1. Per-task worktrees rely on a Paperclip setting marked **experimental**. OK to depend on it? (I assumed yes. The checks tool refuses to run anywhere else, so nothing unsafe happens if it's off.)
2. Hand-off tickets wait in `backlog` until the teammate's owner approves. Is that what you want, or should hand-offs start immediately?

## Phase A: real Paperclip test bed (done)

### Checked against live Paperclip
- Paperclip `2026.1012.0` runs here with npx (local trusted mode, 127.0.0.1 only, telemetry off).
- The plugin installs from `plugin/` with the documented local-path command.
- Valid settings save. Settings that break the schema are refused (HTTP 400). "Two people, one agent" is saved but flagged by "Test", and the plugin then refuses to act.

### Answers to the milestone 1 questions
1. Paperclip refuses settings that break the schema, but doesn't run our own checks on save, only on "Test". So the plugin fails closed.
2. `npx -y paperclipai@2026.1012.0 plugin ...` works. You don't need a global install.

### Why the cloud test bed needed two workarounds
The cloud machine runs as the admin (root) user. Paperclip's built-in database then runs as a separate `postgres` user, which couldn't read npx's download folder or the admin-owned data folder. The script keeps both inside `.paperclip-data/` and hands the database folder to `postgres`. On a laptop (not root) none of this applies.
