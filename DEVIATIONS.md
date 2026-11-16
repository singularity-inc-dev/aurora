# Deviations from INTENT.md

**What was audited:** the code at commit `0137939` on branch `claude/eloquent-hopper-9m2e04` (all `file:line` references, including `PROGRESS.md`, are to that commit).
Every `file:line` below points to that commit. `main` is 24 commits behind it, so the same
lines on `main` will not match. No code was changed for this audit.

**State of the code on 31 October 2026:** plugin unit tests 388 of 388 pass, email service
51 of 51 pass, the TypeScript typecheck is clean. **No real Claude agent has ever run a whole
handover**: every live test drives the tools by hand or with a scripted stand-in
(`PROGRESS.md:96-97`).

**Severity** (worst first): **A** = makes a claim false, **B** = breaks or weakens the demo,
**C** = security or data risk, **D** = code quality, **E** = cosmetic or naming.
I did not see the application texts themselves. "A" means the code contradicts
`INTENT.md`, or a sentence written in this repository for the applications or the README.
**Fix size:** S = under an hour, M = half a day to a day, L = more than a day.

## Findings

| Area | Intent says | Code does (file:line) | Sev | Fix | Recommendation |
| --- | --- | --- | --- | --- | --- |
| **A1. Who decides the work** | The owner decides the work. Agent-proposed tasks are optional and **off by default**. | The opposite. Every handover, scheduled or "Hand over now", opens a plan ticket that tells the **agent** to propose up to 3 tasks (`plugin/src/handoverrunner.ts:223-239`). The agent may invent new tasks (`plugin/src/proposal.ts:101-106`, `plugin/src/tools.ts:36-69`). Tickets the owner wrote are only listed as suggestions the agent may ignore (`plugin/src/handoverrunner.ts:224-227`). No setting turns agent proposals off. The plan ticket is created in `todo` (`:236`), so every scheduled handover wakes the agent and spends model credit before anyone taps anything. | A | M | Short term: say "the owner writes the ticket; the agent turns it into a plan the owner approves". That is true today and is what `FIRST-REAL-RUN.md:59-61` does. Then build the real thing: the owner's backlog tickets become the plan directly, and agent proposals sit behind a setting that is off by default. |
| **A2. The handover note** | One note per task: what to do, **"done when"**, **limits**. | No note exists. A task is a free-text title and description (`plugin/src/proposal.ts:101-106`). There is no "done when" field. Limits exist only per person or for the whole team, never per task: tasks per handover and budget (`plugin/src/config.ts:52-61`), diff size (`:66`), time per task (`:106`). The spec's "outcome card" with done-when (`aurora-v1-spec.md:95`) was never built. | A | M | Short term: a fixed description template ("What / Done when / Limits") that the plan and the handback both show. Later: real fields, with per-task limits enforced. |
| **A3. Check against "done when"** | Each handback item is checked against that owner's "done when". | Not checked at all. "Ready" means the ticket was marked done, the worktree is clean and the checks passed on that commit (`plugin/src/briefing.ts:53-65`). Nothing reads or tests "done when". | A | L | Do not claim automatic verification. Short term: print the owner's "Done when" line on every handback item, so the owner checks it before tapping Approve. Later: an owner-written check command per task, run in the checks gate. |
| **A4. Schedule** | Hand over now, or on a schedule: meeting, lunch, night. | "Hand over now" works. The schedule is **one** fixed hour per person per day (`plugin/src/config.ts:56`, `plugin/src/schedule.ts:186-208`), and a scheduled handover runs once per day (`plugin/src/handoverrunner.ts:117-119`). There are no meeting or lunch slots. | A | M | Say "a daily schedule, or any time with Hand over now". Several named slots per day can wait. |
| **A5. Who approves the plan** | A proposed task never runs without **that owner's** approval. | Any signed-in human can approve anyone's plan. Paperclip's `human_only` stops agents, not teammates. `readApproval` never looks at who answered (`plugin/src/handoverrunner.ts:179-186`), and any "accepted" starts the work (`plugin/src/handover.ts:118`). The SDK does report who answered (`resolvedByUserId` in `@paperclipai/shared` `types/issue.d.ts:899`). The plugin stores no Paperclip user id per person, so it cannot compare. | A | M | Store each person's Paperclip user id (the join and `vt-setup` know it). Refuse any approval whose `resolvedByUserId` is not the owner's. Until then, in the demo only the owner may be signed in. |
| **A6. Teammate check** | Against teammates' branches: **which files both changed**, and whether they would conflict. | It reports **only textual conflicts**: the files `git merge-tree` marks as conflicting (`plugin/src/replay.ts:121-140`, `plugin/src/briefing.ts:205-212`). If two owners changed the same file and git merges it cleanly, the handback says nothing. | A | S | In `replayPairs`, also list the files changed on both sides (`git diff --name-only` from the merge base, for each branch). Show them as "also changed by NAME" even when the merge is clean. |
| **A7. Hand-off by reassigning** | Work passes only through board tickets, and never runs without the receiving owner's approval. | `handoff_to_teammate` with an `issueId` changes only the assignee and leaves the status alone (`plugin/src/worker.ts:200-204`). The live test hands over a `todo` ticket and never checks its status afterwards (`scripts/it/m2.sh:78`, `:135-137`). The plugin itself starts work by giving an agent a `todo` ticket (`plugin/src/handoverrunner.ts:321`). So agent A can very likely put work in front of B's agent with no approval from B, outside B's handover and B's budget. Live waking was not tested. | A | S | In the same update, set `status: "backlog"`, as the "create" path already does. Add a check to the unit test and to `m2.sh` that the status is `backlog`. |
| **A8. Sub-agents in the README** | Out of scope here; the claim must still be true. | `README.md:2` says each agent manages its own "sub-agents". The code refuses any agent that is allowed to create agents (`plugin/src/routes.ts:48`). | A | S | Remove "and the sub-agents it manages" from the README and from any application text. |
| **A9. The 33% conflict figure** | Numbers must be reproducible. | The wording approved for the applications says a replay of 20 teams "found a 33% textual conflict rate" (`PROGRESS.md:46`). Eight lines later the same file says the figure **cannot be reproduced**: no team list, and the scripts did not exist on the date given (`PROGRESS.md:54`). The spec still calls it "own measurement" (`aurora-v1-spec.md:31`) and says it was "re-run on 23 October 2026 with the collision-audit scripts" (`aurora-v1-spec.md:468`). That is false. Our own corrected run found 1 conflict in 104 clean replays (`PROGRESS.md:72`). | A | S | Before the a16z deadline (1 November): remove 33% from all application text, or call it "an earlier, unreproduced estimate". Use only the numbers measured in this repo. Correct spec lines 31 and 468. |
| **B1. Never run with a real agent** | The demo shows a real handover. | No real Claude agent has run propose, work, checks and handback end to end (`PROGRESS.md:96-97`). Live tests call the tools by hand (`scripts/it/m2.sh:91`, `scripts/it/m5.sh:148`) or use `scripts/it/lib/fake-claude`. The plan ticket never tells the agent to run `run_checks` (`plugin/src/handoverrunner.ts:232-235`). Only the owner's own ticket text does (`FIRST-REAL-RUN.md:61`). | B | S (code) + 1 h real run | Add one line to the plan ticket and to each task description: "When finished, call run_checks on this ticket, commit everything, then mark it done". Then do `FIRST-REAL-RUN.md` section 5 with real Claude before any demo. |
| **B2. Checks run only if the agent asks** | Every handback item is checked by tests, lint, diff size and secret scan. | The plugin never runs the checks by itself. They run only when the agent calls `run_checks` (`plugin/src/worker.ts:231-286`). If it forgets, the item is "blocked: checks not run" (`plugin/src/briefing.ts:62`). | B | M | When a task reaches `done` or `in_review`, run the checks gate from the handover tick (`advance` in `plugin/src/handoverrunner.ts:303-311`). |
| **B3. Missing tests count as passed** | Checked by tests and lint. | If no test or lint command is set, that check is "skipped" (`plugin/src/checks.ts:88`), and skipped counts as passed (`:146`). An item can be "Ready" with no tests and no lint ever run. | B | S | Treat a missing test command as a failure (or as "not checked", which is never Ready) when isolation is required. Show "tests: not configured" in the handback. |
| **B4. Too many taps, in two places** | Owner hands over, then decides on the handback. | Hand over now (handover page), then approve the plan **inside Paperclip** (`email-service/src/pages.ts:260`, `email-service/src/server.ts:98`), then approve each result by email. That is three steps in three places. | B | M | For the demo, rehearse the exact clicks. Later: approve the plan from the handover page, or skip plan approval when the owner wrote the tasks (see A1). |
| **B5. Tasks moved before anyone approves** | Out of scope: Hardy rulings. Work moves only through tickets. | When the agent proposes, the pre-handover check **immediately** gives a task to another owner's agent if it touches their CODEOWNERS area or claims. Owner-written tickets are reassigned too (`plugin/src/handoverrunner.ts:415-449`, reassign at `:422-425`). The owner is asked "Is that right?" only afterwards (`plugin/src/prehandover.ts:103-112`). Answering "Not this time" does not move it back. This is a Hardy-style ruling, and a task can vanish from the presenter's plan mid-demo. | B | M | Make the move advisory: keep the task, show the overlap as a question, and move it only if the owner agrees. For the demo, use a repository whose CODEOWNERS does not overlap the demo task. |
| **C1. Links act for whoever holds them** | Nothing merges without **the owner's** tap. | Approve and Reject links are bearer tokens. Anyone who has the email (forwarded, shared inbox, a scanner that submits forms) can act. Nothing checks who is signed in (`plugin/src/links.ts:65-89`, `email-service/src/server.ts:131-145`). This is a known gap. The sign-in check already exists for `/handover` (`email-service/src/server.ts:91-92`). | C | M | On the POST, require the Paperclip session's email to equal the link's owner. Reuse `whoIs`. |
| **C2. Checks may test files the commit does not have** | Approve only what was checked. | `run_checks` records `HEAD` (`plugin/src/checks.ts:117`) but tests the working folder, including uncommitted and untracked files (`plugin/src/git.ts:214-232`, `plugin/src/checksandbox.ts:277-286`). "Clean" is checked only later, at handback (`plugin/src/briefing.ts:61-63`). An agent can pass the checks with an untracked helper file, delete it, and the commit shows Ready without ever being tested as committed. | C | S | Refuse `run_checks` unless `git status --porcelain` is empty (`isClean` already exists, `plugin/src/merge.ts:99`). |
| **C3. "Read-only" keys are not enforced** | The agent uses only that owner's keys. | Each key has an `access` flag, read-only by default (`plugin/src/config.ts:32`). The only code that respects it (`plugin/src/secrets.ts:22-45`) is called by nothing except its own test. Agents get keys through Paperclip's adapter settings, which the plugin never filters. An owner who adds a write-capable GitHub token thinking it is "read-only" gives the agent push rights. | C | S | Either delete the flag and say plainly "the token's own scope is the only limit" (already noted in CLAUDE.md), or enforce it in the audit. Delete `secrets.ts`. |
| **C4. Key check only for Claude** | Only that owner's keys. | The check that no agent setting points at **another person's** key (`plugin/src/modelaccess.ts:36-39`) is skipped for every adapter except `claude_local` (`:20`). Codex, Cursor and others are allowed by the isolation list, but get no check. | C | S | Move the "another person's key" loop above the `claude_local` early return. |
| **C5. One GitHub account for the whole team** | The approval is the owner's. | One `GITHUB_TOKEN` in the email service pushes and merges for every owner (`email-service/src/config.ts:101`). On GitHub every pull request and merge comes from one account. "Approved by X" is only text in the PR body (`plugin/src/links.ts:187`). | C | L | Accept for the pilot and say so. Each owner's own review on GitHub is spec gap 13 (decision 11). |
| **D1. Dead code** | - | `plugin/src/secrets.ts` is unused outside tests. Of the 20 entries in the tier table (`plugin/src/tiers.ts:10`), only 6 are checked anywhere. The rest are documentation, yet the handback email prints all of them as rules (`plugin/src/briefing.ts:325`). | D | S | Delete `secrets.ts`. Either assert every tier or stop printing the list in the email. |
| **D2. Settings-rename code with no users** | - | The "night" to "handover" migration (`plugin/src/config.ts:323-370`, plus `vt-setup` and route-audit support) exists for servers that were never deployed (`PROGRESS.md:96`). | D | S | Delete it before the first real server, together with the old names still used in `scripts/it/m2.sh`, `m3.sh`, `m4.sh`, `m5.sh` and `v1a.sh` (`v1c.sh` tests the migration itself and goes with it). |
| **D3. Stores tested only through fakes** | - | `claimstore`, `conflictstore`, `handoverstore`, `numberstore`, `invites` and `proposal` have no test file of their own. Their SQL runs against a fake database in unit tests (`plugin/tests/fakedb.ts`) and against Postgres only in the live scripts. | D | M | Add direct tests for the claim and conflict SQL, which decide moves and conflicts. |
| **D4. Fragile platform** | - | The product depends on Paperclip alpha `2026.1012.0` and on an **experimental** worktree setting (`deploy/bin/vt-setup.mjs:93`). It also needs several workarounds: the ticker loop (`plugin/src/ticker.ts`), retrying the company list (`plugin/src/handoverrunner.ts:33-46`), a new document on every checks run (`plugin/src/worker.ts:25-31`), and CSV wrapped in JSON. Any Paperclip upgrade can break it. | D | L | Keep the pin. Before any upgrade, run the full live suite. Raise the workarounds upstream (decision 13). |
| **D5. Types copied between services** | - | `email-service/src/paperclip.ts:12,34` redefines `LinkCheck` and `LinkOutcome` from `plugin/src/links.ts`. They can drift apart without any test failing. | D | M | Share one types file, or add a contract test. |
| **D6. Replay rescans everything** | - | Every handback re-reads every undecided, passed task in the company, calling git and Paperclip for each one (`plugin/src/briefing.ts:102-115`). Old undecided tasks never drop out. | D | S | Limit it to tasks from the last N days or the current handovers. |
| **D7. Approve does not re-test on a moved base** | - | The replay runs once, when the email is built. If a teammate's work merges before you tap Approve, your squash-merge can still produce code that was never tested together. | D | M | Later: re-run the replay, or the checks, on the new base before merging. |
| **D8. Stale README** | - | `README.md:10` says "Nothing here was run against a live Paperclip". `README.md:13` and `:57` use `paperclipai@latest`, which breaks the pin. The milestone-1 section still uses night-only names. | D | S | Rewrite the README around FIRST-REAL-RUN.md and the pinned version. |
| **E1. Product name in visible text** | The product is Aurora. Vision and Tom are only example agent names. | The plugin is shown as "Vision and Tom" (`plugin/src/manifest.ts:10,13`). The email sender is "Vision and Tom" (`email-service/src/config.ts:95`). So are the invite email (`email-service/src/invite.ts:30-36`), the conflict email (`plugin/src/briefing.ts:265`), the PR body (`plugin/src/links.ts:187`), merge commits and their git identity (`plugin/src/links.ts:203`, `plugin/src/merge.ts:20`) and hand-off notes (`plugin/src/handoff.ts:69`, `plugin/src/worker.ts:208`). | E | S | Change the visible text to "Aurora". Keep the plugin id `vision-and-tom.night-agents` (`plugin/src/ids.ts:2`): Paperclip ties the install and its settings to it. Bump the plugin version. |
| **E2. "Morning email"** | Handback. | The setting title "Morning email links" (`plugin/src/config.ts:210`), and ticket comments and PR text saying "from the morning email" (`plugin/src/links.ts:151,187,215,264`). | E | S | Replace with "handback email". |
| **E3. Hardy mentioned in code** | Hardy is out of scope. | Comments name Hardy (`plugin/src/prehandover.ts:4`, `deploy/bin/vt-check-runner:7`). | E | S | Remove the mentions, or say "pre-handover check". |
| **E4. Branch prefix** | Aurora. | Task branches are `vt/...` (`plugin/src/workspace.ts:2`). | E | S | Optional: `aurora/...`. Only new tasks are affected. |

