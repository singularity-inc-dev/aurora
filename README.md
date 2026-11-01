# aurora
A team handover for software teams of 2 to 10 people, built as a plugin on the open-source Paperclip platform. Each person has their own agent. The owner chooses the tickets and writes a handover note on each (what to do, done when, and limits: files, time, budget), then taps Hand over, now or for their daily scheduled time. That tap is the approval: the agent works on exactly those tickets and cannot add, swap or rewrite them. The work comes back in a handback email, and nothing merges until the owner, signed in, taps Approve. Agent suggestions ("Help me plan") are off by default and still need the owner's tap. Not yet run end to end with a real Claude agent.

**Putting it on a real server for the first time:** follow [FIRST-REAL-RUN.md](FIRST-REAL-RUN.md) (it uses [DEPLOY.md](DEPLOY.md) for the server). Emergency stop on the server: `sudo vt-stop`.


## Run Paperclip with this plugin on your laptop

Paperclip's web UI can't be opened from the cloud session, so run it locally.
Every command below is copied from the source named in brackets. Nothing here was run against a live Paperclip.

- [ ] Check versions: Node 24.11+, pnpm 9.15+, git (`node -v`, `pnpm -v`, `git --version`) [Paperclip `doc/plugins/LOCAL_PLUGIN_DEVELOPMENT.md`, "Prerequisites"]
- [ ] Start Paperclip: `npx paperclipai@latest onboard --yes`. The UI is at http://localhost:3100 [Paperclip's README, as you gave it to me; I did not re-read that file]
- [ ] Clone this repo and use the working branch: `git clone https://github.com/singularity-inc-dev/aurora.git && cd aurora && git checkout main`
- [ ] Build the plugin from its folder: `pnpm install`, then `pnpm dev` (watch build, leave it running) or `pnpm build` (one build) [`LOCAL_PLUGIN_DEVELOPMENT.md`, step 3, and "Troubleshooting"]
- [ ] In a second terminal, install it from its absolute path: `npx -y paperclipai@2026.1012.0 plugin install /absolute/path/to/plugin` (add `--local` to be explicit) [`LOCAL_PLUGIN_DEVELOPMENT.md`, step 4]
- [ ] Confirm it loaded: `npx -y paperclipai@2026.1012.0 plugin list`, then `... plugin inspect <plugin-key>` [`LOCAL_PLUGIN_DEVELOPMENT.md`, step 5]
- [ ] If it fails, run `paperclipai plugin target` to see which Paperclip the CLI is talking to (default `http://localhost:3100`; override with `--api-base` or `PAPERCLIP_API_URL`) [`LOCAL_PLUGIN_DEVELOPMENT.md`, "How the CLI chooses its target"]

Open points:

- The plugin lives in the `plugin/` folder. Run the build and install commands from there.
- Answered (tested live): write the commands as `npx -y paperclipai@2026.1012.0 plugin ...`. A bare `paperclipai` command is only available if you install it globally, which you don't need to.
- The docs say local-path installs are development workflows and run trusted code from disk. For a deployed plugin they say to publish an npm package and install that [`@paperclipai/plugin-sdk` README, "Current deployment caveats"].
- When we write the plugin, pin `@paperclipai/plugin-sdk` to an exact version. `2026.1012.0` is the current `latest` on npm and installs cleanly with Node 24.

Sources, all from Paperclip's repo (github.com/paperclipai/paperclip): `doc/plugins/LOCAL_PLUGIN_DEVELOPMENT.md`, `doc/plugins/PLUGIN_AUTHORING_GUIDE.md`, and the README shipped inside `@paperclipai/plugin-sdk@2026.1012.0`.

## How to test milestone 1

Milestone 1 adds the plugin skeleton and its settings: one row per person (email, agent id, timezone, night start hour, max tasks per night, night budget cap, and the keys their agent may use).

**A. Automatic tests (about 2 minutes)**

```bash
git clone https://github.com/singularity-inc-dev/aurora.git
cd aurora
git checkout main
cd plugin
pnpm install
pnpm test
pnpm build
```

Expected: every test passes (the count grows with each milestone), then a `dist/` folder containing `manifest.js` and `worker.js`.

What the tests prove:

