# aurora
A platform where every person’s AI agent, and the sub-agents it manages, work together with other people’s agents on one shared project. Each agent handles the repetitive, long-running and logical work on its own, assists with the creative work, and keeps going while its owner is offline. Nothing ships until its owner approves.


## Run Paperclip with this plugin on your laptop

Paperclip's web UI can't be opened from the cloud session, so run it locally.
Every command below is copied from the source named in brackets. Nothing here was run against a live Paperclip.

- [ ] Check versions: Node 24.11+, pnpm 9.15+, git (`node -v`, `pnpm -v`, `git --version`) [Paperclip `doc/plugins/LOCAL_PLUGIN_DEVELOPMENT.md`, "Prerequisites"]
- [ ] Start Paperclip: `npx paperclipai@latest onboard --yes`. The UI is at http://localhost:3100 [Paperclip's README, as you gave it to me; I did not re-read that file]
- [ ] Clone this repo and use the working branch: `git clone https://github.com/singularity-inc-dev/aurora.git && cd aurora && git checkout claude/eloquent-hopper-9m2e04`
- [ ] Build the plugin from its folder: `pnpm install`, then `pnpm dev` (watch build, leave it running) or `pnpm build` (one build) [`LOCAL_PLUGIN_DEVELOPMENT.md`, step 3, and "Troubleshooting"]
- [ ] In a second terminal, install it from its absolute path: `paperclipai plugin install /absolute/path/to/plugin` (add `--local` to be explicit) [`LOCAL_PLUGIN_DEVELOPMENT.md`, step 4]
- [ ] Confirm it loaded: `paperclipai plugin list`, then `paperclipai plugin inspect <plugin-key>` [`LOCAL_PLUGIN_DEVELOPMENT.md`, step 5]
- [ ] If it fails, run `paperclipai plugin target` to see which Paperclip the CLI is talking to (default `http://localhost:3100`; override with `--api-base` or `PAPERCLIP_API_URL`) [`LOCAL_PLUGIN_DEVELOPMENT.md`, "How the CLI chooses its target"]

Open points:

- The plugin lives in the `plugin/` folder. Run the build and install commands from there.
- The docs write `paperclipai plugin ...` and the `paperclipai` command may not be on your PATH after `npx`. I did not find a documented `npx paperclipai@latest plugin install` form, so check `paperclipai --help` before relying on it.
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

Expected: `Tests  25 passed (25)`, then a `dist/` folder containing `manifest.js` and `worker.js`.

What the tests prove:

- The settings reject two people sharing one agent, the same email twice, a bad timezone, an hour outside 0-23, and a negative budget.
- Keys must be picked from Paperclip's secret store. Pasting a raw token is rejected, and the error message never repeats the token.
- An agent can only get its own owner's keys. Another person's key with the same name is never returned.
- Keys are read-only unless marked `read-write`.
- The manifest passes Paperclip's own manifest validator and asks only for `secrets.read-ref`.

**B. In Paperclip (about 10 minutes)**

1. Start Paperclip: `npx paperclipai@latest onboard --yes`, then open http://localhost:3100.
2. In a second terminal, from the `plugin/` folder: `paperclipai plugin install "$(pwd)"`, then `paperclipai plugin list`. You should see `vision-and-tom.night-agents` with status ready.
3. In Paperclip, create a test secret (any dummy value, not a real key).
4. Open the plugin's settings page (Paperclip docs: `/settings/plugins/<plugin id>`). Add yourself as one person, set the agent id to an existing agent, and pick the test secret under "Keys".
5. Add a second person with the same agent id. Use "Test Connection" if Paperclip shows it: it should report `agentId: already bound to another person`.

Not verified yet: whether Paperclip blocks saving invalid settings, or only shows the error under "Test Connection". Please tell me which you see.

## Cloud environment setup

`scripts/cloud-setup.sh` installs Node 24 (via nvm) and pnpm 10.28.0. Paste it into the cloud environment's setup script setting so every new session starts with both.