**What matches the intent (verified in code):** one worktree and branch per task
(`plugin/src/workspace.ts`); each agent runs as its own system user and uses its owner's own Claude
access (`plugin/src/isolation.ts`, `plugin/src/modelaccess.ts`); the handback groups items as ready,
blocked and failed (`plugin/src/briefing.ts:244-249`); Approve works exactly once
(`plugin/src/links.ts:133-142`) and refuses a changed branch: the plugin checks it (`plugin/src/links.ts:163-170`,
`plugin/src/merge.ts:55-58`), then GitHub's `sha` check does; Reject requires a one-line reason of up to 200 characters
(`plugin/src/links.ts:102-131`, `email-service/src/pages.ts:189`); agents get no merge, deploy, send,
delete or spend capability (`plugin/src/routes.ts:8-25`); hand-offs go only through board tickets
(`plugin/src/handoff.ts`), apart from A7.

## Changes to Paperclip's own code

**None.** Paperclip's source is not patched or forked. What touches Paperclip:

| What | Where | Minimal? | Documented? | Could it be a plugin instead? |
| --- | --- | --- | --- | --- |
| Four inner dependencies replaced in their vulnerable versions only (zod, body-parser, multer, uuid) | `deploy/paperclip/package.json:9-14` | Yes: limited to the vulnerable versions, Paperclip itself stays pinned | Yes: `PROGRESS.md` step 1, CLAUDE.md decision of 25 October | No. These are dependency pins. Send the version bumps upstream and drop the overrides once Paperclip ships them. |
| Experimental instance setting `enableIsolatedWorkspaces` turned on | `deploy/bin/vt-setup.mjs:93` | Yes, one setting through Paperclip's own API | Yes, CLAUDE.md M2 decision | Already outside Paperclip's code. The risk is that it is experimental (D4). |
| Paperclip config: authenticated, public, Postgres, telemetry off | `deploy/templates/paperclip-config.mjs` | Yes | Yes, `DEPLOY.md` | It is configuration, not code. |
| Public sign-up blocked at Caddy, while Paperclip keeps `disableSignUp: false` so the email service can sign invited people up | `deploy/templates/Caddyfile:18`, `deploy/templates/paperclip-config.mjs:26` | Yes | Yes, CLAUDE.md M5 decision | No: plugins cannot change sign-up. It relies on Caddy being the only way in (Paperclip listens on 127.0.0.1 only). |

