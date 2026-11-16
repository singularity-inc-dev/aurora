"""Step 1 of the repository selection: build the candidate pool from fixed GitHub searches.

    python3 -I pool.py OUT.json

Nothing here looks at git history or at any audit result. The pool is every repository returned
by the searches below (first 200 by stars for each topic), de-duplicated, minus the exclusions.
Needs the `gh` command, signed in (or any proxy that lets it reach api.github.com).
"""
import json
import subprocess
import sys
import time

TOPICS = [
    "self-hosted", "saas", "crm", "analytics", "dashboard", "project-management", "no-code",
    "low-code", "workflow-automation", "headless-cms", "ecommerce", "monitoring", "observability",
    "collaboration", "productivity", "scheduling", "forms", "feature-flags", "email", "note-taking",
    "customer-support", "billing", "invoicing", "knowledge-base", "authentication",
]
# Active (pushed in the last month before the draw), not archived, not a fork, 500 to 25,000 stars,
# under about 1 GB (a practical limit for a cloud session, not a quality judgement).
# Added after the first screening pass (see the report): the owner must be a GitHub Organization, a mechanical
# stand-in for "a team or company ships this" (most individual-owned repositories had one or two people).
FILTER = "stars:500..25000 pushed:>=2026-10-01 archived:false fork:false size:<1000000"

# Repositories that must not be in this sample, so that it is a new measurement and not a repeat:
# (a) the 20 teams named on p.28 of the research PDF (as listed in docs/design/HARDY.md section 3.1),
# (b) the 8 repositories of the earlier 56-day audit (PROGRESS.md on the eloquent-hopper branch, DEVIATIONS.md Y13).
# Matched on the repository name (the part after the owner), so a guessed owner cannot let one through.
# "analytics" is only excluded for the owner plausible.
EXCLUDED_NAMES = {x.lower() for x in """
documenso formbricks unkey hatchet openstatus dub papermark excalidraw hoppscotch umami chatwoot novu
trigger.dev electric tldraw inngest langfuse twenty infisical
ruff biome trpc pydantic zed nomad firecracker thanos
""".split()}


def excluded(full_name):
    owner, _, name = full_name.lower().partition("/")
    return name in EXCLUDED_NAMES or full_name.lower() == "plausible/analytics"


def search(topic, page):
    q = "topic:%s %s" % (topic, FILTER)
    p = subprocess.run(
        ["gh", "api", "-X", "GET", "search/repositories", "-f", "q=" + q, "-f", "sort=stars", "-f", "order=desc",
         "-f", "per_page=100", "-f", "page=%d" % page],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if p.returncode != 0:
        raise RuntimeError("search failed for %s page %d: %s" % (topic, page, p.stderr.decode()[:300]))
    return json.loads(p.stdout)["items"]


def main(argv):
    pool = {}
    for topic in TOPICS:
        for page in (1, 2):
            for attempt in range(4):
                try:
                    items = search(topic, page)
                    break
                except RuntimeError as e:
                    sys.stderr.write("%s (retry)\n" % e)
                    time.sleep(20 * (attempt + 1))
            else:
                raise SystemExit("giving up on %s page %d" % (topic, page))
            for it in items:
                name = it["full_name"]
                if excluded(name) or it["owner"]["type"] != "Organization":
                    continue
                e = pool.setdefault(name, {
                    "name": name, "description": it.get("description") or "", "stars": it["stargazers_count"],
                    "sizeKB": it["size"], "defaultBranch": it["default_branch"], "pushedAt": it["pushed_at"],
                    "ownerType": it["owner"]["type"], "license": (it.get("license") or {}).get("spdx_id"), "topics": it.get("topics", []), "foundVia": [],
                })
                if topic not in e["foundVia"]:
                    e["foundVia"].append(topic)
            time.sleep(2.5)  # the search API allows 30 requests a minute
            if len(items) < 100:
                break
        sys.stderr.write("%s: pool now %d\n" % (topic, len(pool)))
    with open(argv[1], "w") as f:
        json.dump(sorted(pool.values(), key=lambda x: x["name"].lower()), f, indent=1)
        f.write("\n")
    print("pool: %d repositories" % len(pool))


if __name__ == "__main__":
    main(sys.argv)
