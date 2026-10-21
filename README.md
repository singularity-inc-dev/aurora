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

- This repo has no plugin source yet (no `package.json`, no manifest). The build and install steps only apply once a plugin folder exists here.
- The docs write `paperclipai plugin ...` and the `paperclipai` command may not be on your PATH after `npx`. I did not find a documented `npx paperclipai@latest plugin install` form, so check `paperclipai --help` before relying on it.
- The docs say local-path installs are development workflows and run trusted code from disk. For a deployed plugin they say to publish an npm package and install that [`@paperclipai/plugin-sdk` README, "Current deployment caveats"].
- When we write the plugin, pin `@paperclipai/plugin-sdk` to an exact version. `2026.1012.0` is the current `latest` on npm and installs cleanly with Node 24.

Sources, all from Paperclip's repo (github.com/paperclipai/paperclip): `doc/plugins/LOCAL_PLUGIN_DEVELOPMENT.md`, `doc/plugins/PLUGIN_AUTHORING_GUIDE.md`, and the README shipped inside `@paperclipai/plugin-sdk@2026.1012.0`.

## Cloud environment setup

`scripts/cloud-setup.sh` installs Node 24 (via nvm) and pnpm 10.28.0. Paste it into the cloud environment's setup script setting so every new session starts with both.
