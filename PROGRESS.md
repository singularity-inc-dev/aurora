# Progress

Updated after every phase. Newest phase first.

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
scripts/integration-test.sh          # expect: Result: 50 passed, 0 failed
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
