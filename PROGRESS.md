# Progress

Updated after every phase. Newest phase first.

## Milestone 4: morning email with signed links (done; M5 not started)

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
