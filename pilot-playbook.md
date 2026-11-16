# Manual pilot playbook

Oct 24, 2026 · @Rach

Replaced on 24 October by the pilot on real teams; see Build plan in Aurora v1: product and build specification. Week 0's collision audit and the tables in What to record still apply to each pilot team.

For four weeks you do Hardy's job by hand for one real team, while their own agents write the code. The pilot shows whether teams want the handover loop, how often their agents really collide, and what Hardy must do first. It runs alongside the build, so it doesn't delay it.

## What manual means

Manual means you do Aurora's coordination by hand; the team's own agents still write all the code.

| Part of the loop | In the pilot | In the product |
| --- | --- | --- |
| Code, tests and training runs | The team's own agents: Claude Code, Codex or Cursor | The same agents, run by Aurora |
| Outcome cards, contracts and work orders | You draft them with Claude in a shared doc; owners edit them | Each master agent drafts them |
| Gauge | You estimate hours and cost | Aurora estimates |
| Pre-handover check | You compare everyone's claims in a table | Hardy |
| Handover | Owners start their agents with the work order text | Scheduled or Hand over now |
| Watching runs | You check each run once while it works | Hardy watches continuously |
| Decision inbox | You build it in the doc with screenshots, test results and charts | Generated screens |
| Approval | Owners approve in GitHub | In Aurora, posted to GitHub |
| Decision log | You write it | Aurora records it |

