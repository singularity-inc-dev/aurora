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

Expected: all unit tests pass, then `Result: 50 passed, 0 failed`. The integration script starts its own private Paperclip on port 3199, so it won't touch your real one.

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

## Cloud environment setup

`scripts/cloud-setup.sh` installs Node 24 (via nvm) and pnpm 10.28.0. Paste it into the cloud environment's setup script setting so every new session starts with both.
