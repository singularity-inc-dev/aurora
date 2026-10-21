# Vision and Tom: instructions for Claude

The user is a solo, non-technical founder. Explain each step in plain English before doing it. Small steps. Stop after each milestone and show how to test it.

## Project
"Vision and Tom" is a plugin for Paperclip (github.com/paperclipai/paperclip, MIT) plus a small email service.
Each person on a 2-10 person product team gets one personal agent. At night the agent works only with its
owner's keys, hands work to teammates only by creating or assigning tickets on the Paperclip board, and
changes nothing shared until its owner taps Approve in a morning email.

## Git rules
- Work on `claude/...` branches in `singularity-inc-dev/aurora` only. Pull before you push.
- You may push to your own `claude/...` branch in this repo without asking.
- Never push to `main`, to any other branch, to any other repo, or to Paperclip's repo or any third-party repo.
- Ask first before anything else on the list in the hard rules (rule 2).

## Hard rules
1. Never print, log, commit or ask the user to paste secrets. Keys live in Paperclip secrets or a local `.env` listed in `.gitignore`.
2. Ask before any command that installs global tools, deletes files, pushes to a remote (except per Git rules), or touches files outside this folder.
3. Never push to Paperclip's repository or any third-party repository. Feature branch in our own private repo.
4. Do not guess Paperclip APIs. Read the plugin SDK types in `node_modules` and the official docs first. Pin `@paperclipai/plugin-sdk` to an exact version (alpha).
5. Agents never get merge, deploy, send, delete or spend actions. Only the Approve link merges, and only after an idempotency check and a version check.
6. Small steps. Tests for each piece. Stop after each milestone and show how to test it.

## Milestones (one fresh session each)
- M1 Scaffold plugin with the official SDK. Config schema per person: email, agent id, timezone, night start hour, max tasks per night (default 3), night budget cap. One person bound to exactly one agent. Agent reads only its owner's secrets; tokens read-only by default.
- M2 Board-only hand-offs (block every other route between agents); one git worktree and branch per task; checks gate (tests, lint, diff-size limit, secret scan) with the report attached to the ticket.
- M3 Evening proposal of up to 3 tasks per agent with one-tap approval; one night routine per person; per-night budget cap; per-step time-outs and retries.
- M4 Morning briefing email (ready, blocked, failed) with signed, expiring Approve and Reject links; idempotency key per action; version check that the branch head is unchanged since the email; action tiers (automatic, needs tap, never).
- M5 Deployment guide for one always-on VPS (Paperclip authenticated mode, HTTPS, daily backup); invite link that creates the person and their agent.
- M6 Run flags (tool error, failed tests, timeout, budget stop, rejected); numbers page (done, accepted, rejected per person and task kind); CSV export of the event log; OpenTelemetry settings; replay script comparing two prompt versions.

## Event log (one row per task, in the plugin's own database tables)
task id, owner, agent, task kind, proposed at, approved at, started at, finished at,
checks result, outcome (accepted, rejected, blocked, failed), reject reason, handed off to.

## Environment notes
- Cloud sessions: `. ~/.nvm/nvm.sh` before node/pnpm. `scripts/cloud-setup.sh` sets up Node 24 and pnpm.
- Paperclip is not runnable in the cloud session; live tests happen on the founder's laptop.

## Decisions
- 2026-10-21: Plugin lives in `plugin/`. Pinned `@paperclipai/plugin-sdk` and `@paperclipai/shared` to 2026.1012.0 (shared is dev-only, for the manifest validator test).
- 2026-10-21: Built with plain `tsc`, not the SDK's esbuild presets (no UI yet). Hand-scaffolded because `paperclipai plugin init` needs a Paperclip checkout.
- 2026-10-21: Night budget cap is stored as whole US cents (`nightBudgetCapCents`).
- 2026-10-21: Keys are `{name, secret_ref, access}` per person; `access` defaults to read-only. The read-only flag is our guard; the token's real scope is set where it was issued.
- 2026-10-21: M1 capabilities: only `secrets.read-ref`.