Upstream changes that would delete our workarounds (decision 13): public plugin routes (the
email service would no longer need board-only routes), updating issue documents, CSV and
headers from plugin routes, and company-scoped calls from jobs (no ticker loop).

## Top 10 to fix before 2 November (about 4 hours in total)

The last column says whether the fix touches files that the first-real-run session
(`claude/codebase-review-ad3lrs`, [singularity-inc-dev/aurora#4](https://github.com/singularity-inc-dev/aurora/pull/4)) is likely to change.
On 31 October that branch had changed only `DEPLOY.md`, `PROGRESS.md` and `README.md`.
Its rule is "no new features before the run", so it will mostly edit the run documents and `deploy/`,
plus whatever plugin or email-service code the real run breaks. The plugin code most exposed is the code a real agent
exercises first: the plan text, `run_checks`, the model-access check and the handback email.
**High** = will almost certainly collide. **Medium** = likely to collide if the run hits a problem there.
**Low** = unlikely to collide.

| # | Fix | Finding | Time | Files | Collides with first real run? |
| --- | --- | --- | --- | --- | --- |
| 1 | Remove or relabel the 33% figure in all application text; correct `aurora-v1-spec.md:31` and `:468` | A9 | 10 min | `PROGRESS.md`, `aurora-v1-spec.md`, application texts | **High** for `PROGRESS.md`: the run session adds to it at every fix. Make one small edit to the "Numbers for applications" section only, after #4 merges. Low for the spec. |
| 2 | Make the claims match the code (see "Claims allowed on 2 November" below); remove "sub-agents" from the README and the GitHub repository description | A1, A3, A4, A8 | 20 min | `README.md`, `PROGRESS.md`, GitHub settings, application texts | **High** for `README.md` and `PROGRESS.md` (both already edited on that branch). Application texts and GitHub settings: none. |
| 3 | Hand-off by reassigning also sets `backlog`, with tests | A7 | 20 min | `plugin/src/worker.ts`, `plugin/tests/plugin.test.ts`, `scripts/it/m2.sh` | **Medium**: `worker.ts` holds every tool. The hand-off code is not used in the first run, so the lines themselves are unlikely to clash. |
| 4 | The teammate check also lists files both changed, even when git merges them cleanly | A6 | 45 min | `plugin/src/replay.ts`, `plugin/src/briefing.ts`, `plugin/src/briefstore.ts`, `plugin/tests/replay*.test.ts` | **Medium** for `briefing.ts`: the handback email is step 5 of the run. Low for `replay.ts` (one person, no teammate branches in the first run). |
| 5 | `run_checks` refuses a worktree with uncommitted or untracked files | C2 | 20 min | `plugin/src/worker.ts`, `plugin/src/checks.ts`, tests | **Medium**, and it **changes the run's behaviour**: a real agent that leaves a stray file would now be refused. Do it after the first run, or tell the run session first. |
| 6 | A missing test command is never "Ready"; the handback says "tests not configured" | B3 | 20 min | `plugin/src/checks.ts`, `plugin/src/briefing.ts`, tests | **Medium** (`briefing.ts`). The run sets `sh test.sh`, so behaviour is unchanged for it. |
| 7 | Plan and task tickets tell the agent to commit, call `run_checks`, then mark done | B1 | 15 min | `plugin/src/handoverrunner.ts` (plan text), `FIRST-REAL-RUN.md:61` | **High**: if the real agent stumbles, this plan text is the first thing the run session will edit. Hand this item to the run session, or wait until it is done. |
| 8 | "What / Done when / Limits" template, with the "Done when" line printed on each handback item | A2, A3 | 45 min | `plugin/src/briefing.ts`, `plugin/src/briefstore.ts`, `plugin/src/handoverrunner.ts`, `FIRST-REAL-RUN.md` | **High** (`handoverrunner.ts`, `FIRST-REAL-RUN.md`) and Medium (`briefing.ts`). Do it after the first run. |
| 9 | Rename the visible "Vision and Tom" and "morning email" text to Aurora and "handback" (plugin id unchanged, version bumped) | E1, E2 | 30 min | `plugin/src/manifest.ts` (version), `links.ts`, `briefing.ts`, `merge.ts`, `handoff.ts`, `worker.ts`, `config.ts`, `email-service/src/config.ts`, `invite.ts`, tests | **High**: any plugin fix in the run also bumps the version in `manifest.ts`. `FIRST-REAL-RUN.md` and `DEPLOY.md` tell the owner to open "the Vision and Tom plugin", so renaming mid-run confuses the person following them. Do it after the run, in one commit that also updates those documents. |
| 10 | The "another person's key" check runs for every adapter | C4 | 10 min | `plugin/src/modelaccess.ts`, `plugin/tests/modelaccess.test.ts` | **Medium**: step 4 of the run (the real Claude sign-in) runs exactly this check. If `vt-check` complains, the run session will edit this file. |

**For the alignment session:** start from `main` only after #4 is merged, or from `claude/codebase-review-ad3lrs`. Today's `main`
is 24 commits behind and lacks most of this code. Safe to do in parallel now: 3, 4 (without the email layout), 6 and 10,
in separate commits. Leave 1 and 2 as one small text-only commit after #4 merges. Hold 5, 7, 8 and 9 until the
first real run is finished.

That is about 3 h 55 min of code and text. **Not counted, and not optional:** one real run with real
Claude on the server (`FIRST-REAL-RUN.md` section 5), about 1 hour. Without it, the demo is the
first time a real agent goes through the loop.

## Claims allowed on 2 November

These hold for the code at `0137939` (the same plugin code is in [#4](https://github.com/singularity-inc-dev/aurora/pull/4)).
"Live-tested" means against real Paperclip, git, SMTP and PostgreSQL, with stand-ins for GitHub and Claude.
**No real Claude agent has run a whole handover yet** (B1), so no allowed sentence says it was tested with real agents.

### You may say

| # | Sentence | Why it is true | Limit (finding) |
| --- | --- | --- | --- |
| Y1 | "Aurora is a handover for software teams of up to 10 people, built as a plugin on the open-source Paperclip platform." | `plugin/src/config.ts:4` | |
| Y2 | "Each person has their own agent. On the server it runs as its own system user, so it cannot read Paperclip's data, a teammate's files or the signing keys." | Piece A, live-tested with a hostile stand-in agent (`PROGRESS.md`, "A. Agent isolation") | |
| Y3 | "Each agent uses its owner's own Claude access, their own subscription or their own API key, never a shared account." | `plugin/src/modelaccess.ts`, live-tested with stand-ins | Checked for Claude agents only (C4) |
| Y4 | "Every task runs on its own branch, in its own git worktree." | `plugin/src/workspace.ts` | |
| Y5 | "The owner writes a ticket for their agent and hands over, now or on a daily schedule. The agent turns it into a plan, and nothing runs until a person approves that plan. Agents cannot approve." | `FIRST-REAL-RUN.md:59-61`, `human_only` approval (`plugin/src/handoverrunner.ts:459-478`) | Not "only the owner" (A5); the agent may propose other tasks (A1); one schedule a day (A4) |
| Y6 | "When the work is done, the owner gets a handback email: what is ready, blocked or failed." | `plugin/src/briefing.ts:244-249` | |
| Y7 | "An item is Ready only when the agent finished it, everything is committed, and the checks gate passed on that commit: tests, lint, a diff-size limit and a secret scan." | `plugin/src/briefing.ts:53-65`, `plugin/src/checks.ts:107-147` | True only when a test command is set (B3), and the gate can test files the commit doesn't have (C2). Safe without qualification after top 10 #5 and #6. |
| Y8 | "Before the handback, Aurora test-merges each ready branch with teammates' ready branches and warns about files that would conflict. Nothing is merged." | `plugin/src/replay.ts`, `plugin/src/briefing.ts:205-212`, live-tested (v1e) | Conflicts only, not every shared file (A6) |
| Y9 | "Approve merges exactly once, and only if the branch is unchanged since the email. Reject asks for a one-line reason." | `plugin/src/links.ts:102-175`, `plugin/src/merge.ts:55-58` | |
| Y10 | "With GitHub connected, Approve opens a pull request and squash-merges it, respecting branch protection; if a review is required, it waits for the review." | `email-service/src/github.ts`, live-tested against a GitHub stand-in | Not yet run against real GitHub (`PROGRESS.md:96-97`) |
| Y11 | "Agents have no merge, deploy, delete or payment actions. Work passes between agents only as board tickets." | `plugin/src/routes.ts:8-25`, `plugin/src/handoff.ts` | A hand-off of an existing ticket can skip the receiver's approval (A7) |
| Y12 | "Each handover has a budget cap; at the cap the agent is paused." | `plugin/src/handover.ts:139-141`, `plugin/src/handoverrunner.ts:322-334` | |
| Y13 | "We built a read-only collision audit. In a corrected run on 7 public repositories (56 days, September to October 2026, 8 to 47 regular contributors each), same-day edits to the same file happened 0.4 to 36 times a week. 1 of 104 clean replays of those overlaps conflicted in git. This measures people, not agents; the pilot will measure agents." | `PROGRESS.md:58-72` (corrected table, measured rows only) | Use these numbers only (A9). The replay is capped at 60 overlaps per repository. |

### You must not say

| # | Sentence (or anything that means it) | Why not |
| --- | --- | --- |
| N1 | "The 20-team replay found a 33% conflict rate", "our own measurement found 33%", "teams of 7 to 10 hit 1.5 to 4 conflicts a week" | Not reproducible: the 20 repositories were never recorded (A9; see "Reproducing the 33% figure" below) |
| N2 | "2 to 6 same-day overlaps a week" and "0% conflicts across 88 replays" (the wording at `PROGRESS.md:46`) | Superseded. Three of those clones were truncated (`PROGRESS.md:25`); the corrected run gives Y13. |
| N3 | "Agents never propose work", "agent proposals are off by default", "Aurora runs exactly the tasks the owner wrote" | The agent proposes every plan, and may add or swap tasks (A1) |
| N4 | "Owners write a handover note with done-when and limits for each task" | No such fields; limits are per person, not per task (A2) |
| N5 | "Each result is checked against the owner's done-when" | Nothing checks it (A3) |
| N6 | "Hand over at a meeting, at lunch or overnight on a schedule" | One scheduled time a day, plus Hand over now (A4) |
| N7 | "Only the owner can approve their agent's work plan" / "nothing runs without the owner's own approval" | Any signed-in person can approve a plan (A5); a hand-off can skip the receiver's approval (A7) |
| N8 | "Aurora shows every file two teammates both changed" | Only files that conflict (A6) |
| N9 | "Each agent manages its own sub-agents" | Agents that can create agents are refused (A8) |
| N10 | "Tested with real Claude agents" or "teams use it today" | Not until FIRST-REAL-RUN.md section 5 is done (B1) |
| N11 | "Only the owner can use their Approve link" | Anyone with the email can (C1) |
| N12 | "Approvals land on GitHub as the owner's own review" | One shared GitHub account (C5, spec decision 11 not built) |
| N13 | "Agents get read-only keys by default" | The flag is not enforced (C3) |
| N14 | "Hardy referees conflicts", "contracts", "standing rules", "risk-sorted inbox", "generated screens", "Slack or phone alerts", "works inside Claude or ChatGPT (MCP Apps)" | None of these exist in the code; Hardy is out of scope (INTENT.md) |
| N15 | "Aurora reduces conflicts by X%" | Never measured (`PROGRESS.md:48`) |

## Reproducing the 33% figure (finding A9): not reproducible

Checked on 31 October 2026, on all five branches (`main`, `claude/eloquent-hopper-9m2e04`,
`claude/keen-goldberg-484y4g`, `claude/codebase-review-ad3lrs`, `claude/intent-audit`) and their full history.
**No run was started**: the input does not exist, so any run would be a new measurement, not a reproduction.

- **The 20 repositories are not named anywhere.** The only description is "20 open-source product teams,
  22 October 2025 to 22 October 2026" (`aurora-v1-spec.md:468`). No list, data file or commit message names them.
  `tools/collision-audit/step5-candidates.md` is a different, later screening (about 45 repositories, 56 days).
- **The scripts did not exist on the date given.** The spec says the figure was "re-run on 23 October 2026 with the
  collision-audit scripts". The scripts first appear in commit `63c5d6d` on 25 October 2026, rebuilt from the
  playbook's method because "the five scripts were not in the repo" (CLAUDE.md, piece G). The spec was committed in
  `9a5b9b8` on 24 October. The "earlier analysis" the playbook refers to (`pilot-playbook.md:93`) is not in the repository.
- **To reproduce it you would need** the list of 20 repositories (or the output files) from whoever ran the
  original analysis. With that list: `python3 -I tools/collision-audit/collision-audit-batch --fetch ...` over the year
  window. A one-year window on 20 repositories is likely to take more than 2 hours. Ask before starting.

## What must wait (and what to say until then)

- **A1 Owner-written plan with agent proposals off by default** (M, half a day to a day): this is the
  headline mismatch. Until it is built, do not say "agents never propose" or "off by default".
- **A3 Automatic "done when" verification** (L): say the owner judges it.
- **A4 Several schedule slots per day** (M).
- **A5 Only the owner can approve their plan** (M, needs a stored Paperclip user id). Demo with only the owner signed in.
- **B2 Plugin runs the checks itself** (M). **B4 Fewer taps** (M). **B5 Advisory pre-handover moves** (M); demo on a repository without overlapping CODEOWNERS.
- **C1 Sign-in required on Approve and Reject** (M). **C3 Decide on the read-only flag** (S, but it needs your decision). **C5 Per-owner GitHub identity** (L, spec gap 13).
- **D2 to D8 and E3, E4**: after the applications.
