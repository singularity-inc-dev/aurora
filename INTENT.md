# Aurora: product intent

This is what Aurora must do now. `DEVIATIONS.md` compares the code with it.
If this file and the code disagree, the code is wrong or this file must change on purpose.

## Product
- **Aurora** is a **team handover** for software teams of **2 to 10** people.
- Each person owns an area of one product and directs their own agent.

## The owner decides the work
- The **owner** decides what gets done. For each task they write a **handover note**:
  - **what to do**
  - **done when** (how the owner will know it is finished)
  - **limits** (for example: files it may touch, time, money, size of change)
- The owner hands over **now**, or **on a schedule** (for example: a meeting, lunch, the night).
- **Agent-proposed tasks are optional and off by default.** When turned on, a proposed
  task never runs without that owner's approval.

## Each owner's own agent
- Each owner has **their own agent**.
- The agent uses **only that owner's keys**.
- Each task runs on **its own branch** in **its own worktree**.

## The handback
- When the work comes back, each owner gets a **handback**: a short list of items that are
  **ready**, **blocked** or **failed**.
- Each item is checked:
  1. against **that owner's "done when"**;
  2. by **tests, lint, a diff-size limit and a secret scan**;
  3. against **teammates' branches from the same handover**: which files both changed,
     and whether they would conflict.

## Approve and Reject
- **Approve** merges **exactly once**, and **refuses if the branch changed** since the handback.
- **Reject** asks for a **one-line reason**.
- **Nothing merges, sends, deploys, deletes or spends without the owner's tap.**

## Between teammates
- Work passes between teammates **only through board tickets**.

## Out of scope now
- Hardy (contracts, rulings, settlement).
- Meeting agents.
- Model routing.
- A branded web app.

## Naming
- The product is **Aurora**.
- "Vision" and "Tom" are **only example agent names**, not product names.
