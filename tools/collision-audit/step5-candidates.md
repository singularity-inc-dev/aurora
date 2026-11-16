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
| grafana/tempo | 10 ✓ | 155 (complete) | 36 | 4 days short | Grafana Labs |
| firecracker-microvm/firecracker | 10 ✓ | 207 (200 fetched) | 33 in-window | 7 days short | AWS |
| kubernetes-sigs/karpenter | 8 ✓ | ~60 | 28 | 12 days short | AWS |
| thanos-io/thanos | 10 ✓ | ~70 | 27 | 13 days short | CNCF community |

**grafana/tempo detail (all 155 commits, confirmed complete):**
10 authors ≥3c: zhxiaogg (27), javiermolinar (20), ruslan-mikhailov (15),
knylander-grafana (11), zalegrala (11), mapno (10), mdisibio (8), electron0zero (8),
carles-grafana (7), julienduchesne (4). Commit-days: 36/56.

**firecracker-microvm/firecracker detail (200/207 commits fetched):**
10 authors ≥3c: ilstam (43), marco-marangoni (42), JamesC1305 (30), not4s (27),
Manciukic (18), ShadowCurse (11), 14sea (5), iamrekas (4), zulinx86 (4), JackThomson2 (3).
33 commit-days fall inside the Aug 31 window; 15 additional author-dated commits
pre-date the window start (squash-committed during the window).

**Note on rust-lang/rust-analyzer:** 197 total commits (complete), 55 commit-days (well over
40), but 16 qualifying authors — above the 7–10 range. Active enough, team too distributed.

**Note on commit-days:** Repos with more than 100 total commits required multiple
pages of search results to count authors accurately. For repos where the search
`committer-date` range includes commits with `author.date` before the window, only
in-window author dates are counted. The near-miss commit-day counts are confirmed
values (both pages fetched for tempo and firecracker).

---

## Repos screened and eliminated

~45 repos were checked and eliminated for one or more of:
- Too few qualifying authors (<7): git-cliff (1), nickel-lang/nickel (2), moonrepo/moon (2),
  DioxusLabs/dioxus (1), tursodatabase/libsql (2), cert-manager (3), tauri-apps/tauri (4),
  biomejs/biome (4), weaviate/weaviate (6), qdrant/qdrant (6), fluxcd/flux2 (6),
  cockroachdb/pebble (6)
- Too many qualifying authors (>10): nushell/nushell (35+), rust-lang/rust-analyzer (16),
  GreptimeTeam/greptimedb (12)
- Authors in range but commit-days too low: typst/typst (7 authors, 18 days),
  gleam-lang/gleam (10 authors, 11 days)
- Too high commit volume (>400 total, making author count in 100-commit sample unreliable):
  astral-sh/ruff (810), astral-sh/uv (967), oxc-project/oxc (1286), zed-industries/zed (834),
  grafana/loki (881), prometheus/prometheus (436), apache/arrow-rs (428), duckdb/duckdb (4439)
- Squash-merge repos (only 1 non-merge commit returned): surrealdb/surrealdb, neondatabase/neon

---

## Summary

Only one repo meets all criteria for a pilot audit: **hashicorp/nomad**.
The combination of exactly 7–10 daily-active authors is rare; most active projects
either have larger contributor bases or commit fewer than 5 days per week.
hashicorp/nomad is corporate (HashiCorp/IBM), so it represents a corporate product
team structure rather than an open-source community project.
