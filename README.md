# aurora
A platform where every person’s AI agent, and the sub-agents it manages, work together with other people’s agents on one shared project. Each agent handles the repetitive, long-running and logical work on its own, assists with the creative work, and keeps going while its owner is offline. Nothing ships until its owner approves.


## Run Paperclip with this plugin on your laptop

Paperclip's web UI can't be opened from the cloud session, so run it locally.
Every command below is copied from the source named in brackets. Nothing here was run against a live Paperclip.

- [ ] Check versions: Node 24.11+, pnpm 9.15+, git (`node -v`, `pnpm -v`, `git --version`) [Paperclip `doc/plugins/LOCAL_PLUGIN_DEVELOPMENT.md`, "Prerequisites"]
- [ ] Start Paperclip: `npx paperclipai@latest onboard --yes`. The UI is at http://localhost:3100 [Paperclip's README, as you gave it to me; I did not re-read that file]
- [ ] Clone this repo and use the working branch: `git clone https://github.com/singularity-inc-dev/aurora.git && cd aurora && git checkout claude/eloquent-hopper-9m2e04`
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
git checkout claude/eloquent-hopper-9m2e04
cd plugin
pnpm install
pnpm test
pnpm build
```

Expected: every test passes (the count grows with each milestone), then a `dist/` folder containing `manifest.js` and `worker.js`.

What the tests prove:

- The settings reject two people sharing one agent, the same email twice, a bad timezone, an hour outside 0-23, and a negative budget.
- Keys must be picked from Paperclip's secret store. Pasting a raw token is rejected, and the error message never repeats the token.
- An agent can only get its own owner's keys. Another person's key with the same name is never returned.
- Keys are read-only unless marked `read-write`.
- The manifest passes Paperclip's own manifest validator and asks only for `secrets.read-ref`.

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
- **The checks gate:** the `run_checks` tool runs tests, lint, a change-size limit and a key scan in the ticket's worktree, and attaches the report to the ticket.

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
4. In the plugin settings, fill in the "Checks gate" box: test command, lint command, and the maximum changed lines per task (default 400).

**C. Updating the plugin**

Paperclip won't upgrade a plugin that asks for new permissions. Uninstall it (your settings are kept) and install it again:

```bash
npx -y paperclipai@2026.1012.0 plugin uninstall vision-and-tom.night-agents
npx -y paperclipai@2026.1012.0 plugin install "$(pwd)/plugin"
```

## How to test milestone 3

Milestone 3 adds the evening plan and the night routine:

- **Evening plan:** a set number of hours before each person's night (default 2), the plugin opens an "Evening plan" ticket for their agent. The agent proposes up to 3 tasks with `propose_tonight`, either new ones or backlog tickets it already has, such as hand-offs.
- **One-tap approval:** the owner approves or rejects the plan with one tap on the plan ticket. Only humans can answer; agents are refused.
- **Night routine:** one per person per night. At their night start it releases the approved tasks one at a time.
  - **Time-outs and retries:** a task that runs past the time limit is retried, by default once, then marked failed.
  - **Budget cap:** spending is counted from the start of the night; at the person's night budget cap the routine stops and the running task is blocked.

**A. Automatic tests**

```bash
cd plugin && pnpm install && pnpm test && cd ..
scripts/integration-test.sh            # expect: Result: 82 passed, 0 failed (about 3 minutes)
SLOW=1 scripts/integration-test.sh     # also waits out a real 5-minute time-out: 84 passed
```

**B. Try it by hand in your own Paperclip**

1. Do the milestone 2 setup first (isolated workspaces, project policy, locked agents).
2. In the plugin settings, open the "Night routine" box and set "Project for night tasks" to your project's id.
3. Set your own night start hour to 1 to 2 hours from now. Within 5 minutes an "Evening plan for you@…" ticket appears, assigned to your agent.
4. When your agent has proposed, the plan ticket shows "Approve tonight's plan" and "Not tonight". Tap one.
5. At your night start, the first task moves to "todo" and your agent starts on it in its own worktree.
6. The plugin's `night-status` view shows each person's night: proposing, awaiting approval, approved, running, finished, budget stopped, rejected or expired.

## How to test milestone 4

Milestone 4 adds the morning email. After each person's night ends, they get one email listing their tasks under **Ready**, **Blocked** and **Failed**. Each task shows:

- what changed, in one line
- its checks result
- an Approve link (Ready tasks only) and a Reject link

The links are signed, expire (default 24 hours) and work once. Approve merges only if the branch is unchanged since the email. Reject asks for a one-line reason, which is saved in the event log. Opening a link only shows a page; nothing happens until you press the button. That matters because email scanners open links automatically.

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

## Cloud environment setup

`scripts/cloud-setup.sh` installs Node 24 (via nvm) and pnpm 10.28.0. Paste it into the cloud environment's setup script setting so every new session starts with both.
