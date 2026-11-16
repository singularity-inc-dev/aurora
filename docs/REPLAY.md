# Replay: compare two prompts on real tasks

**What it answers.** "If I change the agent's instructions (the prompt), do more of its tasks pass the tests?"
It takes real tasks your team already handed over, runs each one twice (once with the current prompt, the
**baseline**, once with the new one, the **candidate**) and compares what the checks gate says.

**Tests decide. There is no AI judge.** A run counts as *passed* only when the real checks gate passes it:
tests, lint, diff-size limit and secret scan, on the committed files. *NOT TESTED* (no test command set up)
never counts as passed. Time is shown next to the result and is not part of the verdict.

## 1. Save real tasks (once a week, or before a prompt change)

```bash
sudo vt-replay save /root/tasks.json --limit 20
```

For every task that the checks gate has checked and that has an outcome (accepted, rejected, blocked or failed), this keeps:

| Kept | Where it comes from |
| --- | --- |
| The inputs: ticket title and text | the board ticket, at the moment you save (secrets in it are replaced by `[redacted:...]`) |
| The repository commit the work started from, and the commit it ended on | the event log (`checks_base`, `checks_head`) |
| What became of it: checks result, outcome, reject reason, start and finish time | the event log |

- Saved tasks never change afterwards, even if the ticket is edited later. Run the command again to add newer ones.
- Tasks nobody has decided yet are left out (they have no outcome to compare with). `--include-undecided` adds them.
- **Tasks checked before plugin 0.11.0 cannot be saved**: the starting commit was not recorded then. Only tasks checked from now on count.
- Owners appear as short tags (`o-3f9a1c2b`), never as email addresses.
- The file holds your tickets' text. It is readable by root only (mode 600). Treat it like the tickets.

You need **10 to 20 saved tasks** for a comparison to mean anything. The tool refuses fewer than 10 unless you pass `--allow-fewer`, and never replays more than 20.

## 2. Run the comparison

Write the two prompts as plain text files. Then, as an **ordinary user, not root** (it runs the agent and the tests):

```bash
vt-replay run \
  --tasks tasks.json --repo /path/to/a/clone/of/the/project \
  --baseline prompt-current.md --candidate prompt-new.md \
  --agent-cmd './my-agent.sh' \
  --repeats 3 --out report.md --json runs.json
```

For every task, in order (the two prompts take turns going first):

1. A private copy of the project is made at the task's **starting commit**. The copy has **no remote**, so the agent cannot push anywhere, and your real clone is only read.
2. `--agent-cmd` runs inside that copy. It can read two files named in environment variables:
   - `VT_REPLAY_PROMPT_FILE`: the prompt being tested.
   - `VT_REPLAY_TASK_FILE`: the ticket text (title, then description).
3. After it ends (or after `--agent-timeout` seconds, default 900, when it is stopped), the **real checks gate** runs on what the agent **committed**. Uncommitted files are ignored, as in the product. Add `--commit-leftovers` if you want to judge the work and not the committing habit.
4. The copy is deleted (`--keep` keeps it).

The agent gets a **minimal environment** (`PATH`, `HOME`, `LANG`, `TERM`, `CI`). Anything else must be named: `--pass-env ANTHROPIC_API_KEY`. Names only; values are never printed.

The gate uses the same test and lint commands as production (they are saved in the tasks file). `--checks-config gate.json` overrides them: `{"testCommand": "pnpm test", "lintCommand": "pnpm lint", "maxDiffLines": 400, "timeoutSeconds": 300}`.

### An example agent command (not tested against the real program in this repository)

```bash
--agent-cmd 'claude -p "$(cat "$VT_REPLAY_TASK_FILE")" --append-system-prompt "$(cat "$VT_REPLAY_PROMPT_FILE")" --permission-mode acceptEdits' --pass-env ANTHROPIC_API_KEY
```

The tests in this repository use a small stand-in script. Check these flags against your installed Claude Code before relying on them.

## 3. Reading the report

The report shows, for each prompt: runs, **passed**, **not tested**, **failed**, nothing committed, agent error or time-out, pass rate, median agent time and total time. Then one sentence, in bold:

- *The candidate is better / worse* — only when the difference is unlikely to be luck (exact sign test on the tasks where exactly one prompt passed, p below 0.05).
- *Cannot tell* — the usual answer on 10 to 20 tasks. To show a real difference you need roughly **6 tasks that one prompt passes and the other fails, with none the other way**. That is how little 20 tasks can prove. More runs per task (`--repeats 3`) make each task's result steadier but do not add tasks.
- *No task changed* — the two prompts did the same on these tasks.

Below that: "Read this first" warnings (too few tasks, single runs, agent errors, NOT TESTED), a task-by-task table next to what happened the first time round, why runs failed (the failed check and its one-line summary), and the tasks that could not be replayed with the reason (for example: the starting commit is not in your clone; fetch the project first).

## Limits, plainly

- It measures **whether tests pass**, not whether the code is good. Weak tests make a weak comparison; if no test command is set up, everything is NOT TESTED and the comparison says so.
- Agents are not deterministic. One run per task is noisy; use `--repeats 3` for decisions that matter.
- Each run costs real model usage. 20 tasks × 2 prompts × 3 repeats is 120 agent runs.
- The tests and the agent run on your machine as the invoking user. They run code a model wrote. Use a throwaway user or machine; the tool refuses to run as root (`--allow-root` exists for throwaway machines only).
- Starting commit = the merge base of the task's branch and its base branch when the gate ran. If the agent rebased first, that commit is later than where the work really began.
- A task whose ticket text was longer than Paperclip returned is marked cut short and is not replayed.