This is a Wizard-of-Oz test: people stand in for the system before it's built. Nigel Cross proposed it in 1977, to "fill the black box with people as with machinery" ([source](https://www.kmjn.org/snippets/cross77_wizardofoz.html)). Paul Graham's version for startups: "Some startups could be entirely manual at first" ([essay](https://www.paulgraham.com/ds.htm)).

## Can you build without it?

Yes. Nothing in the build has to wait for the pilot except the order in which you build Hardy's features. But some questions only real people can answer.

| Question the pilot answers | Why code alone can't answer it |
| --- | --- |
| Do this team's agents collide every week? | An earlier, unreproduced estimate put people's conflict rate at 33%; our corrected run measured 1 in 104. Agents may collide more or less often |
| Will owners write and approve contracts? | It's a new habit, and only watching people shows whether they'll keep it |
| Is one to two hours the right size for a work order? | It depends on their codebase and their agents |
| How long does approving a handback take? | Review time is people's time |
| Which of Hardy's judgments come up most? | That decides what to automate first |
| Would the team keep using it, or pay? | Only they can say |

Pick the size that fits your time:

| Size | What you do | Your time (my estimate) | What you learn |
| --- | --- | --- | --- |
| Minimum, 1 to 2 days | The collision audit on 3 to 5 teams' repositories | 3 to 4 hours | How often their parallel work collided |
| Light, 2 weeks | The audit, then shadow mode on one team | About 30 minutes a day | Real overlaps, and what Hardy would have caught |
| Full, 4 weeks | The audit, handovers run by hand, then shadow mode | About 2 hours per handover, plus 30 minutes a day in the shadow weeks | All of the above, plus whether the handover loop works |

Skipping it altogether risks building Hardy's hardest parts before you know they're needed. The rest of this playbook describes the full pilot.

## Who you need and the time it takes

One team is enough to start; two or three give you numbers you can compare.

- **A team of 2 to 10 people** building one product, where each person already runs their own agent.
- **Two or three owners** with clear areas, such as UI, backend, queries or training.
- **One real feature** that crosses at least two owners' areas and splits into 6 to 12 work orders.
- **You, as Hardy.**

| Who | Time (my estimate) | What for |
| --- | --- | --- |
| Each owner | About 1 hour per handover | Capture (15 minutes), approving the handback (about 15), answering your questions |
| You | About 2 hours per handover, plus 30 minutes a day in weeks 3 and 4 | Drafting, the pre-handover check, watching runs, building the inbox, keeping the logs |
| The team lead | 30 minutes at the start and at the end | Agreeing the pilot, then the end-of-pilot decision |

Each owner uses their own model account and limits, so agree a spending cap per handover before you start.

## Before week 0

Set everything up in one session of about two hours, so the weeks that follow are only handovers and notes.

- [ ] Recruit the team with the message below, and get a written OK from whoever owns the code.
- [ ] Agree what you can see: read-only access for the audit, or the team runs the audit itself.
- [ ] Each owner names their area, and you write the areas into a CODEOWNERS file.
- [ ] Turn on branch protection with a required review on the main branch.
- [ ] Make a protected test repository with one test pull request, for checking later that an approval posted by an app for an owner counts.
- [ ] Open one shared doc with the templates (in the main tab), the measurement sheet and your Hardy log.
- [ ] Open one group chat for questions.
- [ ] Agree spending caps per handover and per person.
- [ ] Pick the feature and write its first outcome card together.

A message you can adapt:

```text
Hi [name], I'm building Aurora, a tool that lets each person's coding agent work on a shared product without colliding with teammates' agents.

I'd like to run a free four-week pilot with your team. First I replay your last 90 days of git history to show how often your parallel work collided. It's read-only, and you can run it yourself. Then I coordinate one real feature by hand while your own agents write the code.

It takes about an hour per person per handover, and you get the collision report either way. Interested?
```

## Week 0: the collision audit

The audit replays the team's recent git history to show how often two people changed the same code file on the same day, and how often that work would have conflicted if it had been done in parallel. It uses the collision-audit scripts from the earlier analysis, needs git 2.38 or newer and Python 3.9 or newer, and uploads nothing.

1. Get read access, or send the scripts to the team so they run them.
2. Clone the repository into the `repos` folder as `owner__name`.
3. Set the time window at the top of `scripts/measure_overlap.py` to the last 90 days.
4. Run the five steps:

```bash
python3 -I scripts/measure_overlap.py repos overlap.json owner/name
python3 -I scripts/replay_pairs_v2.py repos pairs.jsonl 60 owner/name
python3 -I scripts/classify_overlap.py repos pairs.jsonl classified.jsonl
python3 -I scripts/conflict_rates.py classified.jsonl pairs.jsonl overlap.json
python3 -I scripts/weekly_estimate.py repos weekly.json owner/name
```

5. Read the result. Would-be conflicts a week = overlaps a week × the conflict rate, at the team's current pace and at three days of work per handover.
6. Send the team a one-page summary: overlaps a week, conflict rate, would-be conflicts a week, and the files where most overlaps happened.
7. Decide whether to continue with this team. If it would hit fewer than one conflict a week even at three times its pace, choose a busier team or repository.

The audit counts textual conflicts only, so it misses merges that succeed but break behaviour. Read a sample of the flagged pairs by hand before trusting one team's number.

## Weeks 1 and 2: handovers by hand

Run four to six handovers of the chosen feature, two or three a week, each following the same script. The times are my suggestion; record the real ones.

| Step | When | Who | Time | What comes out |
| --- | --- | --- | --- | --- |
| 1. Capture | During the day | Each owner with you | 15 minutes | One outcome card per owner, drafted by you with Claude |
| 2. Contracts | Right after | You draft, each owner approves their part | 10 minutes | A contract for each place where areas meet |
| 3. Work orders | Right after | You and Claude draft, owners edit | 20 minutes | 6 to 12 work orders, each with a locked check, its claims and a gauge colour |
| 4. Pre-handover check | Before people log off | You | 10 minutes | Overlaps fixed, order set, at most three questions per owner answered |
| 5. Handover | On a schedule or right away | Each owner | 5 minutes | Each owner's agent started with its work order text, on its own branch |
| 6. Watch | Once while each run works | You | 5 minutes per run | Notes on anything that touched another owner's contract or unclaimed files |
| 7. Handback | When the runs finish | You | 30 minutes | Each owner's inbox in three tiers, with screenshots, test results and charts |
| 8. Decide | Next time owners log in | Each owner | About 15 minutes, timed | Approvals in GitHub, or changes asked for |
| 9. Log | Right after | You | 10 minutes | Each decision and its reason, plus every judgment you made as Hardy |

Your checklist for step 4, the pre-handover check:

- [ ] Do two work orders claim the same file or contract?
- [ ] Does a work order change a contract another owner uses, and has that owner agreed?
- [ ] Is the order right? Work that others depend on, such as an agreed request shape, goes first.
- [ ] Is anything red on the gauge? Split it or get the owner's confirmation.
- [ ] Does the handover fit the spending caps?

Your checklist for step 7, the handback:

- [ ] Did each locked check pass, and did the agent edit only what it claimed?
- [ ] Do the results from different owners still fit together? Replay the branches together with `git merge-tree --write-tree` to find textual conflicts.
- [ ] Sort each item into needs you, review suggested, or passed under the owner's rules.
- [ ] Put the evidence on the same page as the item, so the owner never has to look elsewhere.

## Weeks 3 and 4: shadow mode

The team goes back to working the way it normally does with its agents, and you watch without changing anything. This shows what Hardy would catch in ordinary work, not only in a feature you planned together.

Once a day, in about 30 minutes:

1. List the pull requests the team's agents opened or updated since yesterday.
2. For each pair from different owners that are open at the same time, replay them together with `git merge-tree --write-tree` and note any textual conflict.
3. Note any change to something another owner depends on, such as a request shape, a data format or a shared component.
4. Write down what Hardy would have done: flag it before the work started, pause it, or send it to an owner.
5. Don't tell the team during the day. Keep the notes for the end.

At the end of week 4, compare your notes with what actually happened: which conflicts the team hit, how long each took to fix, and which work was redone. That comparison is the strongest evidence the pilot produces.

## What to record

Two tables carry the whole pilot: one row per work order in the measurement sheet, and one row per judgment in your Hardy log. Fill them as you go; add rows as needed.

### Measurement sheet

| Date | Handover | Owner | Work order | Gauge (estimated hours) | Estimated cost | Actual cost | Check passed? | Approved without edits? | Minutes to approve | Overlaps caught before | Conflicts found after | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |  |  |  |  |  |

Handover yield is the share of rows where the check passed and the work was approved without edits.

### Hardy log

| Date | Handover | What you decided as Hardy | Information you needed | Where it came from | Minutes it took |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |
|  |  |  |  |  |  |

"What you decided" and "Information you needed" matter most: they become Hardy's rules and the data it needs.

## End of week 4: the decision

Set the pass marks before week 1, then decide against them with the team lead in a 30-minute review.

| Pass mark (my suggestion) | Target |
| --- | --- |
| Handover yield | At least half in week 1, higher in week 2 |
| Minutes to approve | 15 or fewer per owner per handback |
| Decisions per owner | 5 or fewer per handback |
| Overlaps or conflicts caught | At least one a week, across handovers and shadow mode |
| Owners who want to continue | At least two of three |

| Result | What it looks like | What you do |
| --- | --- | --- |
| Go | The pass marks are met | Build milestones M2 to M4 in the order your Hardy log shows |
| Change | Conflicts are real, but approvals are slow or owners skip contracts | Change the loop, for example fewer questions or contracts drafted for owners, and run two more weeks |
| Stop or rethink | Fewer than one overlap or conflict a week, or owners don't want to continue | Try a bigger or busier team once; if the result repeats, rethink Hardy's place in Aurora |

## What the pilot feeds into the build

Every record from the pilot becomes a concrete build input, so nothing you do by hand is wasted.

| From the pilot | Becomes in the build | Milestone |
| --- | --- | --- |
| The template fields owners actually filled in | The data model for outcome cards, contracts and work orders | M1 |
| Your gauge estimates against the real times and costs | The gauge's thresholds and cost estimates | M1 |
| The overlaps you caught in pre-handover checks | The rules of Hardy's pre-handover check | M2 |
| The questions you asked owners | Hardy's question templates | M2 |
| How you laid out each inbox item | The generated screen for each kind of work | M3 |
| The approval test on the protected repository | Approvals in Aurora that land in GitHub | M3 |
| Your most frequent judgments | What Hardy watches and settles first | M4 |
| Decisions and their reasons | The decision log's fields | M5 |

## Keeping the team's code safe

The team's code and accounts stay theirs throughout the pilot.

- The audit is read-only, and the team can run it on its own machines; the scripts upload nothing.
- Agents work only on their own branches. The main branch stays protected, and nothing merges without an owner's approval.
- Each owner uses their own model account. You never ask for passwords, tokens or keys.
- No secrets go into work orders, the shared doc or the group chat.
- Delete your local copies of the repository when the pilot ends, and tell the team you have.
