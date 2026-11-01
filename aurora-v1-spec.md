# Aurora v1: product and build specification

Oct 23, 2026 · @Rach

## Abstract

Aurora is an open-source platform where each person on a software team owns part of a shared product and directs their own master agent, which runs sub-agents to build that part. People decide while they're logged in. At a handover, on a schedule or whenever an owner starts it, agents build. The work comes back as a short, risk-sorted list of decisions, and approvals land in GitHub as each owner's own review. Hardy, a referee agent, guards the agreements between owners before, during and after every handover.

**Why now.** The best public agents finish tasks of about 12 hours half the time ([METR](https://metr.org/blog/2026-05-19-frontier-risk-report/)). But two agents sharing work succeed about 30% less often than one agent doing both ([CooperBench](https://arxiv.org/html/2601.13295v1)), and agent pull requests from different tools conflicted 41.7% of the time ([Xu et al.](https://arxiv.org/html/2607.04697v2)). No public product found so far combines per-person agents, contracts between owners, settlement by evidence and approvals routed to each owner.

**Who first.** Teams of 5 to 10 people who already use Claude Code, Codex or Cursor; they keep their agents and the context in their repository.

**Version 1.** Connect the agents a team already uses, plan handovers with locked checks and a scope gauge, run Hardy before and during each handover, and decide from an inbox whose approvals land in GitHub. It's built on Paperclip.

**Where it stands.** On 24 October, a first build exists but has run only against stand-ins, with no real agents, server or GitHub. The plan: ship a thin version 1 to two to four teams before the 2 November YC deadline and measure real handovers. My rating stays 6 out of 10: 7 if outside teams pass the pilot marks, 8 or more with a paying team and a technical cofounder.

## The problem

When several people's agents build one product at once, they collide, mostly at design time, and people become the review bottleneck.

| Finding | Number | Source |
| --- | --- | --- |
| Agent pull requests open at the same time as another agent's | 79.4% | [Xu et al., 2026](https://arxiv.org/html/2607.04697v2) |
| Conflict rate for pairs from different agent tools, against the same tool | 41.7% against 19.8% | [Xu et al., 2026](https://arxiv.org/html/2607.04697v2) |
| Success of two agents sharing work, against one agent doing both | About 30% lower, up to 50% for top models; 68.6% with 2 agents falls to 30.0% with 4 | [CooperBench](https://arxiv.org/html/2601.13295v1) |
| Why agent teams fail | Duplicated work 33%, incompatible designs 30%; caused by mismatched expectations (42%) and broken commitments (32%) | [CooperBench](https://arxiv.org/html/2601.13295v1) |
| Reliability by task length, best public models, early 2026 | 50% success at about 12 hours; 80% at about 1.5 hours | [METR](https://metr.org/blog/2026-05-19-frontier-risk-report/) |
| Review load | Review time up 91% on teams that use AI heavily; agent pull requests drew 16.5 comments against 12.4 | [Faros AI](https://www.faros.ai/blog/ai-software-engineering); [Microsoft](https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/) |
| Agent work accepted | 67.9% against 87.1% for Microsoft's engineers | [Microsoft](https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/) |
| Human approvals | 97% of Claude Code's permission prompts approved; 14% of dangerous commands caught | [The New Stack](https://thenewstack.io/claude-code-auto-mode/) |
| An earlier replay of 20 teams' git history (**unreproduced estimate**) | Same-day changes to the same file conflicted 33% of the time in teams of 2 to 10; teams of 7 to 10 would hit about 1.5 to 4 conflicts a week if each agent does three days of work per handover. The 20 teams were never recorded, so this cannot be reproduced; our corrected, measured run found 1 conflict in more than 100 clean replays (PROGRESS.md) | Earlier estimate (Sources) |

The replay uses people's history, not agents, so the pilot measures the real rate.

## What Aurora is

Aurora is one platform where each person owns an area of a shared product and directs their own master agent, while Hardy keeps the owners' agents from colliding.

- **Owners** are people who own an area, such as UI, backend, queries or model training. They decide, approve and set standing rules.
- **Master agents**, one per owner (Vision, Tom), plan with their owner and create, rewrite, repurpose and stop their own sub-agents.
- **Sub-agents** each do one work order in a sandbox.
- **Hardy** is the neutral referee. It holds contracts, claims and locked checks, watches every run, settles conflicts with evidence and sends each decision to the right owner. It never approves.
- **A handover** passes work from owners to agents, on a schedule or whenever an owner starts it.

&#91;embedded content: the handover loop · plan, build, decide, learn\]

Owners plan while they're logged in, a handover starts on a schedule or on demand, agents build while Hardy watches, and owners decide from the inbox. Each decision feeds the next plan.

## Decision register

Eleven decisions are yours and settled; seven are open and need your call. Ideas you dropped are left out of this document.

| # | Decision | Status | Note |
| --- | --- | --- | --- |
| 1 | Aurora is open source, from Singularity, in the singularity-inc-dev/aurora repository | Approved |  |
| 2 | Each owner has one master agent, such as Vision or Tom, that creates, rewrites, repurposes and stops its own sub-agents; the owner controls the master agent | Approved |  |
| 3 | Each owner owns an area of one product, such as UI, backend, queries or model training | Approved |  |
| 4 | People do design and decision work while logged in; agents build after a handover, scheduled or started any time | Approved |  |
| 5 | Hardy referees conflicts between agents and alerts owners and the admin | Approved | Channels for version 1 are item 16 |
| 6 | One platform, not one more tool, on the way to an AI OS | Approved | Version 1 is the handover loop |
| 7 | Built on Paperclip as a better, setup-free version of it | Approved | Setup-free is required but doesn't set Aurora apart: Hermes Cloud deploys in "two clicks", and Paperclip has a cloud waitlist |
| 8 | A caution symbol for work orders over 6 hours, with the line raised as results improve | Approved |  |
| 9 | A generated screen for every step and decision | Approved |  |
| 10 | Contracts between owners, a risk-sorted inbox, a decision log, a price before each handover, one cockpit inside other apps, handover yield as the main measure, and design and training as first-class work | Approved |  |
| 11 | Approve in Aurora; the approval lands in GitHub as the owner's own review | Approved |  |
| 12 | Business model | Open | Anthropic's terms forbid reselling Claude Code usage; see Risks |
| 13 | How to build on Paperclip | Open | Recommended: plugins plus small upstream changes, not a separate copy |
| 14 | Licence for Aurora's code | Open | Paperclip itself is MIT; the repo already carries an MIT LICENSE file, so confirm or change it |
| 15 | How the low-risk tier is approved | Open | Recommended: one tap approves the batch; never an approval posted without the owner |
| 16 | Messaging channels in version 1 | Open | Recommended: in-app, email, Slack and phone first; WhatsApp and iMessage next |
| 17 | Hosting for version 1 | Open | Recommended: one hosted instance per team, plus self-hosting |
| 18 | First pilot team and feature | Open | Recruit from people you already know who use these tools |

## Version 1 scope

Version 1 is the handover loop for one team on GitHub, with Hardy before and during each handover and the decision inbox; the rest waits for pilot evidence.

| Area | Version 1 | Later |
| --- | --- | --- |
| Agents | The agents a team already uses (Claude Code, Codex, Cursor and others Paperclip supports); one master agent per owner | Agents that join meetings and brainstorm with their owner |
| Planning | Outcome cards, contracts, work orders with locked checks, the scope and cost gauge | Agents that propose changes to the team's structure |
| Handover | Scheduled or started any time | Multi-day programmes of work |
| Hardy | Prevent (contracts, claims, pre-handover check), watch (contract guard, scope, budget), settle textual conflicts and route them to owners | Settling conflicts in meaning with distinguishing tests and a judge from another model family; standing rules from repeated rulings |
| Decisions | Risk-sorted inbox, generated screens, approvals that land in GitHub, a decision log | Approvals for GitLab and other code hosts |
| Channels | Aurora's app and its screens inside Claude, ChatGPT, VS Code and Goose; email, Slack and phone notifications | WhatsApp, which needs approved templates outside its 24-hour window; iMessage, which is plain text only through Photon |
| Kinds of work | Code, UI with Figma designs, queries and data, model training with score checks | Work that has no check a machine can run |
| Hosting | A setup-free hosted instance for each team, plus self-hosting | A shared multi-team cloud |

WhatsApp's and iMessage's limits are from [Vonage](https://developer.vonage.com/en/messages/whatsapp-provisioning/overview) and [Photon](https://chat-sdk.dev/adapters/vendor-official/photon). Apple Messages for Business is out entirely, because "only customers can start conversations with your business" ([Zendesk](https://www.zendesk.com/service/messaging/apple-messages-for-business/)).

## How a handover works

A handover turns today's decisions into small work orders, each with a check that proves it's done, and runs them only after Hardy has cleared the plan.

1. **Capture.** The owner tells their master agent what they want, in chat or from meeting notes. The agent writes an outcome card: goal, why, done-when, deadline, budget.
2. **Contracts.** Where the outcome crosses owners' areas, the agent drafts what passes between them: request shapes, data formats, design rules, model inputs and outputs. Each owner approves their part.
3. **Work orders.** The agent splits the outcome into pieces of one to two hours of agent work. Each gets a locked check, the files and contracts it claims, and its dependencies.
4. **Gauge.** Each work order shows its size and estimated cost (below).
5. **Pre-handover check.** Hardy compares every owner's claims, fixes the order, and asks each owner at most three questions.
6. **Handover.** On a schedule or when the owner taps Hand over now. Nothing runs that its owner hasn't approved.
7. **Run.** Master agents dispatch sub-agents in sandboxes while Hardy watches.
8. **Handback.** Results land in each owner's decision inbox, sorted by risk.

### Work orders and their checks

| Kind of work | Example work order | Locked check | The owner's screen |
| --- | --- | --- | --- |
| Backend | Build the search request exactly as agreed in contract v1 | Contract tests pass; answers in under 300 ms on test data; old tests still pass | The agreed request beside what was built, with test results |
| UI | Build the search bar to match the Figma design | Screenshot matches the design; accessibility checks pass; works against a mock of the agreed request | Before and after screenshots over the Figma frame |
| Queries and data | Add an index and the filter query | Under 50 ms on a million rows; the database change can be undone | Speed chart and query plan |
| Model training | Fine-tune the ranking model | Beats the current model on held-out data by the agreed margin; stays within its GPU budget; writes a report | Score chart against the current model, with cost |

The 300 ms, 50 ms and margin are placeholders each contract sets. [Figma's connector](https://www.figma.com/blog/design-context-everywhere-you-build/) gives agents the design and its linked code components. Training fits when the check is a score: the best agents on [MLE-bench](https://www.developersdigest.tech/benchmarks/mle-bench) earn a medal in about 64% of its 75 Kaggle competitions in 24-hour runs.

### Scope and cost gauge

| Gauge | Size of one work order (hours a skilled person would take) | Chance of success with today's best public models (my estimate) | What Aurora does |
| --- | --- | --- | --- |
| Green | Up to 2 hours | About 77% or better | Runs |
| Amber | 2 to 6 hours | About 61% to 77% | Suggests a split; runs if the owner keeps it |
| Red, with a caution symbol | Over 6 hours | Under 61% | The owner must confirm or split it |

The chances are fitted to METR's two published points for early 2026: 50% at about 12 hours and 80% at about 1.5 hours ([METR](https://metr.org/blog/2026-05-19-frontier-risk-report/)). METR counts the time a skilled person takes, not how long the agent runs. The gauge applies to each work order; the whole handover shows its total hours and cost.

The caution symbol also shows when the estimated cost is above the owner's limit for one handover, when the handover would exceed the team's share of its monthly budget, or when a work order uses maximum effort, which Anthropic describes as "no constraints on token spending" ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/effort)).

The red line moves from 6 hours to 7 or 8 when a team's own results earn it, for example a month of amber work orders at the team's handover-yield target. METR found the length of task agents can finish doubled about every seven months from 2019 to 2025 ([METR](https://arxiv.org/html/2503.14499v1)).

## Roles and authority

Only people approve, and every agent acts for exactly one owner.

| Role | Can | Can't |
| --- | --- | --- |
| Owner (a person, logged in) | Own one area. Approve its contracts, handovers and results. Set standing rules. Command, change or stop their own master agent. | Change another owner's contract, or approve inside another owner's area |
| Master agent (Vision, Tom) | Plan with its owner. Draft outcome cards, contracts and work orders. Create, rewrite, repurpose and stop its own sub-agents within budget. | Approve anything for its owner. Command another owner's agents. |
| Sub-agent | Do one work order in a sandbox | Edit a locked check. Touch files or contracts its work order didn't claim. |
| Hardy | Hold contracts, claims and locked checks. Watch runs, settle conflicts with evidence, route each decision to the right owner. | Approve, merge, or decide product questions |
| Admin | Set team budgets, gauge thresholds and policy. Stop every agent in an emergency. | Overrule an owner inside their area |

Two of these rules already exist elsewhere. In Claude Code a teammate "can't approve a permission prompt or supply consent on your behalf" ([Claude Code docs](https://code.claude.com/docs/en/agent-teams)). GitHub shows Copilot's approvals but doesn't count them toward merging ([GitHub](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews)).

In Paperclip, each master agent is set to protected assignment, and its owner gets assignment and configuration rights scoped to that agent and the agents under it. Paperclip gives owners, admins and operators company-wide rights by default, so Aurora narrows them; how far that works without changing Paperclip's code is tested in milestone M1 (see Built on Paperclip).

## Hardy

Hardy guards the agreements between owners before work starts, then watches, settles and learns; it never approves or merges.

| Job | When | What Hardy does | What it keeps | In version 1 |
| --- | --- | --- | --- | --- |
| Prevent | Before a handover | Proposes contracts where areas meet. Checks every work order's claims for overlaps and order. Asks each owner at most three questions. | Contracts with versions and owners; claims | Yes |
| Watch | While agents work | Pauses any change to a contract and asks its owner. Keeps each sub-agent inside its claimed files and budget. Runs the locked checks in its own sandbox. | Run log | Yes |
| Settle | At handback | Replays branches together to find textual conflicts and sends them to the owners with an evidence card. Later: distinguishing tests for conflicts in meaning, judged by a model from a different family than the agents. | Evidence packs and decisions | Textual conflicts |
| Learn | After each decision | Saves each decision and its reason. After the same ruling three times, offers it as a standing rule. Agents read the log before they plan. | Decision log; standing rules | The log; rules later |

Why each rule is there:

- **Upstream first.** Most failures in agent teams are duplicated work and incompatible designs ([CooperBench](https://arxiv.org/html/2601.13295v1)). Loosely connected teams build software where a change spreads to up to eight times fewer files ([MacCormack, Baldwin and Rusnak](https://dash.harvard.edu/bitstream/handle/1/34403525/maccormack,baldwin,rusnak_exploring-the-duality.pdf)).
- **Checks run in Hardy's sandbox.** On tasks over 8 hours, at least 16% of runs that looked successful were cheating ([METR](https://metr.org/blog/2026-05-19-frontier-risk-report/)).
- **Agent-written text never steers Hardy.** A design that keeps untrusted data from changing an agent's actions solved 77% of AgentDojo tasks with provable security, against 84% undefended ([CaMeL](https://arxiv.org/abs/2503.18813)).
- **A judge from another model family.** AI judges rate their own model's output higher ([NeurIPS 2024](https://papers.nips.cc/paper_files/paper/2024/hash/7f1f0218e45f5414c79c0679633e47bc-Abstract-Conference.html)).
- **Evidence cards show both sides.** In a debate study, two advocates lifted non-expert accuracy to 88% for human judges and 76% for AI judges, from 60% and 48% ([Khan et al.](https://arxiv.org/html/2402.06782v4)).

## Decisions and approvals

Each owner sees only the decisions that need them, each on a screen made for it, and every approval is the owner's own action, recorded in GitHub.

### The decision inbox

| Tier | What lands there | What the owner does |
| --- | --- | --- |
| Needs you | Requests to change a contract, failed checks, Hardy's rulings in your area, red-gauge work | Decides, with the evidence on the same screen |
| Review suggested | Amber work, new kinds of change, anything your standing rules don't cover | Looks and approves, or sends it back |
| Passed under your rules | Green work whose checks passed and that your standing rules cover | Approves the whole batch with one tap, the recommended default (decision 15); nothing is approved without that tap |

Few, important decisions work better than many: people approve 97% of Claude Code's permission prompts, and in Anthropic's tests they caught 14% of dangerous commands, against 89% for an automatic checker ([The New Stack](https://thenewstack.io/claude-code-auto-mode/)). Success also varies by kind of work, from 85% for cleanup to 55% for performance work in Microsoft's .NET repository ([Microsoft](https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/)), so standing rules start with the safest kinds.

### Generated screens

Every step gets a screen generated for it: the outcome card, the contract side by side, the gauge, and each inbox item. This is the idea behind ChatGPT's Intelligent UI, which launched with GPT-6 on 7 October 2026 ([Search Engine Journal](https://www.searchenginejournal.com/chatgpt-gpt-6-intelligent-ui/592249/)); I found no sign developers can use ChatGPT's version, so Aurora generates its own. Google found people preferred generated screens to plain text and rated them a close second to websites built by experts ([Google Research](https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/)). Through MCP Apps the same screens open inside Claude, ChatGPT, VS Code and Goose ([MCP blog](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)).

### Approvals that land in GitHub

1. Agents open pull requests under a dedicated agent account, never an owner's. Paperclip already has this setting: "This agent uses this GitHub account for everyone's work, instead of the person giving instructions" ([Paperclip](https://github.com/paperclipai/paperclip/blob/main/doc/execution-github-identity.md)).
2. Each owner connects GitHub once, letting Aurora's GitHub App act for them.
3. When an owner taps Approve, Aurora calls GitHub's review API with the owner's token and the event APPROVE ([GitHub](https://docs.github.com/en/rest/pulls/reviews)). GitHub attributes the request to the owner, shown with the app's badge ([GitHub](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)).
4. Branch protection counts approvals from people with write access or from the code owner ([GitHub](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)), so a change that touches another owner's area goes to their inbox.
5. The merge goes through the team's merge queue. Design and training work publish instead: the design, the model or the report.

Step 1 matters because "Pull request authors cannot approve their own pull requests" ([GitHub](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews)). GitHub's docs don't say outright that a review an app posts for a person counts toward required approvals, so the pilot tests it on a protected repository. Teams that want a second person on every change can route each approval to another owner.

## Bringing in teams already on Codex, Cursor and Claude Code

Teams keep their agents, accounts and repository context: Aurora runs the agents they already use and reads their context where it already lives.

### What comes with them

| What they have today | How it comes into Aurora | Source |
| --- | --- | --- |
| Their agents: Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Pi, Hermes and others | Run through Paperclip's built-in adapters, so nobody switches tools | [Paperclip roadmap](https://github.com/paperclipai/paperclip/blob/main/ROADMAP.md) |
| Project instructions in AGENTS.md | Read in place; Claude Code and Cursor both read AGENTS.md, and OpenAI contributed the format to the Agentic AI Foundation | [Claude Code docs](https://code.claude.com/docs/en/memory?r=0); [Cursor docs](https://cursor.com/docs/context/rules); [Constellation](https://www.constellationr.com/insights/news/agentic-ai-foundation-launches-mcp-other-ai-agent-standards) |
| CLAUDE.md, .claude/rules and .cursor/rules | Left in place for the agent that reads them | [Claude Code docs](https://code.claude.com/docs/en/memory?r=0); [Cursor docs](https://cursor.com/docs/context/rules) |
| Skills (SKILL.md) | Agent Skills is an open format used by Cursor, GitHub, VS Code, OpenCode, goose and Codex | [Simon Willison](https://simonwillison.net/2025/Dec/19/agent-skills) |
| MCP servers | MCP is a shared standard, now held by the Linux Foundation's Agentic AI Foundation | [Constellation](https://www.constellationr.com/insights/news/agentic-ai-foundation-launches-mcp-other-ai-agent-standards) |
| Code owners, issues and pull requests | Read through Aurora's GitHub App; the code owners become Aurora's owner areas | [GitHub](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) |
| Chat history inside each tool | Stays there; at onboarding each owner's agent can summarise open decisions into the decision log |  |

### Model access stays theirs

- **Claude.** Each person signs in to the unmodified Claude Code program with their own subscription, or uses their own API key. Anthropic allows platforms to host Claude Code this way, but forbids them to "pay for, resell, or intermediate Claude usage" on users' behalf or to "collect, store, or intermediate Claude.ai credentials" ([Anthropic](https://code.claude.com/docs/en/legal-and-compliance)).
- **ChatGPT.** Since 29 September 2026, Plus and Pro subscribers can use their plan inside participating tools through Sign in with ChatGPT; launch partners include Hermes Agent, Pi, OpenClaw and Devin ([The New Stack](https://thenewstack.io/sign-in-with-chatgpt/)). Aurora applies to join.
- **Cursor and the rest.** They run through Paperclip's adapters with the access each person already has.

### How a team comes in

1. **Collision audit.** A read-only replay of the team's last 90 days of git history shows how often their parallel work collided. Nothing is installed.
2. **Shadow mode, two weeks.** Hardy watches the team's normal agent work and reports what it would have caught, changing nothing.
3. **One feature through the handover loop.**
4. **The whole team, one area at a time.**

This order lets a team see its own numbers before trusting Hardy. And 70% of engineers already use two to four AI tools ([Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/ai-tooling-2026)), so Aurora adds coordination without asking anyone to drop a tool.

## Customers

The first customers are teams of 5 to 10 people who each run their own agents on one shared product, starting with teams of 7 to 10. Solo builders aren't the first customers.

| Team | What Aurora gives them | Fit |
| --- | --- | --- |
| Solo builder | Handover planner, gauge and decision inbox; no Hardy, because there are no other owners | Entry tier only. Claude Code, Codex, Cursor's cloud agents and GitHub's scheduled agent runs already cover much of this. |
| 2 to 3 people | Contracts, claims and Hardy | Insurance: about one conflict a month in our replay |
| 5 to 6 people | The same | Depends on the team: a median of about one conflict every two weeks, one team in five far more |
| 7 to 10 people | The same | First customers: about 1.5 to 4 conflicts a week (unreproduced estimate) |
| 11 or more | The same, plus admin and policy features | Later: pairs conflict less often (24% against 33%, unreproduced estimate), but there are more owners to coordinate |

The replay numbers come from people's git history and assume each person's agent does about three days of their work per handover. A team doesn't need to mix agent tools: pairs from different tools conflict more, but they were only 0.5% of the pairs of agent pull requests open at the same time, December 2024 to July 2025 ([Xu et al.](https://arxiv.org/html/2607.04697v2)).

Any work fits that has an owner, splits into one-to-two-hour pieces, and has a check a machine can run: UI, backend, queries, model training, infrastructure, data pipelines, mobile apps and tests. The further from code, the weaker the checks, so version 1 starts with software and training.

Small companies lead this market. In a 906-person survey, 75% of respondents at the smallest companies use Claude Code ([Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/ai-tooling-2026)), and startup work was 33% of Claude Code conversations in April 2025, against 24% for enterprise work ([Anthropic](https://anthropic.com/research/impact-software-development)). Solo founders start 36% of new startups ([Carta](https://carta.com/data/solo-founders-report)); they become customers when they hire.

## Competition

Many products build parts of this; none found combines an agent per owner, contracts between owners, settlement by evidence and approvals routed to each owner. GitHub is the biggest threat.

| Who | What they do today | What's missing for Aurora's job |
| --- | --- | --- |
| [GitHub Agent HQ](https://thenewstack.io/github-agent-hq/), [Agentic Workflows](https://github.blog/2026-02-13-automate-repository-tasks-with-github-agentic-workflows/), [Copilot code review](https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/) | Hands issues to Copilot, Claude and Codex, which work in the background; runs agents on a schedule; reviews more than one in five pull requests on GitHub; [one-click conflict fixes](https://github.blog/news-insights/company-news/welcome-home-agents/) | No agent per owner or contracts between owners; conflicts are fixed after the code exists; GitHub only |
| [GitLab Duo Agent Platform](https://about.gitlab.com/press/releases/2026-01-15-gitlab-announces-duo-agent-platform-general-availability/) | A planner agent, chained agent flows, Claude Code and Codex inside GitLab | The same gaps, GitLab only |
| [Agents in Jira](https://www.devopsdigest.com/node/14558) | Assigns Jira work items to Claude Code, Cursor or Copilot (Codex coming) and shows every agent session and what waits for review; [generally available](https://community.atlassian.com/forums/Jira-articles/Introducing-Agents-in-Jira/bc-p/3221206) on Jira Cloud Standard, Premium and Enterprise | Tracks and assigns; no contracts between owners or conflict checks described |
| [Paperclip](https://github.com/paperclipai/paperclip) | Org charts of agents, several human users, routines, budgets, approvals, task checkout, agents hiring agents | Owner areas, contracts and settlement in code; it's Aurora's base |
| [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) | A lead session and teammates with a shared task list and locked task claims (experimental) | One person's session; "Two teammates editing the same file leads to overwrites" |
| [Claude Tag](https://venturebeat.com/technology/anthropic-launches-claude-tag-replacing-its-slack-app-with-a-persistent-ai-teammate-that-learns-monitors-and-works-autonomously) | One shared Claude per Slack channel that works for hours or days | One shared agent rather than an agent per person; no contracts |
| [OpenAI Frontier](https://openai.com/index/next-phase-of-enterprise-ai/) | A platform for building, deploying and governing a company's agents | No public detail on contracts between owners or conflict settlement |
| [OpenAI Codex with Ona](https://www.cio.com/article/4184655/openai-buys-ona-to-help-rein-in-ai-agents-2.html) | OpenAI bought Ona (formerly Gitpod) in June 2026 to run Codex in secure, persistent environments beyond one device or session; Codex has more than 4 million weekly users ([OpenAI](https://openai.com/index/scaling-codex-to-enterprises-worldwide)) | Persistent agent environments, not coordination between owners |
| [Microsoft Agent 365](https://learn.microsoft.com/en-ca/microsoft-agent-365/overview) | A registry, identity and governance for agents, generally available since 1 May 2026 | Governs agents; doesn't coordinate their build work |
| [Cursor](https://cursor.com/help/ai-features/background-agents) | Cloud agents started from its app, the web, a phone or Slack; bought [Graphite](https://siliconangle.com/2025/12/19/cursor-acquires-ai-code-review-startup-graphite/) for code review | Built around each developer; review, not coordination between owners |
| [Band for Developers](https://www.prnewswire.com/il/news-releases/band-launches-band-for-developers-to-support-the-transformation-of-sdlc-collaboration-and-control-of-multiple-coding-agents-302909844.html) | A desktop app and CLI, launched 15 October 2026, showing a developer's agents, blockers and progress, with agents sharing context and handing off tasks; backed by Team8, Hetz and Sierra ([SiliconANGLE](https://siliconangle.com/2026/10/16/band-launches-desktop-app-for-developer-collaboration-and-control-of-multiple-ai-coding-agents/)) | Coordination across several people's agents isn't described; no conflict settlement or approvals described |
| [Augment Intent](https://www.augmentcode.com/blog/intent-a-workspace-for-agent-orchestration) | A coordinator agent writes a living spec, implementor agents build in isolated worktrees and a verifier checks; works with Claude Code, Codex and OpenCode (public beta, macOS) | One person's workspace; use by several people isn't described |
| [Pawsly by Jindo AI](https://hackernoon.com/four-ai-coding-agents-one-codebase-and-a-coordination-problem) | Shared decisions and a plan with owners, checks before agents act, overlap flags, handoffs; seeking design partners | No agent per person or routing to owners described; its benchmarks are internal and small |
| [Nerveplane](https://arxiv.org/pdf/2610.07261) | Open-source research system that gives each agent a separate scope and merge slot before edits, with a decision ledger | Routes events to agents, not to people |

Aurora's difference is the combination, not any single feature. GitHub can ship the missing parts fastest to 180 million developers ([GitHub](https://github.blog/news-insights/company-news/welcome-home-agents/)), which is why the build plan carries a stop rule.

## Built on Paperclip

Paperclip gives Aurora most of its engine; Aurora adds owners, contracts, handovers and Hardy. Checked against Paperclip's code as of its 22 October 2026 commit.

### What Aurora reuses

Tasks with atomic checkout ("A single assignee and execution locks prevent competing runs from claiming the same task"), scheduled routines, budgets with hard stops, review and approval stages, plan approvals, an activity log, adapters for most agent tools, several human users, and since 5 October a governed way for agents to hire teammates ([README](https://github.com/paperclipai/paperclip), [roadmap](https://github.com/paperclipai/paperclip/blob/main/ROADMAP.md), [release notes](https://github.com/paperclipai/paperclip/blob/main/releases/v2026.1005.0.md)).

### How ownership works in Paperclip today

1. The org chart is a tree of agents: an agent's `reports_to` can only point to another agent ([schema](https://github.com/paperclipai/paperclip/blob/main/packages/db/src/schema/agents.ts)). People aren't in that tree.
2. People belong to the company with a role: owner, admin, operator or viewer ([constants](https://github.com/paperclipai/paperclip/blob/main/packages/shared/src/constants.ts)). They can join an agent as members and choose which agents may message them.
3. By default, owners, admins and operators can assign work to and configure any agent ([role defaults](https://github.com/paperclipai/paperclip/blob/main/server/src/services/company-member-roles.ts)). On a fresh install, Tom's owner could direct Vision.
4. Paperclip already has the pieces to fix this. An agent can be marked protected, which "requires an explicit assignment grant", or private. A grant can be limited to one agent or to the agents under it ([authorization](https://github.com/paperclipai/paperclip/blob/main/server/src/services/authorization.ts)).
5. Aurora's setup: Vision is protected, Rach gets assignment and configuration grants scoped to Vision and the agents under it, and operators' company-wide grants are narrowed. Milestone M1 tests whether settings alone can narrow those defaults; if not, it's a small change proposed upstream.

### What Aurora adds

| Need | Paperclip today | What Aurora does | Where it lives |
| --- | --- | --- | --- |
| An owner for every master agent | The pieces above, not a single owner field | Sets up protected agents and scoped grants for every owner | Settings, or an upstream change |
| Conflicts between different tasks in the same code or contract | Checkout stops two runs claiming one task; nothing for code-level conflicts in its README, roadmap or release notes | Hardy's contracts, claims and settlement | A plugin plus Aurora's service |
| Pull requests owners can approve | Uses the instructing person's GitHub account by default; a dedicated-agent account setting exists | Turns on the dedicated-agent account | Settings |
| Approvals in Aurora that land in GitHub | Not part of Paperclip | Posts each owner's review through a GitHub App | Aurora's service |
| Daytime capture | Agent Chat is experimental and "off by default" | Turns conversation into outcome cards | A plugin |
| Decision log | Memory is partial and experimental | Records each decision and its reason | A plugin |
| A price before the handover | Stops use recorded spend, so "usage reporting and in-flight work can delay a stop" | Estimates cost first and shows the caution symbol | A plugin |
| Hosting | The quickstart defaults to a trusted local mode; the cloud is partly built | A hosted instance per team, secure by default | Aurora's service |

### Limits Aurora works within

- Paperclip's plugins may not change "approval, auth, issue checkout, or budget enforcement logic" or run their own database migrations ([plugin spec](https://github.com/paperclipai/paperclip/blob/main/doc/plugins/PLUGIN_SPEC.md)). So ownership and approval rules live in Paperclip's settings, in upstream changes, or in Aurora's own service in front of Paperclip.
- The plugin runtime today is single-tenant and self-hosted, and dynamic plugin installs are "not yet cloud-ready" for scaled deployments ([plugin spec](https://github.com/paperclipai/paperclip/blob/main/doc/plugins/PLUGIN_SPEC.md)). Hence one hosted instance per team in version 1.
- Paperclip moves fast: 28 releases between 18 March and 12 October 2026. For core features its roadmap asks contributors to "coordinate with us first in Discord" ([roadmap](https://github.com/paperclipai/paperclip/blob/main/ROADMAP.md)). Recheck this section every month.

## Build plan and gates

Ship a thin version 1 now to two to four teams you know, reusing the code on the working branch. Their real handovers replace the manual pilot (M0); the pass marks below still decide what comes next.

| Milestone | What ships | Status on 24 October | Gate before the next one |
| --- | --- | --- | --- |
| M0 Pilot on real teams | A collision audit of each team's repository, then real handovers measured against the pass marks | Not started; replaces the manual pilot | The pass marks below |
| M1 Handover planner | Connect existing agents; owner setup (protected agents, scoped grants, the dedicated agent account); outcome cards, work orders with locked checks, the gauge, scheduled and on-demand handovers | Partly built: one agent per person, a nightly schedule, an evening plan with one-tap approval, a checks gate, a worktree per task, budget caps. Missing: real agents connected, handover any time, the gauge, master agents with sub-agents, the dedicated agent account | Owners run a handover without you |
| M2 Hardy prevent | Contracts, claims and the pre-handover check | Not built | Overlaps caught before handovers in pilot teams |
| M3 Decision inbox and GitHub approvals | Risk tiers, generated screens (also through MCP Apps), approvals posted as each owner | Partly built: a morning email with signed Approve and Reject links; Approve opens and squash-merges a pull request under branch protection. Missing: tiers, screens, and approval as each owner's own review (one person's token pushes and merges today) | An Aurora approval counts under branch protection on a test repository |
| M4 Hardy watch and settle | Contract guard, locked checks in Hardy's sandbox, textual-conflict replay, evidence cards | Not built; Approve already refuses a branch that doesn't merge cleanly | Handover yield at or above target |
| M5 Decision log and standing rules | The log is in version 1; standing rules after a third matching ruling | Event log built; standing rules not built |  |
| Hosting | One instance per team (decision 17) | Server kit, invite links, backups and restore built and rehearsed; never run on a real server |  |

Since 24 October the repo's CLAUDE.md uses this table's milestone names; its "Built so far" section maps the older night-only plan (M1 to M6) onto them.

### Thin version 1 for the pilot

Six pieces, in build order. The first two make anything real run; the third and fourth make it Aurora rather than a nightly job.

1. Real agents: each owner's agent signs in with that owner's own Claude account or API key, kept apart from other agents and from Paperclip's own data.
2. Handover any time: "Hand over now", next to the existing schedule.
3. Claims: each work order lists the folders and files it may change, and Hardy checks them across owners before the handover.
4. Merge replay: when work comes back, every ready branch is test-merged against the others with `git merge-tree`, and conflicts go to both owners.
5. The handback email with Approve and Reject, which already exists.
6. Numbers from the event log: handover yield, minutes to approve, decisions per owner and overlaps caught.

### The manual pilot

Replaced on 24 October by the pilot on real teams (M0 above). The collision audit, the measurement sheet and the stop rules below still apply.

It follows Paul Graham's advice that "some startups could be entirely manual at first" ([essay](https://www.paulgraham.com/ds.htm)). This is a Wizard-of-Oz test, an idea Nigel Cross described in 1977 as filling "the black box with people as with machinery" ([source](https://www.kmjn.org/snippets/cross77_wizardofoz.html)).

The step-by-step version, with the script for each handover, the measurement sheet and a message to recruit a team, is in the Pilot playbook tab.

1. **Week 0.** Run the collision audit on each pilot team's repository.
2. **Weeks 1 and 2.** Take one real feature through four to six handovers by hand, with two or three owners and you playing Hardy.
3. **Weeks 3 and 4.** Shadow mode on the team's normal work.
4. **End of week 4.** Decide, against the pass marks.

Set up before week 1:

- [ ] Pick a feature that crosses at least two owners' areas and splits into 6 to 12 work orders.
- [ ] Each owner keeps the agent they already use.
- [ ] Turn on branch protection and add a CODEOWNERS file naming each owner's area.
- [ ] Make a protected test repository for checking that an Aurora approval counts.
- [ ] Open one shared doc with the templates below, and one group chat.
- [ ] Agree a spending limit per handover and per person.

Each handover by hand: capture (15 minutes), contracts (10), work orders with checks and gauge colours (20), pre-handover check (10), handover, one check on each run while it works, handback into a three-tier inbox, decisions timed, and a log of every decision and every judgment you made as Hardy. The times are suggestions; record the real ones.

```markdown
**Outcome card**
Goal:
Why it matters:
Done when:
Owners involved:
Deadline:            Budget:

**Contract** (one per place where areas meet)
Name and version:
Owner:               Used by:
What passes between areas:
Test that proves it:
Changes need approval from:

**Work order**
Owner and agent:
Goal (one to two hours of work):
Contracts used:
Files and areas claimed:
Locked check:
Gauge: green / amber / red      Estimated hours:      Estimated cost:
Depends on:

**Inbox item**
Tier: needs you / review suggested / passed under your rules
What changed:
Check result:
Hardy's note and evidence:
Decision and reason:
```

| Pass mark (my suggestion) | Target |
| --- | --- |
| Handover yield | At least half in week 1, higher in week 2 |
| Minutes to approve | 15 or fewer per owner per handback |
| Decisions per owner | 5 or fewer per handback |
| Overlaps or conflicts caught | At least one a week |
| Owners who want to continue | At least two of three |

### Stop or rethink if

- Pilot teams hit fewer than one overlap or conflict a week.
- GitHub ships plan checks whose rulings go to code owners.
- An Aurora approval can't be made to count in GitHub; then approvals stay in GitHub, with Aurora linking to them.

## Measures

Handover yield is the main number; it's my suggestion, not taken from research. Targets start at the pilot's pass marks and are reset from each team's own results.

| Measure | What it is | Why it matters |
| --- | --- | --- |
| Handover yield | Share of handed-over work orders that pass their checks and are approved without edits | Shows whether handovers work |
| Minutes to approve | Time each owner spends in the inbox per handback | Review is the bottleneck: review time rose 91% on teams that use AI heavily ([Faros AI](https://www.faros.ai/blog/ai-software-engineering)) |
| Decisions per owner | Items in "Needs you" per handback | Keeps decisions few |
| Conflicts prevented and settled | Caught before a handover, against caught after | Shows Hardy working upstream |
| Estimate accuracy | Gauge hours and cost against what happened | Tunes the gauge thresholds |
| Cost per approved work order | Spend divided by approved work orders | Sets prices and budgets |

## Risks

The biggest risks are GitHub moving first, Paperclip moving into the same space, and model providers' terms shaping the business model.

| Risk | Evidence | Response |
| --- | --- | --- |
| GitHub ships the missing parts | Agent HQ, scheduled agent runs, and Copilot reviewing more than one in five pull requests; GitHub Universe runs 28 to 29 October 2026 ([GitHub](https://github.blog/news-insights/company-news/your-guide-to-github-universe-2026-is-here-the-schedule-just-launched/)) | The stop rule; work across agent tools now and other code hosts later; read Universe's announcements before submitting to YC |
| Paperclip builds into the same space | Several human users, agents hiring teammates since 5 October, and design notes for chat channels and a GitHub review bot ([plans](https://github.com/paperclipai/paperclip/tree/main/doc/plans)) | Build on it, contribute upstream, and focus on owners, contracts and handovers |
| Model providers' terms | Anthropic forbids platforms to resell Claude Code usage or handle Claude.ai credentials, and products that run Claude Code need its Commercial Terms ([Anthropic](https://code.claude.com/docs/en/legal-and-compliance)) | Users bring their own accounts; Aurora charges for the platform (decision 12). Usage pricing is possible only for agents Aurora runs on its own API account |
| Thin margins on resold model usage | Margins on code-generation products are "either neutral or negative", per sources quoted by [TechCrunch](https://techcrunch.com/2025/08/07/the-high-costs-and-thin-margins-threatening-ai-coding-startups/) | Don't build the business on credits alone |
| Teams won't let agents run unattended | 63% rarely or never let agents run entirely on autopilot, and 60% block unapproved system changes ([Stack Overflow](https://stackoverflow.blog/2026/05/27/agents-on-a-leash-agentic-ai-remains-mostly-monitored-at-work)) | Nothing merges without its owner; small work orders; start each team on low-risk work |
| Subscription limits during long handovers | Pro and Max limits "assume ordinary, individual usage" ([Anthropic](https://code.claude.com/docs/en/legal-and-compliance)) | Show expected usage in the gauge; suggest API keys for heavy handovers |
| Rubber-stamp approvals | 97% of prompts approved; 14% of dangerous commands caught ([The New Stack](https://thenewstack.io/claude-code-auto-mode/)) | Risk tiers and few decisions |
| Agents cheating on long tasks | At least 16% of apparently successful runs over 8 hours ([METR](https://metr.org/blog/2026-05-19-frontier-risk-report/)) | Small work orders; checks locked in Hardy's sandbox |
| Instructions hidden in agent-written text | CaMeL's design kept 77% of tasks solvable with provable security ([CaMeL](https://arxiv.org/abs/2503.18813)) | Hardy treats agent text as data, never as instructions |
| Security of agent-built code | Flaws in 45% of AI-generated code tests ([Veracode](https://www.veracode.com/press-release/ai-generated-code-poses-major-security-risks-in-nearly-half-of-all-development-tasks-veracode-research-reveals/)); a vibe-coded app exposed 1.5 million API tokens ([Wiz](https://wiz.io/blog/exposed-moltbook-database-reveals-millions-of-api-keys)) | An outside security review before any team connects a repository; a GitHub App with the fewest permissions it needs |
| Conflicts rarer than estimated | The replay used people's history, not agents; agent studies point the other way: 27.67% of agent pull requests conflict with their base branch ([AgenticFlict](https://arxiv.org/abs/2604.03551)) | The pilot's pass marks and the stop rule |
| A solo founder building tools for engineers | YC: "It's important for the founding team to have the skills to build their product themselves" ([YC](https://ycombinator.com/faq)) | A technical cofounder or senior advisor before M2 |
| Channel limits | WhatsApp needs templates outside 24 hours; iMessage through Photon is plain text | Aurora's app, email, Slack and phone first |
| Paperclip's plugin limits | Plugins can't change approval, auth, checkout or budget logic; the runtime is single-tenant | An instance per team; settings or upstream changes |

## What's not addressed yet

Twenty-seven gaps remain on 24 October: nine to settle this week, seven to build during the pilot, and eleven that can wait for version 2. "This week" means before any outside team connects a repository, or before the YC application on 2 November.

| # | Gap | Why it matters | When |
| --- | --- | --- | --- |
| 1 | Keep agents away from Paperclip's own data | Agents run as Paperclip's system user and could read its secrets, including the key that signs Approve links ([PROGRESS.md](https://github.com/singularity-inc-dev/aurora/blob/claude/eloquent-hopper-9m2e04/PROGRESS.md)) | This week |
| 2 | Each owner's agent on that owner's own model account | Deploy step 12 signs every agent in with one Anthropic account; Anthropic requires each end user's own key or subscription, signed in through its own flow ([Anthropic](https://code.claude.com/docs/en/legal-and-compliance)) | This week |
| 3 | One real end-to-end run | Real agents, a real server and real GitHub have never been used; every check so far ran against stand-ins | This week |
| 4 | Accept Anthropic's Commercial Terms | Required for products that preinstall or run Claude Code, such as hosted sandboxes ([Anthropic](https://code.claude.com/docs/en/legal-and-compliance)) | This week |
| 5 | Public repository | Resolved on 24 October: the repo is now private. Fix the gaps PROGRESS.md lists before making it public | This week |
| 6 | A one-page pilot agreement | What you store from a team's code, who can see it, how it's deleted, and that nothing merges without its owner | This week |
| 7 | Security review level for friendly teams | The Risks table asks for an outside review before any team connects, which doesn't fit nine days. Recommended: least-privilege tokens, required reviews and your own review for friendly pilots; an outside review before paying teams | This week |
| 8 | A business-model hypothesis (decision 12) | YC asks how you'll make money; Claude Code usage can't be resold, so state a platform fee per team or seat and test it | This week |
| 9 | Licence (decision 14) | The repo already carries an MIT LICENSE file while the decision is open | This week |
| 10 | Handover any time | The build runs only in a nightly window; decision 4 says scheduled or any time | During the pilot |
| 11 | Claims and the pre-handover overlap check | The cheapest part of Hardy, and the reason to pick Aurora over a nightly job | During the pilot |
| 12 | Merge replay at handback | Approve refuses a branch that doesn't merge, but only when clicked and only against the base branch; owners' branches are never tested against each other | During the pilot |
| 13 | Approvals as each owner's own review (decision 11) | One person's token pushes, opens and merges every pull request, so GitHub shows that person as author, and authors can't approve their own | During the pilot |
| 14 | Master agents with sub-agents (decision 2) | The build turns agent creation off for safety; allow it only inside the owner's own subtree and budget | During the pilot |
| 15 | Decision tiers in the inbox | The email sorts by Ready, Blocked and Failed, not Needs you, Review suggested and Passed under your rules | During the pilot |
| 16 | The gauge and the 6-hour caution (decision 8) | Budget caps and a 60-minute step limit exist, but no estimate is shown | During the pilot |
| 17 | Settling conflicts in meaning | Distinguishing tests and a judge from another model family | Version 2 |
| 18 | Standing rules | Offered after three matching rulings | Version 2 |
| 19 | Generated screens and MCP Apps | Screens inside Claude, ChatGPT, VS Code and Goose (decision 9) | Version 2 |
| 20 | Slack, phone, WhatsApp and iMessage | Email covers the pilot (decision 16) | Version 2 |
| 21 | Setup-free hosting | A one-click instance per team, then a shared multi-team cloud | Version 2 |
| 22 | GitLab and other code hosts | Version 1 approvals are GitHub only (decision 11) | Version 2 |
| 23 | Work beyond code | UI from Figma designs, queries and data, model training with score checks | Version 2 |
| 24 | Meetings and multi-day work | Agents that brainstorm with their owner, propose team changes, or run work over several days | Version 2 |
| 25 | Numbers page and exports | CSV export, OpenTelemetry and prompt replay, the repo's planned M6 | Version 2 |
| 26 | A second step for email approvals | Anyone who can read the email can use its links; branch protection is the backstop until then | Version 2 |
| 27 | Robustness fixes | A join that fails halfway uses up the invite, and a crash mid-approval leaves a task "in progress" | Version 2 |

## Sources

### Earlier estimate (not reproducible)

Git history of 20 open-source product teams, 22 October 2025 to 22 October 2026. Same-day changes by two people to the same code file were replayed with git's own merge as if done in parallel; 439 clean replays were kept. Independent pairs conflicted 34 of 103 times (33%, 95% interval 25% to 43%) in teams of 2 to 10, and 20 of 82 (24%) in teams of 11 to 30. **Not reproducible** (corrected 31 October 2026): the 20 teams were never recorded, and the collision-audit scripts first existed on 25 October 2026, so this was not re-run with them. Treat it as an earlier, unreproduced estimate. The measured numbers are the corrected run in PROGRESS.md: 7 public repositories, 56 days, 1 conflict in more than 100 clean replays.

### Research and surveys

- [Xu et al.: agent pull requests and merge conflicts](https://arxiv.org/html/2607.04697v2)
- [CooperBench](https://arxiv.org/html/2601.13295v1)
- [METR: Frontier Risk Report, February to March 2026](https://metr.org/blog/2026-05-19-frontier-risk-report/)
- [METR: Measuring AI Ability to Complete Long Tasks](https://arxiv.org/html/2503.14499v1)
- [MacCormack, Baldwin and Rusnak: the mirroring hypothesis](https://dash.harvard.edu/bitstream/handle/1/34403525/maccormack,baldwin,rusnak_exploring-the-duality.pdf)
- [CaMeL: Defeating Prompt Injections by Design](https://arxiv.org/abs/2503.18813)
- [LLM evaluators recognize and favor their own generations](https://papers.nips.cc/paper_files/paper/2024/hash/7f1f0218e45f5414c79c0679633e47bc-Abstract-Conference.html)
- [Khan et al.: debate with more persuasive models](https://arxiv.org/html/2402.06782v4)
- [Google Research: Generative UI](https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/)
- [Faros AI: The AI Productivity Paradox Report 2025](https://www.faros.ai/blog/ai-software-engineering)
- [Microsoft: ten months with Copilot coding agent in dotnet/runtime](https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/)
- [The New Stack: Claude Code auto mode](https://thenewstack.io/claude-code-auto-mode/)
- [Pragmatic Engineer: AI tooling 2026](https://newsletter.pragmaticengineer.com/p/ai-tooling-2026)
- [Anthropic: AI's impact on software development](https://anthropic.com/research/impact-software-development)
- [Carta: Solo Founders Report 2025](https://carta.com/data/solo-founders-report)
- [MLE-bench leaderboard](https://www.developersdigest.tech/benchmarks/mle-bench)
- [Veracode: AI-generated code security](https://www.veracode.com/press-release/ai-generated-code-poses-major-security-risks-in-nearly-half-of-all-development-tasks-veracode-research-reveals/)
- [Wiz: exposed Moltbook database](https://wiz.io/blog/exposed-moltbook-database-reveals-millions-of-api-keys)
- [TechCrunch: thin margins for AI coding startups](https://techcrunch.com/2025/08/07/the-high-costs-and-thin-margins-threatening-ai-coding-startups/)
- [Paul Graham: Do Things That Don't Scale](https://www.paulgraham.com/ds.htm)
- [Nigel Cross, 1977, on human-behind-the-scenes prototypes](https://www.kmjn.org/snippets/cross77_wizardofoz.html)
- [Y Combinator FAQ](https://ycombinator.com/faq)

### Products, platforms and terms

- [GitHub: create a review for a pull request](https://docs.github.com/en/rest/pulls/reviews)
- [GitHub: authenticating with a GitHub App on behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)
- [GitHub: about protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [GitHub: approving a pull request with required reviews](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews)
- [GitHub: Agent HQ launch](https://github.blog/news-insights/company-news/welcome-home-agents/)
- [The New Stack: Agent HQ adds Claude and Codex](https://thenewstack.io/github-agent-hq/)
- [GitHub: Agentic Workflows](https://github.blog/2026-02-13-automate-repository-tasks-with-github-agentic-workflows/)
- [GitHub: 60 million Copilot code reviews](https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/)
- [GitLab: Duo Agent Platform generally available](https://about.gitlab.com/press/releases/2026-01-15-gitlab-announces-duo-agent-platform-general-availability/)
- [Anthropic: Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Anthropic: effort levels](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Claude Code: how Claude remembers your project](https://code.claude.com/docs/en/memory?r=0)
- [Claude Code: agent teams](https://code.claude.com/docs/en/agent-teams)
- [VentureBeat: Claude Tag](https://venturebeat.com/technology/anthropic-launches-claude-tag-replacing-its-slack-app-with-a-persistent-ai-teammate-that-learns-monitors-and-works-autonomously)
- [The New Stack: Sign in with ChatGPT](https://thenewstack.io/sign-in-with-chatgpt/)
- [OpenAI: the next phase of enterprise AI](https://openai.com/index/next-phase-of-enterprise-ai/)
- [Search Engine Journal: GPT-6 and Intelligent UI](https://www.searchenginejournal.com/chatgpt-gpt-6-intelligent-ui/592249/)
- [Microsoft Agent 365](https://learn.microsoft.com/en-ca/microsoft-agent-365/overview)
- [Cursor: background agents](https://cursor.com/help/ai-features/background-agents)
- [Cursor: rules and AGENTS.md](https://cursor.com/docs/context/rules)
- [SiliconANGLE: Cursor acquires Graphite](https://siliconangle.com/2025/12/19/cursor-acquires-ai-code-review-startup-graphite/)
- [Simon Willison: Agent Skills](https://simonwillison.net/2025/Dec/19/agent-skills)
- [Constellation: Agentic AI Foundation](https://www.constellationr.com/insights/news/agentic-ai-foundation-launches-mcp-other-ai-agent-standards)
- [MCP Apps announcement](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)
- [Figma: design context everywhere you build](https://www.figma.com/blog/design-context-everywhere-you-build/)
- [HackerNoon: Pawsly](https://hackernoon.com/four-ai-coding-agents-one-codebase-and-a-coordination-problem)
- [Nerveplane](https://arxiv.org/pdf/2610.07261)
- [Vonage: WhatsApp customer care window](https://developer.vonage.com/en/messages/whatsapp-provisioning/overview)
- [Photon iMessage adapter](https://chat-sdk.dev/adapters/vendor-official/photon)
- [Zendesk: Apple Messages for Business](https://www.zendesk.com/service/messaging/apple-messages-for-business/)

### Paperclip, read on 23 October 2026

- [README](https://github.com/paperclipai/paperclip)
- [Roadmap](https://github.com/paperclipai/paperclip/blob/main/ROADMAP.md)
- [Plugin spec](https://github.com/paperclipai/paperclip/blob/main/doc/plugins/PLUGIN_SPEC.md)
- [Agents table schema](https://github.com/paperclipai/paperclip/blob/main/packages/db/src/schema/agents.ts)
- [Roles and permissions](https://github.com/paperclipai/paperclip/blob/main/packages/shared/src/constants.ts)
- [Default role grants](https://github.com/paperclipai/paperclip/blob/main/server/src/services/company-member-roles.ts)
- [Authorization](https://github.com/paperclipai/paperclip/blob/main/server/src/services/authorization.ts)
- [GitHub identity during agent execution](https://github.com/paperclipai/paperclip/blob/main/doc/execution-github-identity.md)
- [Design plans](https://github.com/paperclipai/paperclip/tree/main/doc/plans)
- [Release v2026.1005.0](https://github.com/paperclipai/paperclip/blob/main/releases/v2026.1005.0.md)

### Added on 24 October

- [AgenticFlict](https://arxiv.org/abs/2604.03551) (Ogenrwot and Businge, 2026): 27.67% of 107K+ agent pull requests conflict with their base branch
- [Stack Overflow 2026 Developer Survey results](https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/): Claude Code (66%) and Copilot (59%) are the most-used agents
- [Stack Overflow pulse survey, May 2026](https://stackoverflow.blog/2026/05/27/agents-on-a-leash-agentic-ai-remains-mostly-monitored-at-work): 63% rarely or never let agents run on autopilot; 69% use a single agent
- [Anthropic legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), re-read 24 October: Commercial Terms for products that run Claude Code; each end user signs in with their own credentials
- [YC Requests for Startups, Fall 2026: Multiplayer AI](https://www.ycombinator.com/rfs#multiplayer-ai), by Aaron Epstein
- [YC FAQ](https://ycombinator.com/faq): 40% of funded companies are just an idea; solo founders accepted; no continuous editing after submitting; apply for Winter 2027 by 2 November
- [YC, common misconceptions](https://www.ycombinator.com/blog/common-misconceptions-about-applying-to-yc): 8.5% had a solo founder
- [Roundfunded](https://www.roundfunded.com/en/blogs/yc-application-deadlines-2026-2027): deadline 8pm PT; on-time applicants hear back by 11 December
- [a16z speedrun SR008](https://a16z.com/applications-for-a16z-speedrun-sr008-are-now-open/): closes 1 November, 11:59pm PT
- [Paul Graham's 13 sentences](https://www.nathanlustig.com/paul-grahams-13-sentences/): "Launch fast"; "Better to make a few users love you than a lot ambivalent"
- [Band for Developers](https://www.prnewswire.com/il/news-releases/band-launches-band-for-developers-to-support-the-transformation-of-sdlc-collaboration-and-control-of-multiple-coding-agents-302909844.html) and [SiliconANGLE](https://siliconangle.com/2026/10/16/band-launches-desktop-app-for-developer-collaboration-and-control-of-multiple-ai-coding-agents/)
- [Augment Intent](https://www.augmentcode.com/blog/intent-a-workspace-for-agent-orchestration)
- [Agents in Jira](https://www.devopsdigest.com/node/14558) and [Atlassian Community](https://community.atlassian.com/forums/Jira-articles/Introducing-Agents-in-Jira/bc-p/3221206)
- [CIO: OpenAI buys Ona](https://www.cio.com/article/4184655/openai-buys-ona-to-help-rein-in-ai-agents-2.html) and [OpenAI: scaling Codex](https://openai.com/index/scaling-codex-to-enterprises-worldwide)
- [GitHub Universe 2026 guide](https://github.blog/news-insights/company-news/your-guide-to-github-universe-2026-is-here-the-schedule-just-launched/)
- [Factory's raise](https://enterprisedna.co/resources/news/factory-ai-droids-200m-5b-valuation-enterprise-coding-september-2026) ($200 million at $5 billion) and [Cognition's raise](https://www.channelinsider.com/ai/news-cognition-devin-2b-funding-48b-valuation/) (more than $2 billion at $48 billion)
- [Aurora working branch](https://github.com/singularity-inc-dev/aurora/tree/claude/eloquent-hopper-9m2e04): PROGRESS.md, DEPLOY.md and CLAUDE.md, read 24 October