- The settings reject two people sharing one agent, the same email twice, a bad timezone, an hour outside 0-23, and a negative budget.
- Keys must be picked from Paperclip's secret store. Pasting a raw token is rejected, and the error message never repeats the token.
- An agent may not be given another person's key: the route audit (and `vt-check`) refuses any agent, of any kind, whose settings point at a key listed under someone else.
- Each key has a `read-only` / `read-write` label, but nothing enforces it: the token's own scope, set where it was issued, is the only limit. Give agents tokens that are read-only at the source.
- The manifest passes Paperclip's own manifest validator. (At milestone 1 it asked only for `secrets.read-ref`; later milestones added the permissions listed in `plugin/src/manifest.ts`.)

**B. In Paperclip (about 10 minutes)**

1. Start Paperclip: `npx paperclipai@latest onboard --yes`, then open http://localhost:3100.
2. In a second terminal, from the `plugin/` folder: `npx -y paperclipai@2026.1012.0 plugin install "$(pwd)"`, then `npx -y paperclipai@2026.1012.0 plugin list`. You should see `vision-and-tom.night-agents` with status ready.
3. In Paperclip, create a test secret (any dummy value, not a real key).
4. Open the plugin's settings page (Paperclip docs: `/settings/plugins/<plugin id>`). Add yourself as one person, set the agent id to an existing agent, and pick the test secret under "Keys".
5. Add a second person with the same agent id. Use "Test Connection" if Paperclip shows it: it should report `agentId: already bound to another person`.

Answered (tested live): Paperclip blocks saving settings that break the basic rules (an hour of 24, or a pasted key instead of a secret pick). It still saves "two people, one agent", which only "Test Connection" catches. The plugin then refuses to act until the settings are fixed.

## How to test milestone 2

Milestone 2 adds three things:

- **Board-only hand-offs:** an agent passes work to a teammate only through the `handoff_to_teammate` tool, which creates or reassigns a board ticket.
- **One worktree and branch per task:** Paperclip gives each ticket its own copy of the code on a `vt/...` branch.
- **The checks gate:** the `run_checks` tool runs tests, lint, a change-size limit and a key scan on the ticket's latest commit, and attaches the report to the ticket. Only committed files are checked (a fresh copy of the commit, never the working folder), because a commit is what the owner approves. With no test command set up, the result is **NOT TESTED**, never "passed"; the handback email says so next to Approve.

**A. Automatic tests**

```bash
cd plugin && pnpm install && pnpm test && cd ..
scripts/integration-test.sh
```

Expected: all unit tests pass, then `Result: … passed, 0 failed` (50 checks at milestone 2, more as milestones are added). The integration script starts its own private Paperclip on port 3199, so it won't touch your real one.

**B. One-time setup in your own Paperclip (needed for real use)**

1. Turn on per-task worktrees. This is an experimental Paperclip setting: Instance settings → Experimental → "Isolated workspaces". Through the API: `PATCH /api/instance/settings/experimental {"enableIsolatedWorkspaces": true}`.
2. In your project, set the execution workspace policy to isolated workspaces using git worktrees, with the project workspace pointing at your repo.
3. For each person's agent, turn off "can create agents" and "can create skills". Then open the plugin's `route-audit` view: it should say `ok: true`. Until it does, the plugin refuses hand-offs and checks for that agent.
4. In the plugin settings, fill in the "Checks gate" box: test command, lint command, and the maximum changed lines per task (default 400). Without a test command every task is reported as NOT TESTED.

**C. Updating the plugin**

Paperclip won't upgrade a plugin that asks for new permissions. Uninstall it (your settings are kept) and install it again:

```bash
npx -y paperclipai@2026.1012.0 plugin uninstall vision-and-tom.night-agents
npx -y paperclipai@2026.1012.0 plugin install "$(pwd)/plugin"
```

## How to test milestone 3

Milestone 3 was "the agent proposes a plan, a person approves it". That step is gone: **the owner chooses the work, and the owner's tap is the approval.** This is exactly how a handover works today:

1. **The owner writes tickets.** In Paperclip, write a ticket, assign it to your own agent, leave it in **Backlog**.
2. **The owner opens their Hand over page** (`/vt/handover` on the server; only for the person signed in to Paperclip in that browser). It lists the tickets in their agent's backlog.
3. **A note on each ticket.** Tick up to your "Max tasks per handover" (1 to 3) and write, for each:
   - **What to do** (pre-filled from the ticket text);
   - **Done when**: how you will know it is finished. Aurora shows it back to you on the handback; **it does not check it for you, you do**;
   - **Files and folders it may change.** A committed change to any other file fails the checks gate;
   - **Time limit** in minutes (default: the step time-out times its retries, at most the handover length) and **budget** in US cents (default and maximum: your cap per handover).
