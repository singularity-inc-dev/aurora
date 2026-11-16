# Collision audit: batch summary

| Repo               | Window                  | People | Overlaps/wk (same-day) | Overlaps/wk (3-day) | Would-be conflicts/wk (3-day) |
| ------------------ | ----------------------- | ------ | ---------------------- | ------------------- | ----------------------------- |
| astral-sh/ruff     | 2026-08-31 – 2026-10-26 | 28     | 3.38                   | 11.38               | 0                             |
| biomejs/biome      | 2026-08-31 – 2026-10-26 | 21     | 2.62                   | 5.5                 | 0                             |
| trpc/trpc          | 2026-08-31 – 2026-10-26 | 37     | 2.25                   | 2.75                | 0                             |
| pydantic/pydantic  | 2026-08-31 – 2026-10-26 | 25     | 0                      | 0                   | n/a                           |
| zed-industries/zed | 2026-08-31 – 2026-10-26 | 67     | 5.88                   | 20.38               | 0                             |

**Method:** History-based: replays human commits on the default branch. Agent commits are not included.

**Limits:** Counts textual git conflicts only; merges that succeed but break behaviour are not detected. Historical rate for humans, not a measured agent conflict rate.
