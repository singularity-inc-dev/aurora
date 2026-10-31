# Collision audit

The pilot's week 0 (see `pilot-playbook.md`): how often a team's parallel work collided over the last 90 days, and how often it would have conflicted if it had been done in parallel. A team runs it on its **own copy** of its repository.

- **Read-only.** It reads the history. Replays write their scratch objects to a temporary folder, which is deleted afterwards; the clone's branches, files and objects are not changed (the tests check this).
- **Sends nothing.** There is no network code, and git runs with every remote protocol refused, so it cannot fetch or push.
- **Needs** git 2.38 or newer and Python 3.9 or newer. Nothing to install.

## Run it

```bash
git clone https://github.com/OWNER/NAME.git team-repo      # a fresh clone of the default branch
tools/collision-audit/collision-audit team-repo OWNER/NAME
```

Options: `--days 90` (the window), `--max-pairs 60` (most overlaps to replay; an even sample when there are more), `--out DIR`.

It writes a folder `collision-audit-OWNER_NAME-DATE/` with `summary.md` (the one page to send the team) and the data behind it.

The playbook's five steps can also be run one by one. Clone into `repos/OWNER__NAME`, then:

```bash
python3 -I measure_overlap.py repos overlap.json OWNER/NAME           # window: COLLISION_AUDIT_DAYS (default 90)
python3 -I replay_pairs_v2.py repos pairs.jsonl 60 OWNER/NAME
python3 -I classify_overlap.py repos pairs.jsonl classified.jsonl
python3 -I conflict_rates.py classified.jsonl pairs.jsonl overlap.json [rates.json]
python3 -I weekly_estimate.py repos weekly.json OWNER/NAME [classified.jsonl]
python3 -I summary.py .                                                 # summary.md, from overlap, rates and weekly
```

## What it counts

1. **Overlaps** (`measure_overlap.py`): two different people changing the same code file on the same day, on the default branch. Docs, data, lock files, generated and vendored files don't count, nor do bots. The day is in the author's own time zone.
2. **Replays** (`replay_pairs_v2.py`): for each overlap, the earlier change stays on its own parent (the base). The later change is moved onto that same base on its own, and git merges the two (`git merge-tree --write-tree`). The pair counts as a conflict when the file they both changed conflicts. If the later change cannot be moved onto the base cleanly (it built on work in between), the replay is "not replayable" and is left out. This is how the spec's measurement was made ("439 clean replays were kept").
3. **Classes** (`classify_overlap.py`): a pair is a "follow-up" when the later change edits lines the earlier change wrote (from `git blame`); otherwise it is "independent".
4. **Rates** (`conflict_rates.py`): the share of independent pairs that conflicted, with a 95% (Wilson) interval. Would-be conflicts a week = overlaps a week × that rate.
5. **Weeks** (`weekly_estimate.py`): overlaps week by week, at today's pace and at three days of work per handover (two people changing the same file within the same three-day stretch).

## Limits

- Textual conflicts only: merges that succeed but break behaviour are missed. Read a sample of the flagged pairs in `pairs.jsonl` before trusting a team's number.
- Teams that rebase or squash every change often leave few replayable pairs: the later change was already adapted to the earlier one.
- Run it on a fresh clone. A clone's own `.git/config` is used (global and system config are not), so a clone with custom merge drivers set up by hand could run them.

## Tests

```bash
python3 -I tools/collision-audit/tests/test_audit.py
```

They build a small made-up team repository (three people, branches, a bot, a follow-up, an old change outside the window) and check every number, that the clone is unchanged, and that git cannot reach a remote.
