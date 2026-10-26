# Step 5: candidate screening

**Method:** GitHub commit search, last 56 days (8 weeks) from 2026-10-26.
No full audit was run. Each repo's commits were fetched from GitHub's search API
(read-only, no clone). Bots were filtered by login/name heuristics
(`[bot]`, `-bot` suffix, `bot-` prefix, `team-`, `hc-github`, known bot names).
Qualifying authors: distinct non-bot authors with ≥3 commits in the window.
Qualifying days: distinct calendar days with at least one non-bot commit.

**Criteria:** 7–10 qualifying authors AND ≥40 distinct commit-days in 56 days (≈5/week).

---

## Fully qualifying repos (7–10 authors AND ≥40 days)

| Repo | Authors (≥3c) | Total commits | Commit-days | Corporate |
|------|--------------|--------------|-------------|-----------|
| hashicorp/nomad | 9 | 126 | 48 | HashiCorp (IBM) |

**hashicorp/nomad detail:**
Authors: mismithhisler (25), jrasell (22), tgross (21), allisonlarson (10),
eshan-tripathi (4), tehut (4), gulducat (4), chrisroberts (3), mzhang8132 (3).
`hc-github-team-nomad-core` (4 commits) filtered as team bot.

---

## Near misses

| Repo | Authors (≥3c) | Total commits | Commit-days | Gap | Corporate |
|------|--------------|--------------|-------------|-----|-----------|
| grafana/tempo | 10 ✓ | ~80 | 36 | 4 days short | Grafana Labs |
| kubernetes-sigs/karpenter | 8 ✓ | ~60 | 28 | 12 days short | AWS |
| thanos-io/thanos | 10 ✓ | ~70 | 27 | 13 days short | CNCF community |

**Note on commit-days:** Repos with more than 100 total commits required multiple
pages of search results to count authors accurately; commit-days from a single page
of 100 items can under-count the full 56-day window. The near-miss commit-day counts
are lower bounds. None came close enough to the 40-day threshold to qualify even
with adjustment.

---

## Repos screened and eliminated

~30 additional repos were checked and eliminated for one or more of:
- Too few qualifying authors (<7 or >10)
- Commit-days below 40 (teams commit in bursts, not daily)
- Results inconclusive (total_count far exceeded 100, making author counts unreliable
  without exhaustive pagination)

---

## Summary

Only one repo meets all criteria for a pilot audit: **hashicorp/nomad**.
The combination of exactly 7–10 daily-active authors is rare; most active projects
either have larger contributor bases or commit fewer than 5 days per week.
hashicorp/nomad is corporate (HashiCorp/IBM), so it represents a corporate product
team structure rather than an open-source community project.
