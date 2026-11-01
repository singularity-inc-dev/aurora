# Evals and tracing (branch `claude/modest-noether-zvi0eg`)

Two jobs: **replay** (compare two prompts on real saved tasks, decided by tests) and **tracing** (turn on Paperclip's
built-in OpenTelemetry export, send it to Jaeger or Langfuse on the same server, prove nothing sensitive is in it).

## Read this first

1. **Built on PR #7, not on `main`.** `main` (041fe60) is the old M5 code. The "checks passed / not tested / failed" vocabulary,
   the handover runner and the numbers code exist only on `claude/handover-alignment` (PR #7, which contains PR #4). This branch is
   that branch plus this work. Until #4 and #7 merge, the pull request into `main` also shows their commits (the same arrangement
   PRs #7 and #8 use). `origin/main` has not moved, so "rebase on the latest main" changes nothing.
2. **Tracing does not show handovers.** In Paperclip 2026.1012.0 the only spans come from its sign-in library (better-auth). Web requests,
   agent runs and plugin calls create none. Details and evidence: `docs/TRACING.md`. My first spike (local trusted mode) showed no spans at all and
   I nearly reported that; the production-like stack showed 96 spans. The doc says what each environment does.
3. **Four advisories in Paperclip's own `better-auth` (1 critical, 1 high, 2 low) exist in the pinned Paperclip, before this work.** Not fixed (out of scope).
4. **Migration number.** This adds `011_replay.sql`. Another session may also claim 011; renumber on merge if so.

## Replay (docs/REPLAY.md)

- **Capture.** The checks gate now records the commit the work forked from (`checks_base`) next to the commit it checked (`checks_head`). New table
  `saved_tasks` (migration 011) holds the inputs (ticket title and text, secrets replaced), both commits, checks result, outcome, times. Rows never change after saving.
  Board-only route `POST /replay/save` (plugin 0.11.0, no new capability). `sudo vt-replay save FILE`.
- **Run.** `vt-replay run` (bundled to `plugin/dist/replay-cli.js`): per task, a private clone at the starting commit with **no remote**, the agent command with a
  **minimal environment**, then the **real checks gate** on committed files. Baseline and candidate alternate who goes first. 10 to 20 tasks (refuses fewer unless `--allow-fewer`,
  never more than 20); refuses to run as root.
- **Compare.** Passed, not tested, failed, nothing committed, agent error, pass rate, median and total time. Verdict by exact sign test on tasks where exactly one prompt passes. No AI judge.
  On 10 to 20 tasks it will say "Cannot tell" unless one prompt wins about 6 tasks the other fails, with none the other way. That is the honest limit of 20 tasks, and the report says so.

## Tracing (docs/TRACING.md)

- `sudo vt-tracing on|off|status`. Off unless `/etc/vision-and-tom/tracing.env` exists. Loopback addresses only (else `--allow-remote`). Headers (e.g. a Langfuse key) come from standard input, never the command line.
  Sends only service name and version (`OTEL_NODE_RESOURCE_DETECTORS=env`), traces only.
- The kit's Paperclip lockfile now includes the five `@opentelemetry/*` packages at the exact versions Paperclip requires. `paperclip.service` reads the optional tracing file.
- **Privacy test.** In the deployment rehearsal (section 16): a stand-in collector records everything; the auditor looks for 14 canary values (tokens, passwords, emails, a stranger's sign-in details, host name, folder) as written, URL-encoded and base64. None found, in the shipped setting and with metrics on. It also fails if Paperclip starts sending a new kind of span or attribute name.

## Tests

- Unit: plugin **481** (401 before; 80 new), email service **53** (51 before; 2 new). Typechecks clean.
- Live: see the PR for the final full run.
- New live checks: `scripts/it/v1g.sh` (replay on real Paperclip data; 17 checks), `scripts/it/otel.sh` (15 checks), rehearsal section 4b and 16 (13 checks; rehearsal 122 passed, 0 failed).

## Not verified

- **A real agent in the replay.** Only a stand-in agent script ran. The Claude Code command in REPLAY.md is an example; flags are unchecked here.
- **Jaeger and Langfuse themselves.** A stand-in collector received the data. Neither product was run.
- **Replay on tasks from a real pilot.** Only the live suite's few tasks exist; none were checked before this change recorded base commits, so older tasks cannot be saved.
- A real server (systemd), as in earlier milestones.

## Decisions made without asking (change them if wrong)

- Base on PR #7, stacked (above).
- Metrics off by default; traces only. Loopback only. Host details off.
- Replay refuses root; the agent gets no environment except what is named; the clone has no remote.
- Progress file is `docs/progress/claude-modest-noether-zvi0eg.md` (the branch name with `/` replaced by `-`).

## Open questions

1. Is tracing worth keeping on for the pilot, given it shows only sign-ins? (Recommendation: leave it off; turn on when Paperclip or our own services emit useful spans.)
2. Do you want our own spans (plugin, email service, GitHub calls, with a correlation id) next? That is what would actually show where a handover is stuck.
3. Fix the `better-auth` advisories now (override to a patched version, then run the rehearsal), or wait for a Paperclip release?