4. **One tap.** **Hand over now** starts at once; **Hand over at my scheduled time** waits for your daily handover hour. Either way the tap is the approval: there is no plan ticket and nothing for anyone else to approve. The note is stored in one place (the plugin's `handover_notes` table) and locked; the agent gets it as a comment on the ticket. Editing the ticket afterwards changes nothing, and the handback says the ticket was edited.
5. **Checked before anything changes.** Every ticket must be on your own agent and in Backlog. The pre-handover check refuses the whole hand-over if a ticket's files reach into a teammate's CODEOWNERS area or files a teammate's open task holds; nothing is moved to anyone, and the page lists what overlapped.
6. **Work.** Exactly your tickets, in your order, one at a time, each in its own worktree.
   - **Each task's limits:** past its time limit it fails; past its budget it is blocked; the next task starts.
   - **Time-outs and retries:** a stuck step is retried (by default once) within the task's time.
   - **Budget cap per handover:** at your cap the handover stops, the running task is blocked and the agent is paused.
7. **Taking it back.** Tickets waiting for the scheduled time can be taken back on the same page before they start.
8. **The agent cannot change the work.** It cannot hand one of your handed-over tickets to someone else, and it cannot suggest tasks unless you turned on **Help me plan**.
9. **Help me plan (off by default).** An admin turns it on per person (`helpMePlan` in the plugin settings). Then the page has **Ask my agent for suggestions**. The agent's suggestions appear on your page as drafts; nothing runs until you check them and hand them over like your own.
10. **Only the owner.** Only the person signed in as that owner can hand over their tickets. The plugin's routes accept calls only from the Aurora service's own Paperclip user (`serviceUserId`, set by `vt-setup` and `vt-update`); a teammate calling them directly is refused.
11. **Handback.** Each finished task comes back in the owner's handback email with your note, Approve (Ready tasks only) and Reject. The buttons work only for the owner, signed in to Paperclip in that browser.

**A. Automatic tests**

```bash
cd plugin && pnpm install && pnpm test && cd ..
IT_ONLY=m3 scripts/integration-test.sh  # expect: Result: 61 passed, 0 failed (about 4 minutes)
SLOW=1 IT_ONLY=m3 scripts/integration-test.sh  # also waits out a real 5-minute time-out: 63 passed
```

**B. Try it by hand in your own Paperclip**

1. Do the milestone 2 setup first (isolated workspaces, project policy, locked agents).
2. In the plugin settings, open the "Handovers" box and set the project id.
3. Write two tickets in Paperclip, assign them to your agent, leave them in Backlog.
4. Open your Hand over page, tick one, write its note, and press **Hand over at my scheduled time**. Set your handover start hour to the current hour: within 5 minutes that ticket (and only that one) moves to "todo" and your agent starts on it in its own worktree. The other ticket stays in Backlog.
5. The plugin's `handover-status` view shows each handover: approved (waiting for its time), running, finished, budget stopped or expired.

## How to test milestone 4

Milestone 4 adds the morning email. After each person's night ends, they get one email listing their tasks under **Ready**, **Blocked** and **Failed**. Each task shows:

- what changed, in one line
- its checks result
- an Approve link (Ready tasks only) and a Reject link

The links are signed, expire (default 24 hours) and work once. Approve merges only if the branch is unchanged since the email. Reject asks for a one-line reason, which is saved in the event log. Opening a link only shows a page; nothing happens until you press the button. That matters because email scanners open links automatically. The button appears, and works, only for the task's owner signed in to Paperclip in that browser; anyone else who has the email is refused.

Two parts work together:

- **The plugin** decides everything: it checks the signature, the expiry, the owner and the one-click rule, compares the branch with the email, and merges.
- **`email-service/`** sends the email and serves the link pages.

**A. Automatic tests**

```bash
(cd plugin && pnpm install && pnpm test)
(cd email-service && pnpm install && pnpm test)
scripts/integration-test.sh     # about 10 minutes; the M4 part waits 4 minutes for links to expire
```

The integration test starts Mailpit, a fake mail server that catches the emails so nothing is really sent, plus the email service. It plays one night for two people, then proves:

- a double click merges exactly once
- a branch changed after the email is not merged
- forged links, expired links, and correctly signed links naming another person are all refused
- Reject saves its reason

`IT_ONLY=m4 scripts/integration-test.sh` runs just the M4 part. On Linux the script downloads a pinned Mailpit itself; on a Mac, install it once with `brew install mailpit` (a global tool, so that's your call).

**B. Setting it up for real (local)**

1. In Paperclip, create a secret named `vt-link-signing` holding a long random value. Don't paste it anywhere else.
2. In the plugin settings, open the "Morning email links" box and set:
   - Email service address: where the email service is reachable, e.g. `http://127.0.0.1:3299`
   - Link signing key: the secret from step 1
   - Expiry: in minutes, default 1440
3. In `email-service/`, copy `.env.example` to `.env` and fill in `VT_COMPANY_ID` and your SMTP server. Then run `pnpm install && pnpm start`.
4. The morning after a night, your email arrives. To try it safely first, run `mailpit` and keep `SMTP_PORT=1025`, then open http://127.0.0.1:8025 to read the emails.

## How to test milestone 5

Milestone 5 is the server kit (see **[DEPLOY.md](DEPLOY.md)**, the checklist for putting it on a real server), invite links, real SMTP, and Approve publishing to GitHub.

**A. Automatic tests**

```bash
(cd plugin && pnpm install && pnpm test)          # 184 passed
(cd email-service && pnpm install && pnpm test)   # 33 passed
IT_ONLY=m5 scripts/integration-test.sh            # M5 live checks + deployment rehearsal, about 15 minutes
scripts/deploy-rehearsal.sh                       # only the rehearsal (Linux, as root), about 8 minutes
```

The M5 live part plays one night with Approve in GitHub mode. GitHub is a local stand-in: real git, the same pull-request calls, nothing leaves the machine. It shows:

- a pull request squash-merged, and one that waits for review under branch protection until a reviewer merges it
- the morning email sent through a mail server that needs a password and STARTTLS
- the GitHub token appearing nowhere in Paperclip, and unreadable for another system user

The rehearsal runs the real `deploy/` scripts inside a folder instead of the real system. It shows:

- HTTPS through Caddy
- an invite link creating a new person; used, expired and forged invite links refused
- a backup, a simulated disaster and the restore
- a simulated reboot

The rehearsal needs Linux and root (it starts a private PostgreSQL 16 as the `postgres` user); it is meant for the cloud machine.

**B. On a real server:** follow [DEPLOY.md](DEPLOY.md).

## How to test thin version 1 (pieces A to G)

What each piece is, and what was checked, is in [PROGRESS.md](PROGRESS.md). On your laptop (Mac or Linux) you need Node 24 and pnpm (`scripts/cloud-setup.sh` shows the versions), git 2.38+, Python 3.9+ and, for the email checks, Mailpit (on a Mac: `brew install mailpit`).

**1. Unit tests (about a minute)**

```bash
(cd plugin && pnpm install && pnpm test)            # 367 passed
(cd email-service && pnpm install && pnpm test)     # 39 passed
python3 -I tools/collision-audit/tests/test_audit.py   # 9 tests, OK
```

**2. The collision audit on a real repository (G)**

```bash
git clone https://github.com/OWNER/NAME.git /tmp/team-repo
tools/collision-audit/collision-audit /tmp/team-repo OWNER/NAME
```

Open the `summary.md` it names at the end. It reads the history only and sends nothing anywhere. A busy repository with several people gives the most interesting result.

**3. Live checks against a real Paperclip on your laptop (C, D, E, F)**

```bash
IT_ONLY=v1e scripts/integration-test.sh   # Hand over now, claims, the merge replay; about 10 minutes
IT_ONLY=v1f scripts/integration-test.sh   # the numbers and the CSV; about 10 minutes
```

Each first runs the M4 checks it builds on (one handover for Ana and Bo, the handback emails, Approve and Reject), then:

- **v1e:** Ana hands over now. Her agent claims only `notes.txt` but also changes `CHANGELOG.md`, which Bo's finished, undecided work changed too. Both get an email naming the conflict, and nothing is merged.
- **v1f:** the numbers for that team: 5 work orders, 1 approved, 1 conflict, yield 20%, and the CSV file.

Every check prints PASS or FAIL, with a total at the end.

**4. Only on Linux as root (the cloud test machine)**

`scripts/integration-test.sh` with no `IT_ONLY` runs everything. That includes v1a and v1b (agents as their own system users over SSH, and each owner's own Claude access, with stand-ins for real accounts), v1c, v1d (the pre-handover check with a real CODEOWNERS file) and the deployment rehearsal. These create system users and start an SSH server, so they are not for your laptop; their results are in PROGRESS.md.

## Cloud environment setup

`scripts/cloud-setup.sh` installs Node 24 (via nvm) and pnpm 10.28.0. Paste it into the cloud environment's setup script setting so every new session starts with both.
