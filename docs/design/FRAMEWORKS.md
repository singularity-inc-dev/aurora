# Frameworks: the cross-cutting rules

**Words.** Technical terms are defined once, in the "Words used below" list of CURRENT-STATE.md.

**What this is.** Ten rules that cut across every part of Aurora. For each: what it is for (intent), where it stands in the code, what is missing (gap), when to do it (priority) and how big it is (size). Code references point at commit `0137939` on `claude/eloquent-hopper-9m2e04`. Finding IDs (S1, B1...) are from CURRENT-STATE.md.

**Priority**: **now** = before 2 November or in the first pilot week; **after pilot** = once the four pilot weeks have shown it matters; **later** = version 2. **Size**: **S** up to 3 days, **M** 1 to 2 weeks, **L** 3 weeks or more, tests included.

## Summary

| # | Framework | State | Biggest gap | Priority | Size |
| --- | --- | --- | --- | --- | --- |
| 1 | Action tiers and least privilege | Strong on agents, weak on people | Routes trust any signed-in member (S1) | Now | S |
| 2 | Idempotency and version checks | Strong | Multi-step writes can leave junk (B1, B2) | Now (B1), after pilot (journal) | S, M |
| 3 | Checks gate | Works, not locked | Agent-triggered, agent-editable, claims unchecked | Now (claims, tick-triggered) | S |
| 4 | "Done when" check | Missing | No field, no check | Now (pilot week 1-2) | M |
| 5 | Teammate overlap check | Built twice (before and after) | Stale claims, teams in CODEOWNERS | During pilot | S |
| 6 | Prompt-injection boundary | Partial | Agent text not marked as untrusted | Now (labels), after pilot | S, M |
| 7 | Evals and replay | Missing | Nothing recorded to replay | Now (record), later (harness) | S, L |
| 8 | Observability | Logs only | No trace across plugin, service, GitHub | After pilot | S, M |
| 9 | Cost and scope gauge | Cap only | No estimate; subscriptions may record no cost | After pilot | M |
| 10 | Time-outs and retries | Strong | Window end discards finished work (B4) | During pilot | S |

## 1. Action tiers and least privilege

