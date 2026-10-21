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
2. Ask before any command that installs global tools, deletes files, pushes to a remote (except per Git rules), or touches files outside this folder. You may delete build output and test data you generated; ask before deleting any file tracked in git.
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
- Live test bed: `scripts/integration-test.sh` runs real Paperclip (pinned) on 127.0.0.1:3199 with data in `.paperclip-data/it` (gitignored). Milestone live checks go in `scripts/it/*.sh`.
- Paperclip API reference: `npx -y paperclipai@2026.1012.0 openapi` (no source clone needed so far).

## Decisions
- 2026-10-21: Plugin lives in `plugin/`. Pinned `@paperclipai/plugin-sdk` and `@paperclipai/shared` to 2026.1012.0 (shared is dev-only, for the manifest validator test).
- 2026-10-21: Hand-scaffolded because `paperclipai plugin init` needs a Paperclip checkout. Build uses the SDK's esbuild presets (esbuild 0.28.2) so dist/manifest.js and dist/worker.js are single files; with plain tsc, Paperclip mixed a new manifest with cached old modules.
- 2026-10-21: Night budget cap is stored as whole US cents (`nightBudgetCapCents`).
- 2026-10-21: Keys are `{name, secret_ref, access}` per person; `access` defaults to read-only. The read-only flag is our guard; the token's real scope is set where it was issued.
- 2026-10-21: M1 capabilities: only `secrets.read-ref`.
- 2026-10-21: Test bed runs `paperclipai@2026.1012.0` via npx (same version as the SDK). As root, embedded Postgres runs as user `postgres`, so the npm cache and db folder live in `.paperclip-data/` owned/readable accordingly. Telemetry off in the test bed.
- 2026-10-21: Answer: Paperclip enforces `instanceConfigSchema` on save (HTTP 400) but does NOT call `onValidateConfig` on save; only "Test" (`POST /api/plugins/:id/config/test`) runs it. So every feature must call `parseSettings` and do nothing when settings are invalid (fail closed).
- 2026-10-21: Answer: `npx -y paperclipai@<version> plugin ...` works with no global install; a bare `paperclipai` command is not on PATH after npx.
- 2026-10-21 M2: Hand-offs = plugin tool `handoff_to_teammate` (create or reassign a board ticket, teammates only). Hand-off tickets start in `backlog` so the teammate's agent waits for its owner's approval (M3).
- 2026-10-21 M2: Live-verified that Paperclip already blocks agent->agent wakeup/invoke, self-granted permissions and tool impersonation. Remaining side doors are agent permissions; the plugin refuses to act unless both agents have `canCreateAgents=false`, `canCreateSkills=false` and are not CEO (`route-audit` data view).
- 2026-10-21 M2: Worktree per task uses Paperclip's own `isolated_workspace` + `git_worktree` (branch `vt/{{issue.identifier}}-{{slug}}`). Needs the experimental instance setting `enableIsolatedWorkspaces`. `run_checks` refuses any workspace that is not a git worktree.
- 2026-10-21 M2: Checks gate commands come from plugin settings (operator only) and run with a minimal env (PATH, HOME, LANG, CI=1). Secret scan is built in (no third-party scanner); reports never include matched text.
- 2026-10-21 M2: Paperclip 2026.1012.0 plugins can create but not update issue documents (no baseRevisionId), so each checks run adds a new `vt-checks-<timestamp>` document.
- 2026-10-21 M2: Upgrades that add capabilities are refused by Paperclip; reinstall instead (uninstall without --force keeps settings). Bump the plugin version whenever the manifest changes.
- 2026-10-21 M3: Max tasks per night is 1-3 (schema max 3), matching "up to 3 tasks".
- 2026-10-21 M3: Night routine = plugin job `night-tick` (every 5 min) + table `night_runs` with primary key (company, owner, night_date): one routine per person per night. Paperclip managed routines can't carry a per-person timezone, so they were not used.
- 2026-10-21 M3: Jobs run without a company context, and Paperclip refuses company calls there; the job only kicks a loop started in setup() (ticker.ts), which Paperclip allows for configured companies.
- 2026-10-21 M3: One-tap approval = Paperclip `request_confirmation` on the plan ticket with resolver policy `human_only` (live-verified: an agent gets 403 "human-only"). Any human board member can approve for now; per-owner approval comes with M4's signed email links.
- 2026-10-21 M3: Tasks start by moving backlog -> todo (Paperclip wakes the assignee). Retry = comment + backlog -> todo. Budget cap reads `public.cost_events` since the person's night start; at the cap the running task is blocked and nothing else starts. The plugin cannot kill an in-flight run, so also set a Paperclip agent budget as a hard backstop.
- 2026-10-21 M3: Night settings (`night` box): projectId, proposalLeadHours 2, nightLengthHours 8, stepTimeoutMinutes 60, maxRetries 1.
- 2026-10-21: Paperclip's dev file watcher loses a reinstalled plugin; the integration script disables/enables the plugin after each build.
- 2026-10-21 (owner answers to Phase C questions):
  1. Keep Paperclip's experimental worktrees, pinned at 2026.1012.0. If a worktree is missing, the checks gate fails safely and never runs a task in a shared folder.
  2. Hand-off tickets keep waiting for the teammate's owner to approve.
  3. "Any human can approve any plan" is accepted until M4's per-owner signed links.
  4. Add the `agents.pause` permission: pause an agent when it hits the night budget cap (resume stays manual).
  5. Defaults stay: plan opens 2 h before night, 8 h night, 60 min per task, 1 retry.
- 2026-10-21 M4: Architecture: plugin decides everything (signs/verifies links, idempotency, version check, merge); `email-service/` only sends mail (SMTP via nodemailer 10.0.16) and serves link pages. It reaches the plugin through 4 board-only plugin API routes, because Paperclip 2026.1012.0 does not enable public ("webhook") plugin routes.
- 2026-10-21 M4: Links: HMAC-SHA256 signed claims {action, company, owner, task, kind, expiry}; signing key is a Paperclip secret (`links.signingSecret`); default expiry 24 h. Tokens are never stored; the `link_actions` row id is the idempotency key and must match the claims exactly (owner binding). Opening a link (GET) changes nothing; the button (POST) acts.
- 2026-10-21 M4: Approve merges into the local base branch only if the branch head equals the head in the email, via a temporary worktree then a fast-forward/compare-and-swap of the base. Pushing to a remote is in the "never" tier until M5 decides.
- 2026-10-21 M4: Ready = finished, worktree clean, checks passed on exactly the branch head. Only Ready tasks get Approve; every task gets Reject (reject may close blocked/failed tasks). Rejected tickets are set to cancelled.
- 2026-10-21 M4: Paperclip limits secret reads to 30/min per company and the SDK forbids caching secrets, so the plugin reads the signing key only when there is mail to sign or a link to check.
- 2026-10-21 M4: Board PATCH to `blocked` needs a reason/blocker in Paperclip; the plugin's own block action works. Test mail goes to Mailpit v1.27.0 (pinned by SHA-256) in `.vendor/`.
