"""Step 2 of the selection: put the pool in a fixed pseudo-random order.

    python3 -I draw.py pool.json START COUNT

Order = SHA-256 of "SEED/owner/name". The seed was chosen before the pool was built and is never changed.
Prints name, stars, description and topics only: no team size, no history, nothing from any audit.
"""
import hashlib
import json
import sys

SEED = "aurora-collision-2026-11-01"


def ordered(pool):
    return sorted(pool, key=lambda r: hashlib.sha256((SEED + "/" + r["name"].lower()).encode()).hexdigest())


if __name__ == "__main__":
    pool = json.load(open(sys.argv[1]))
    start, count = int(sys.argv[2]), int(sys.argv[3])
    for i, r in enumerate(ordered(pool)[start:start + count], start):
        print("%3d %s [%d*] %s | %s" % (i, r["name"], r["stars"], (r["description"] or "")[:110], ",".join(r["topics"][:6])))
