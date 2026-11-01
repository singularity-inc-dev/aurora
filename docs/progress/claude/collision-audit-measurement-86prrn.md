# Collision measurement, November 2026 (new measurement)

Branch `claude/collision-audit-measurement-86prrn`. Written 1 November 2026.

**This is a new measurement. It is not a reproduction of the research's 33% figure.** Different repositories (none of the research's 20 are included), different filters, different scripts. Nothing here should be quoted as confirming or refuting 33%.

Status: **PRE-REGISTRATION. The audit has not been run yet.** Everything below this line up to "Results" was written and committed before any audit command ran. Results are added in later commits.

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

## Results

*Not run yet.*