- **Intent.** Every actor gets the fewest powers it needs. Every action is **automatic** (the system may do it), **needs-tap** (only the right owner's tap) or **never**.
- **Status.** Every action is listed once (`plugin/src/tiers.ts:10-34`) and shown in each email's footer. The plugin asks for few capabilities (`plugin/src/manifest.ts:16-38`), and a unit test forbids 16 more, including agent-to-agent, outbound HTTP and grant changes (`plugin/src/routes.ts:8`). Agents that can create agents or skills, or hold the CEO role, are refused (`plugin/src/routes.ts:42-50`). Each agent runs as its own system user (`deploy/lib/agents.sh:51`). The GitHub token lives only in the email service (`deploy/systemd/vt-email.service:19`).
- **Gap.** (a) The plugin's routes do not check the caller (S1). (b) Tiers are self-assertions, not a gate: a caller asserts the tier it already chose (`plugin/src/links.ts:121`). (c) Per-person keys carry a read-only flag that nothing enforces at run time (S7, `plugin/src/secrets.ts:22`). (d) The email service holds an admin API key (S5). (e) The inbox has no risk tiers (spec gap 15).
- **Target.** Route allow-list by caller (ARCHITECTURE.md section 6); an owner's tap proved by signed link or verified session; drop the per-key `access` flag or make Paperclip's own secret bindings the only grant (decide, do not leave it decorative); a narrower Paperclip key for the email service if Paperclip's grants allow it (**ASSUMPTION**: not checked).
- **Priority / size.** (a) now, S. (c) now, S (decision plus delete or wire). (e) after pilot, M.

## 2. Idempotency and version checks

- **Intent.** Doing anything twice has the effect of doing it once, and Approve merges only the exact version the owner saw.
- **Status.** Strong and tested. One click per link (`plugin/src/briefstore.ts:158-164`); one decision per task (`plugin/src/briefstore.ts:187-199`); runs move by compare-and-swap (`plugin/src/handoverstore.ts:108-124`); the base branch moves only if unchanged (`plugin/src/merge.ts:77`); GitHub merges only the approved sha (`email-service/src/github.ts:131-135`); invite tries take turns (`plugin/migrations/009_join_attempts.sql`); interrupted approvals are recovered (`plugin/src/links.ts:345-365`).
- **Gap.** Paperclip gives plugins no transactions (`plugin-sdk/dist/types.d.ts:405-414`), so a failure between writes leaves junk: orphaned claims (B1), an email with dead links (B2). Mail is at-least-once: a failure after sending and before `markSent` (`email-service/src/mailer.ts:38-39`) sends it twice (harmless, the links still act once).
- **Target.** The operations journal (ARCHITECTURE.md section 4.4).
- **Priority / size.** B1 fix now, S (write claims last, release on failure). Journal after pilot, M.

## 3. Checks gate

- **Intent.** Nothing is offered for approval unless machine checks passed on exactly the commit the owner approves.
- **Status.** Diff size, built-in secret scan, tests, lint (`plugin/src/checks.ts:107-147`; rules at `plugin/src/secretscan.ts:11`); tests and lint run as the owner's agent user over SSH, in a fresh folder (`plugin/src/checksandbox.ts:54-68`); Ready needs checks passed on the branch head and a clean worktree (`plugin/src/briefing.ts:60-63`).
- **Gap.** The **agent** decides when checks run (`plugin/src/worker.ts:231-286`); if it never calls `run_checks`, the task is just "checks not run". The tests that run are the agent's copy, so it can weaken them. Changed files are not compared with claims (S6). Commands are one global setting, not per task.
- **Target.** The tick runs the gate when a task reaches `checks` (ARCHITECTURE.md section 4.1); claims-vs-diff becomes a fail-closed check; per-task locked commands come from the handover note; later, tests are taken from the base branch, not the agent's branch, and run as Hardy's user (HARDY.md section 4.3).
- **Priority / size.** Tick-triggered and claims-vs-diff: now, S each. Locked test files: after pilot, M.

## 4. "Done when" check

- **Intent.** Each handback item says whether the owner's own "done when" was met.
- **Status.** Not built. The only place for it is the agent's free-text description, "What needs doing and how to know it is done" (`plugin/src/tools.ts:53`), which nothing reads.
- **Target.** `HandoverNote.doneWhen` (ARCHITECTURE.md section 3): **command** criteria (for example `grep -q Hello README.md`, or a named test) are locked at submit time and run by the checks gate as a fail-closed check; **manual** criteria are shown on the handback item as a checklist the owner ticks, clearly labelled "not machine-checked". Later, an advisory grader from a different model family may score manual criteria against the diff; it can never make an item Ready.
- **Priority / size.** Now (pilot weeks 1-2), M including the note form. It is the product's core promise.

## 5. Teammate overlap check

- **Intent.** Catch two owners' work colliding before it starts, and again before anything merges.
- **Status.** Before: claims against CODEOWNERS areas and open claims, overlapping tasks moved to the keeper (`plugin/src/prehandover.ts:44-83`). After: merge replay of ready branches against the owner's own and others' (`plugin/src/replay.ts:58-73`, `plugin/src/briefing.ts:205-226`).
- **Gap.** Undecided tasks hold claims forever (B3). Two proposals at the same instant can both pass (known; replay is the backstop). GitHub teams in CODEOWNERS match nobody (warned only). Replay runs only when a handback is built, not when a teammate's branch changes later.
- **Priority / size.** B3 during pilot, S. Replay on every new ready head, after pilot, S.

## 6. Prompt-injection boundary

- **Intent.** Text written by an agent (titles, descriptions, commit messages, test output) is shown to people as data and never steers a decision. Prompt injection means hiding instructions in such text.
- **Status.** Decisions use structured facts (shas, statuses, check results), never agent prose. Emails escape HTML (`plugin/src/briefing.ts:243`); the CSV defuses spreadsheet formulas (`plugin/src/numbers.ts:165-168`); test output is redacted and fenced (`plugin/src/checks.ts:163`). Agents cannot call the routes (manifest `auth: "board"`).
- **Gap.** Agent-written titles go into the plan's markdown (`plugin/src/handoverrunner.ts:453`, `:473`) and the email unmarked, so a hostile title can carry a convincing link or "approve this, it is safe". There is no type that marks text as untrusted.
- **Target.** An `UntrustedText` wrapper in the data model, rendered with an "agent wrote this" label and links disabled; extensions receive only that wrapper (ARCHITECTURE.md section 5).
- **Priority / size.** Labels now, S. Wrapper type after pilot, M.

## 7. Evals and replay (baseline against candidate)

- **Intent.** Before changing a prompt, a model, a check or a Hardy rule, re-run recorded handovers with the current version (**baseline**) and the new one (**candidate**) and compare yield and decisions.
- **Status.** Nothing for agents. The decision engine is pure and unit-tested (`plugin/src/handover.ts:88`); the collision audit is a replay of human history (`tools/collision-audit/`).
- **Gap.** No record of what each task ran with: base sha, note, agent adapter and model, checks configuration. Spec gap 25.
- **Target.** Record those five fields per task now; later, a harness that re-runs a candidate on the same base in the sandbox and compares check results and owner decisions; for Hardy rules, score past findings against the owners' actual rulings.
- **Priority / size.** Record now, S. Harness later, L.

## 8. Observability (OpenTelemetry)

- **Intent.** See what happened and where it is stuck. OpenTelemetry is an open standard for **traces** (the timeline of one action across programs), **metrics** (counts and timings) and logs.
- **Status.** Plugin logs through Paperclip's logger (`plugin/src/handoverrunner.ts:64`, `:70`); the email service prints lines (`email-service/src/main.ts:10`); numbers via `vt-numbers`. No telemetry library anywhere in the source.
- **Gap.** No shared id ties a handover's plugin steps, the email service and GitHub together; no metric for tick duration or stuck approvals.
- **Target.** A correlation id per handover and per approval, carried in route bodies and every log line (S); OpenTelemetry export from the Aurora service only, since the plugin may not make outbound calls (`http.outbound` is forbidden, `plugin/src/routes.ts:8`) (M).
- **Priority / size.** After pilot, S then M.

## 9. Cost and scope gauge

- **Intent.** Show each task's size and cost before the handover, with the spec's green, amber and red-with-caution levels (aurora-v1-spec.md:115-127).
- **Status.** A per-handover budget cap read from Paperclip's cost records, with the agent paused at the cap (`plugin/src/handoverstore.ts:127-133`, `plugin/src/handoverrunner.ts:322-334`); a diff-size limit (`plugin/src/checks.ts:132`); at most 3 tasks (`plugin/src/config.ts:8`). No estimate.
- **Gap.** No estimate before a handover (spec gap 16); no cost per approved task in the numbers. **ASSUMPTION:** runs on a Claude subscription may record no cost in Paperclip, so the cap may never trigger for subscription owners. Check it in the first real run.
- **Target.** The owner picks a size on the note (up to 2 h, 2 to 6 h, over 6 h); red needs a confirm; cost per approved task added to the numbers; thresholds tuned from the pilot sheet.
- **Priority / size.** Cost per approved task now, S. Gauge after pilot, M.

## 10. Time-outs and retries

- **Intent.** Nothing hangs: every wait has a limit and a defined next state.
- **Status.** Step limit 60 minutes with one retry, then failed (`plugin/src/handover.ts:143-147`, defaults `plugin/src/config.ts:9-15`); check commands killed at their limit (`plugin/src/checks.ts:63-70`) plus 30 s grace over SSH (`plugin/src/checksandbox.ts:12`); links expire after 24 h; invites after 48 h with a 10-minute lease per try (`plugin/src/invites.ts:13`); stuck approvals recovered after 15 minutes, released after a day (`plugin/src/links.ts:286`, `:358`); a flaky Paperclip call is retried (`plugin/src/handoverrunner.ts:33-46`).
- **Gap.** Window end turns finished-late work into rejected-only (B4); a retry may overlap the timed-out run (B5, **ASSUMPTION** about Paperclip's lock); tasks run one at a time, so one slow task delays the others (B6).
- **Priority / size.** B4 during pilot, S. B5: one live check now, S. Parallel tasks later, M.
