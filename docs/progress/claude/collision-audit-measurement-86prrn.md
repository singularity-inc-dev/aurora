# Collision measurement, November 2026 (new measurement)

Branch `claude/collision-audit-measurement-86prrn`. Written 1 November 2026.

**This is a new measurement. It is not a reproduction of the research's 33% figure.** Different repositories (none of the research's 20 are included), different filters, different scripts. Nothing here should be quoted as confirming or refuting 33%.

Status: **Run finished 1 November 2026.** Sections 1 to 6 were written and committed (`973df14`, corrected in `567cddf`) before any audit command ran. Section 7 onward was added after the run.

## 1. Question

Does history from real product teams support Hardy's trigger: **at least one conflict a week for teams of 5 to 10 people, at agent volume** (`docs/design/HARDY.md` section 3)? Answer "no" if the data does not show it.

## 2. Window and the 20 repositories

- **Window:** 365 days, 2025-11-01 00:00 UTC to 2026-11-01 00:00 UTC (fixed; `COLLISION_AUDIT_UNTIL`).
- **Team size** = number of "core people": non-bot authors with **at least 10 non-merge commits** on the default branch in the window (the research's definition), with one person's several e-mail addresses merged by display name and names of translation services, coding agents and robots removed.
- **Bins** (as requested): 2-3, 5-6, 7-10, 11-30 core people, 5 repositories each. **Team size 4 is not in your bins**, so no 4-person repository was picked (none of the 31 screened candidates turned out to have exactly 4, so nothing was skipped for it).

| Size bin | Repository | Branch | Core people (≥10 commits) | Non-bot commits in window | Stars |
|---|---|---|---|---|---|
| 2-3 | [decaporg/decap-cms](https://github.com/decaporg/decap-cms) | main | 3 | 317 | 19461 |
| 2-3 | [ether/etherpad](https://github.com/ether/etherpad) | develop | 2 | 412 | 18614 |
| 2-3 | [Kentucky-ai/opentakeoff](https://github.com/Kentucky-ai/opentakeoff) | main | 2 | 635 | 734 |
| 2-3 | [mercurjs/mercur](https://github.com/mercurjs/mercur) | main | 3 | 1008 | 1876 |
| 2-3 | [RushB-fr/freekiosk](https://github.com/RushB-fr/freekiosk) | main | 3 | 312 | 712 |
| 5-6 | [deeplethe/utopia](https://github.com/deeplethe/utopia) | main | 6 | 870 | 8654 |
| 5-6 | [influxdata/telegraf](https://github.com/influxdata/telegraf) | master | 6 | 724 | 17891 |
| 5-6 | [OpenByteInc/QuantDinger](https://github.com/OpenByteInc/QuantDinger) | main | 5 | 688 | 13370 |
| 5-6 | [robusta-dev/robusta](https://github.com/robusta-dev/robusta) | master | 6 | 177 | 3127 |
| 5-6 | [timeplus-io/proton](https://github.com/timeplus-io/proton) | develop | 5 | 233 | 2280 |
| 7-10 | [cortexproject/cortex](https://github.com/cortexproject/cortex) | master | 7 | 434 | 5877 |
| 7-10 | [cryptpad/cryptpad](https://github.com/cryptpad/cryptpad) | main | 8 | 667 | 8033 |
| 7-10 | [grafana/beyla](https://github.com/grafana/beyla) | main | 8 | 489 | 2152 |
| 7-10 | [homarr-labs/homarr](https://github.com/homarr-labs/homarr) | dev | 7 | 670 | 5262 |
| 7-10 | [PegaProx/project-pegaprox](https://github.com/PegaProx/project-pegaprox) | main | 10 | 1445 | 1706 |
| 11-30 | [AtalayaLabs/OxiCloud](https://github.com/AtalayaLabs/OxiCloud) | main | 12 | 2085 | 3670 |
| 11-30 | [DefectDojo/django-DefectDojo](https://github.com/DefectDojo/django-DefectDojo) | master | 17 | 1619 | 5174 |
| 11-30 | [GreptimeTeam/greptimedb](https://github.com/GreptimeTeam/greptimedb) | main | 15 | 1686 | 6778 |
| 11-30 | [OpenNMS/opennms](https://github.com/OpenNMS/opennms) | develop | 14 | 1379 | 1180 |
| 11-30 | [serenedb/serenedb](https://github.com/serenedb/serenedb) | main | 11 | 833 | 954 |

31 candidates were screened in draw order to fill these 20. Rejected ones, with the reason, are in `tools/collision-audit/measurement-2026-11/screening-final.json`; in short:

- chaitin/SafeLine: fewer than 100 commits in the window
- shopware/shopware: 59 core people: outside 2-30 or exactly 4
- peach-mitao/peach: 1 core people: outside 2-30 or exactly 4
- fluentcms/FluentCMS: fewer than 100 commits in the window
- niledatabase/niledatabase: fewer than 100 commits in the window
- thalesgroup-cert/Watcher: fewer than 100 commits in the window
- flexprice/flexprice: bin 11-30 already full
- theopenco/llmgateway: bin 11-30 already full
- highlight/highlight: fewer than 100 commits in the window
- evershopcommerce/evershop: 1 core people: outside 2-30 or exactly 4
- withstudiocms/studiocms: 1 core people: outside 2-30 or exactly 4

## 3. How the 20 were chosen

All scripts are in `tools/collision-audit/measurement-2026-11/`. Nothing in the selection looked at merges, conflicts, overlaps or any audit output; no audit output existed.

1. **Pool** (`pool.py`, run 1 November): GitHub repository search, for each of 25 topics (self-hosted, saas, crm, analytics, dashboard, project-management, no-code, low-code, workflow-automation, headless-cms, ecommerce, monitoring, observability, collaboration, productivity, scheduling, forms, feature-flags, email, note-taking, customer-support, billing, invoicing, knowledge-base, authentication), the first 200 by stars with: 500 to 25,000 stars, pushed on or after 2026-10-01, not archived, not a fork, under about 1 GB, **owner is a GitHub Organization**. Result: 975 repositories (`pool.json`). **Excluded on purpose:** the 20 repositories named on p.28 of the research PDF and the 8 repositories of the earlier 56-day audit (ruff, biome, trpc, pydantic, zed, nomad, firecracker, thanos), so the sample is independent.
2. **Order** (`draw.py`): sorted by SHA-256 of `aurora-collision-2026-11-01/<owner>/<name>`. The seed was fixed before the pool was built.
3. **"Product" judgement** (`judgements-*.json`): in draw order, from name, description and topics only: *yes* = an application or service someone runs or uses directly (web app, server, database, platform, desktop or mobile app); *no* = library, framework, SDK, template, plugin, list, tutorial, one-shot command-line tool. This is a human judgement and some calls are arguable (for example, I said yes to databases, daemons and exporters, no to command-line tools).
4. **Screen** (`screen.py`): in draw order, among the *yes* ones: at least 100 non-bot, non-merge commits in the window; a commit on or after 2026-09-02; 2 to 30 core people, not 4; accepted while its bin has fewer than 5.

**Three things I changed after seeing screening output (disclosed, because they shape the sample):**

- **Pass 1** (`screening-pass1-discarded.json`) filled the bins from the first 70 draws, but most were individual-owned hobby repositories, some with thousands of commits from one or two people. I added the **Organization-owner rule** and rebuilt the pool.
- **Pass 2** (`screening-pass2-discarded.json`) counted `Weblate`, `Claude`, `Codex`, `proton-robot` and "Peach local maintenance" as people, and counted the same person under two e-mail addresses twice. `peach-mitao/peach` was "3 core people" and was really one human plus agent identities. I added the **merge-by-name and automation-name rules**. Pass 3 (`screening-final.json`) is the list above.
- Only author names, commit counts and descriptions were looked at when making these changes. No audit result existed.

**Consequence you should know about:** the sample is organisation-owned, 500 to 25,000 star, topic-searched projects. It is not a random sample of "product teams", and it leans to infrastructure and developer tools. 20 teams, 5 per bin, is small.

## 4. Method (what is run)

- **Tools:** `tools/collision-audit/` as in commit `0137939` (branch `claude/eloquent-hopper-9m2e04`), brought to this branch in commit `e3dacaa`, with one addition: `COLLISION_AUDIT_UNTIL` (fixed window end). The truncated-clone guard is the fixed one (`ff45c08`). I tested it again (24 unit tests): a real `--depth` clone is refused; a `--shallow-since` clone that keeps a commit before the window is accepted.
- **Clone:** `git clone --single-branch --branch <default> --shallow-since=2025-10-02` (30 days before the window start, so there is a commit before the window and the guard takes its clean path; the batch script's own `--fetch` clones from exactly the window start, which the guard can reject falsely on an active repository).
- **Audit command, per repository** (from `run.sh`):
  `COLLISION_AUDIT_UNTIL=2026-11-01 COLLISION_AUDIT_MIN_COMMITS=10 tools/collision-audit/collision-audit CLONE owner/name --days 365 --max-pairs 150 --out OUT/owner_name`
  The whole run: `tools/collision-audit/measurement-2026-11/run.sh OUTDIR 3`.
- **What it counts** (README of the tool): *overlap* = two different people change the same code file on the same day on the default branch; *replay* = the later change is moved onto the earlier change's parent and git merges the two; a replay that cannot be set up is "not replayable" and left out; *clean replays* in this report = replayable pairs (what the tool calls `cleanReplays`); *textual conflict* = the shared file conflicts in the merge; *independent* pairs exclude follow-ups (later change edits lines the earlier one wrote). At most 150 overlaps per repository are replayed (an even sample).
- **Recorded for each repository** (`manifest.json`): head commit of the clone, clone time, git and Python versions.

## 5. Analysis, fixed in advance

Per size bin, over its 5 teams:

1. **Same-day file overlaps per week per team:** overlaps ÷ (365/7). Bin value = mean over teams, with the range over teams, and a 95% interval by bootstrap over teams (10,000 resamples, seed 1).
2. **Clean replays and textual conflicts:** counts per bin; conflict rate for independent pairs with a 95% Wilson interval on the pooled counts, and the same by bootstrap over teams. The pooled Wilson interval is too narrow because pairs from one team are not independent; read the bootstrap one.
3. **Conflicts per team-week** = overlaps per week × conflict rate of independent pairs (all clean replays if a team has none), shown two ways: at today's pace (same-day overlaps) and at the **3-day handover proxy** (two people changing the same file within three days; the tool's stand-in for agent volume). 95% interval by two-level bootstrap (teams, then replayed pairs inside each team).
4. **Hardy test:** pool the bins 5-6 and 7-10 (10 teams). **"Supports the trigger" only if the lower end of the 95% interval for conflicts per team-week at the 3-day proxy is at least 1.** Anything else is answered "no". I will also state the **break-even multiplier**: how many times busier than the 3-day proxy the teams would have to be to reach 1 a week.
5. Team size 4 and any repository that fails are reported, not dropped.

## 6. Known weaknesses, stated before the run

- This is **people's history, not agents**. Agent volume is not measured; the 3-day proxy is an assumption carried over from the research.
- **Textual conflicts only.** Merges that succeed and break behaviour are not counted, and the trigger as worded in the research counts those too.
- **Squash-merge and rebase workflows** make the later commit already adapted to the earlier one, so those pairs are "not replayable" or follow-ups and drop out. That lowers measured conflict rates against what truly parallel work would show.
- The tool treats every non-bot e-mail as a person. Coding-agent identities and the same person under two addresses are only cleaned in the *team-size* count, not inside the audit itself, so overlap counts can include them. I will report the audit's own `people` figure next to the screening's core count.
- 5 teams per bin means very wide intervals. Bootstrap over 5 teams is crude.
- Committer-date filtering for the window and author-date for the day can disagree around the edges.
- The sample selection (section 3) is a judgement-laden filter, not a random draw of teams.

## 7. Answer in plain English

**No. This data does not support Hardy's trigger.**

In the 10 teams of 5 to 10 core people, two people changed the same code file on the same day about **1.35 times a week per team** (about once or twice a week). But when I replayed those overlaps as if the work had been done in parallel, **only 1 of 206 replayable, independent overlaps produced a textual git conflict (0.5%; 95% interval 0.1% to 2.7%)**. That is about **0.01 conflicts per team per week** (95% upper bound 0.04), even when I assume work comes in three-day handovers instead of today's pace. At that rate a 5-to-10 person team would see one conflict about every 90 weeks. To reach one a week, the teams would have to be about **90 times busier** than the three-day proxy (at least 23 times busier even at the top of the interval). The pre-registered rule needed the *lower* end of the interval to reach 1; the upper end is 0.04.

**What this does not prove (read this before quoting it):**

- **It does not rule Hardy out.** 64% of the replay attempts in these teams could not be replayed, because the later change was built on top of the earlier one (serial work). Those are the cases that would hurt most in truly parallel work, and the replay cannot say what would have happened. If every one of them counted as a conflict, the 5-to-10 figure would be **1.45 a week** (table "Ceiling" below). That is a ceiling, not an estimate: most serial work is simply serial, and would not conflict if sequenced. But it is the reason the answer is "not shown", not "shown to be impossible".
- **It is people's history, not agents.** The "agent volume" in the trigger is not measured here; the three-day proxy is an assumption from the research.
- **Textual conflicts only.** Two changes that merge cleanly and break each other are not counted, and the research's trigger counts those too.
- **Small sample.** 5 teams per bin, a sample of organisation-owned, topic-searched projects (section 3), not a random draw of product teams.
- **Not comparable to the 33%.** Different repositories, filters, scripts and counting. The textual rate here is 0.5% to 1.3% for teams of 5 and up, in line with the earlier 56-day audit (1 conflict in more than 100 clean replays), but I am not claiming that refutes anything.
- **The 2-3 person row is not usable.** It is 20 independent pairs from 4 teams (one team, decap-cms, had none and used the bin's pooled rate), and one team (mercur) has 96% of its 1,658 overlaps on a single day (2026-02-24), which looks like one bulk change and also dominates its replay sample. The 1.4 a week for that bin is that artefact. It plays no part in the Hardy test.

So the pilot still has to answer the question, as the playbook says. If the pilot teams produce conflicts at a pace nothing in this history predicts, that would be new information.

## 8. Results

Numbers below are produced by `aggregate.py` from the 20 audits (`tools/collision-audit/measurement-2026-11/results/`). "Clean replays" = replayable pairs (the tool's `cleanReplays`); the rest of the attempts were not replayable. "Independent" excludes follow-ups. Intervals marked "bootstrap" resample teams and then pairs; with 5 teams they are crude. The bootstrap interval is degenerate (0 to 0) when a bin has no conflicts at all, so use the Wilson one there.

### Per team

| Bin | Repository | Core (screen) | People (audit, ≥10 commits) | Commits | Same-day overlaps | per week | 3-day overlaps per week | Replayed | Not replayable | Clean replays | Conflicts (all) | Independent pairs | Conflicts (independent) | Busiest day (share of overlaps) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2-3 | decaporg/decap-cms | 3 | 3 | 368 | 8 | 0.15 | 0.29 | 8 | 8 | 0 | 0 | 0 | 0 | 2026-09-02 (62%) |
| 2-3 | ether/etherpad | 2 | 2 | 1004 | 5 | 0.10 | 0.13 | 5 | 4 | 1 | 0 | 1 | 0 | 2026-08-21 (40%) |
| 2-3 | Kentucky-ai/opentakeoff | 2 | 3 | 651 | 47 | 0.90 | 1.50 | 47 | 42 | 5 | 1 | 5 | 1 | 2026-07-10 (23%) |
| 2-3 | mercurjs/mercur | 3 | 4 | 1063 | 1658 | 31.80 | 32.45 | 150 | 142 | 8 | 1 | 5 | 1 | 2026-02-24 (96%) |
| 2-3 | RushB-fr/freekiosk | 3 | 3 | 313 | 15 | 0.29 | 0.58 | 15 | 6 | 9 | 3 | 9 | 3 | 2026-03-06 (33%) |
| 5-6 | deeplethe/utopia | 6 | 6 | 871 | 233 | 4.47 | 7.27 | 150 | 88 | 62 | 0 | 62 | 0 | 2026-09-27 (12%) |
| 5-6 | influxdata/telegraf | 6 | 7 | 1512 | 13 | 0.25 | 0.63 | 13 | 5 | 8 | 0 | 8 | 0 | 2026-03-02 (15%) |
| 5-6 | OpenByteInc/QuantDinger | 5 | 6 | 698 | 30 | 0.58 | 1.65 | 30 | 15 | 15 | 1 | 15 | 1 | 2026-08-27 (23%) |
| 5-6 | robusta-dev/robusta | 6 | 6 | 178 | 0 | 0.00 | 0.02 | 0 | 0 | 0 | 0 | 0 | 0 | - (0%) |
| 5-6 | timeplus-io/proton | 5 | 6 | 263 | 11 | 0.21 | 0.31 | 11 | 10 | 1 | 0 | 1 | 0 | 2025-09-30 (64%) |
| 7-10 | cortexproject/cortex | 7 | 7 | 456 | 15 | 0.29 | 0.75 | 15 | 8 | 7 | 0 | 7 | 0 | 2026-05-29 (20%) |
| 7-10 | cryptpad/cryptpad | 8 | 9 | 768 | 14 | 0.27 | 0.58 | 14 | 8 | 6 | 0 | 6 | 0 | 2025-11-19 (14%) |
| 7-10 | grafana/beyla | 8 | 9 | 764 | 45 | 0.86 | 1.40 | 45 | 41 | 4 | 0 | 4 | 0 | 2026-10-05 (29%) |
| 7-10 | homarr-labs/homarr | 7 | 6 | 2061 | 157 | 3.01 | 3.47 | 150 | 106 | 44 | 0 | 42 | 0 | 2026-07-10 (40%) |
| 7-10 | PegaProx/project-pegaprox | 10 | 12 | 1451 | 187 | 3.59 | 7.35 | 150 | 89 | 61 | 0 | 61 | 0 | 2026-08-30 (15%) |
| 11-30 | AtalayaLabs/OxiCloud | 12 | 13 | 2236 | 355 | 6.81 | 14.88 | 150 | 97 | 53 | 1 | 52 | 1 | 2026-03-05 (23%) |
| 11-30 | DefectDojo/django-DefectDojo | 17 | 17 | 2530 | 91 | 1.75 | 4.32 | 91 | 52 | 39 | 0 | 39 | 0 | 2025-11-14 (16%) |
| 11-30 | GreptimeTeam/greptimedb | 15 | 16 | 1715 | 290 | 5.56 | 12.16 | 150 | 52 | 98 | 0 | 98 | 0 | 2026-09-23 (6%) |
| 11-30 | OpenNMS/opennms | 14 | 13 | 1389 | 24 | 0.46 | 1.78 | 24 | 19 | 5 | 2 | 5 | 2 | 2025-11-25 (12%) |
| 11-30 | serenedb/serenedb | 11 | 9 | 833 | 549 | 10.53 | 27.10 | 150 | 107 | 43 | 0 | 43 | 0 | 2026-06-02 (12%) |

### By team size

| Team size | Teams | Same-day overlaps per team-week (95% bootstrap; range over teams) | Clean replays | Textual conflicts (all) | Independent pairs | Conflicts (independent), pooled rate and 95% Wilson | Conflicts per team-week, today's pace (95%) | Conflicts per team-week, 3-day proxy (95%) |
|---|---|---|---|---|---|---|---|---|
| 2-3 | 5 | 6.65 (0.16 to 19.28; 0.10 to 31.80) | 23 | 5 | 20 | 5 of 20 = 25.0% (11.2% to 46.9%) | 1.335 (0.014 to 5.160) | 1.411 (0.027 to 5.312) |
| 5-6 | 5 | 1.10 (0.13 to 2.80; 0.00 to 4.47) | 86 | 1 | 86 | 1 of 86 = 1.2% (0.2% to 6.3%) | 0.008 (0.000 to 0.031) | 0.022 (0.000 to 0.088) |
| 7-10 | 5 | 1.60 (0.40 to 2.81; 0.27 to 3.59) | 122 | 0 | 120 | 0 of 120 = 0.0% (0.0% to 3.1%) | 0.000 (0.000 to 0.000) | 0.000 (0.000 to 0.000) |
| 11-30 | 5 | 5.02 (1.99 to 8.05; 0.46 to 10.53) | 238 | 3 | 237 | 3 of 237 = 1.3% (0.4% to 3.7%) | 0.063 (0.000 to 0.171) | 0.200 (0.000 to 0.570) |
| 5-10 (bins 5-6 and 7-10) | 10 | 1.35 (0.44 to 2.40; 0.00 to 4.47) | 208 | 1 | 206 | 1 of 206 = 0.5% (0.1% to 2.7%) | 0.004 (0.000 to 0.015) | 0.011 (0.000 to 0.044) |

### Ceiling (not pre-registered): every overlap that could not be replayed counted as a conflict

| Team size | Share of replay attempts that were not replayable | Ceiling conflicts per team-week, today's pace | Ceiling conflicts per team-week, 3-day proxy |
|---|---|---|---|
| 2-3 | 90% | 6.31 | 6.61 |
| 5-6 | 58% | 0.64 | 1.13 |
| 7-10 | 67% | 1.07 | 1.76 |
| 11-30 | 58% | 3.06 | 7.46 |
| 5-10 (bins 5-6 and 7-10) | 64% | 0.86 | 1.45 |

### Sensitivity: weekly rates over each repository's active weeks (not pre-registered)

A repository that began part-way through the window is divided by the weeks since its first commit in the window, not by 52.

### By team size (active weeks)

| Team size | Teams | Same-day overlaps per team-week (95% bootstrap; range over teams) | Clean replays | Textual conflicts (all) | Independent pairs | Conflicts (independent), pooled rate and 95% Wilson | Conflicts per team-week, today's pace (95%) | Conflicts per team-week, 3-day proxy (95%) |
|---|---|---|---|---|---|---|---|---|
| 2-3 | 5 | 8.56 (0.16 to 24.42; 0.10 to 39.88) | 23 | 5 | 20 | 5 of 20 = 25.0% (11.2% to 46.9%) | 1.717 (0.014 to 6.521) | 1.839 (0.027 to 6.760) |
| 5-6 | 5 | 5.17 (0.13 to 14.96; 0.00 to 24.71) | 86 | 1 | 86 | 1 of 86 = 1.2% (0.2% to 6.3%) | 0.009 (0.000 to 0.036) | 0.026 (0.000 to 0.105) |
| 7-10 | 5 | 1.82 (0.40 to 3.46; 0.27 to 4.67) | 122 | 0 | 120 | 0 of 120 = 0.0% (0.0% to 3.1%) | 0.000 (0.000 to 0.000) | 0.000 (0.000 to 0.000) |
| 11-30 | 5 | 5.68 (1.99 to 9.37; 0.46 to 11.51) | 238 | 3 | 237 | 3 of 237 = 1.3% (0.4% to 3.7%) | 0.072 (0.000 to 0.199) | 0.219 (0.000 to 0.586) |
| 5-10 (bins 5-6 and 7-10) | 10 | 3.50 (0.45 to 8.53; 0.00 to 24.71) | 208 | 1 | 206 | 1 of 206 = 0.5% (0.1% to 2.7%) | 0.005 (0.000 to 0.018) | 0.013 (0.000 to 0.052) |

### Ceiling (not pre-registered): every overlap that could not be replayed counted as a conflict

| Team size | Share of replay attempts that were not replayable | Ceiling conflicts per team-week, today's pace | Ceiling conflicts per team-week, 3-day proxy |
|---|---|---|---|
| 2-3 | 90% | 8.12 | 8.63 |
| 5-6 | 58% | 3.03 | 5.03 |
| 7-10 | 67% | 1.20 | 2.03 |
| 11-30 | 58% | 3.50 | 8.48 |
| 5-10 (bins 5-6 and 7-10) | 64% | 2.11 | 3.53 |

Active weeks per team: opentakeoff 20, mercur 42, utopia 9, QuantDinger 44, project-pegaprox 40, OxiCloud 39, serenedb 48 (all others 52).

### Hardy test

Pre-registered: {"pointPerTeamWeek3day": 0.011009708737864077, "interval95": [0.0, 0.04401941747572815], "supportsTrigger": false, "answer": "no", "breakEvenMultiplierAtPoint": 90.8289241622575, "breakEvenMultiplierAtUpperBound": 22.717247463608295}

Active-weeks sensitivity: {"pointPerTeamWeek3day": 0.013087884633629551, "interval95": [0.0, 0.05233212105879005], "supportsTrigger": false, "answer": "no", "breakEvenMultiplierAtPoint": 76.40654146893091, "breakEvenMultiplierAtUpperBound": 19.10872289843932}

**Teams without replayable pairs:** decap-cms (2-3; all 8 overlaps not replayable) and robusta (5-6; 0 overlaps). Where a team had no replayable pairs, the bin's pooled rate was used for it, as I said I would use all clean replays when no independent ones exist; this was not spelled out in section 5 for the zero case, so I am saying it here.

**Team size by two counts.** Bins use the screening's core count (section 2). The audit's own `people` column (same definition, but counted by e-mail address and with agent names kept) differs by up to 3 people. By the audit's count, telegraf would move up to 7-10, homarr down to 5-6, PegaProx (12) and serenedb (9) across the 10 and 11 line. Pooled 5-10 contents change by one team (PegaProx leaves; it had 0 conflicts in 61), which does not change the answer.

## 9. What differed from the plan (all of it)

1. **OxiCloud needed a full clone.** The shallow clone was refused by the truncated-clone guard ("oldest commit 2026-02-02 is inside the window"), although the clone was complete: the repository has no commits between early October 2025 and 2 February 2026. The guard cannot tell a quiet spell from a cut-off clone. I audited it from a full (non-shallow) clone instead (`run-one-full-clone.sh`); log of the refusal: `results/logs/AtalayaLabs_OxiCloud.shallow-refusal.log`. Everything else used the pre-registered shallow clone.
2. **Seven repositories are younger than the window** (opentakeoff, mercur, utopia, QuantDinger, PegaProx, OxiCloud, serenedb began 1 to 9 months in; `repo-age.tsv`). Pre-registered rates divide by 52 weeks, which understates their weekly rates. I added an *active-weeks* sensitivity (not pre-registered). It raises the 5-10 figure from 0.011 to 0.013 conflicts per team-week (95% upper 0.052) and does not change the answer.
3. **Added after seeing the results, not pre-registered:** the ceiling table, the busiest-day column and the active-weeks table. The verdict uses only the pre-registered analysis.
4. **Selection rules changed twice after screening output** (section 3): Organization owner, and merging identities and dropping automation names.
5. **The guard is only partly fixed.** It correctly refuses a real `--depth` clone (tested on decap-cms with `--depth 50`: refused, exit 2). It also refuses young or quiet repositories cloned shallow (OxiCloud), and its own hint ("re-clone with `--shallow-since=<window start>`") produces the clone it can falsely refuse when no commit falls on the window's first day. I left the tool as it is and worked around it; a proper fix would record why a clone is shallow instead of guessing from dates.
6. `aggregate.py` and `age.sh` were written or extended while the run was in progress, but the analysis plan in section 5 had been fixed beforehand and I did not change it.
7. `gh api repos/...` on the 20 repositories is outside this session's GitHub scope, so repository ages come from git (`age.sh`), not the API. Cloning read-only over git was the only access used. Nothing was pushed anywhere except this branch.

## 10. How to re-run

**When and from what:** run started 2026-11-01 18:02:49 UTC (`results/RUN_STARTED`) from branch commit `567cddf`; audit tools are the ones in commit `e3dacaa` (= `tools/collision-audit` at `0137939` plus `COLLISION_AUDIT_UNTIL`); `git 2.43.0`, `Python 3.13.18`. Each repository's head commit at clone time is in `results/repos/<owner>_<name>.manifest.json`.

```bash
git checkout claude/collision-audit-measurement-86prrn      # or the commit above
tools/collision-audit/measurement-2026-11/run.sh /path/to/out 3
tools/collision-audit/measurement-2026-11/run-one-full-clone.sh /path/to/out AtalayaLabs/OxiCloud main 11-30
tools/collision-audit/measurement-2026-11/age.sh tools/collision-audit/measurement-2026-11/repo-age.tsv
python3 -I tools/collision-audit/measurement-2026-11/aggregate.py /path/to/out /path/to/results
python3 -I tools/collision-audit/tests/test_audit.py          # 24 tests
```

Per repository, `run.sh` runs: `COLLISION_AUDIT_UNTIL=2026-11-01 COLLISION_AUDIT_MIN_COMMITS=10 tools/collision-audit/collision-audit CLONE owner/name --days 365 --max-pairs 150 --out OUT/owner_name`.

**Limits to an exact repeat:** the repositories are live. The window is fixed, so later commits are ignored, but a force-push or history rewrite upstream would change the result; the recorded head commits show what was used (`git fetch origin <sha>`). The pool (`pool.py`) and the stars shown in the table depend on the day it is run; to repeat the *audit* use `repos.tsv`, not the pool. The 10,000-resample bootstrap uses seed 1.

**Published data:** per repository, trimmed JSON, the replayed pairs (`*.pairs.jsonl.gz`, authors replaced by an 8-character hash, commit ids kept), and logs. No e-mail addresses are in the repository.
