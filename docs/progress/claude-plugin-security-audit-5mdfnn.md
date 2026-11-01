# Security audit: plugin routes, prompt injection, secret scan

Branch `claude/plugin-security-audit-5mdfnn`, started from `claude/handover-alignment` at `e5b6b38`
(PR #7's head). On 2026-11-01, `origin/main` was still at `041fe60` and did not contain PR #7, so
the owner said to branch from PR #7 instead.

## Step 1: is risk S1 real? (docs/design/CURRENT-STATE.md, "Security risks")

**Question.** Can one signed-in person call the plugin's web routes and get another owner's
Approve or Reject links, or act on another owner's plan or task?

**Answer: yes. The hole is real, and proven both in unit tests and against real Paperclip.**

### What Paperclip does (read from its code, not guessed)
- The SDK gives every route the caller (`PluginApiRequestInput.actor`,
  `plugin-sdk/dist/define-plugin.d.ts:97-113`).
- Paperclip 2026.1012.0 lets a call through to an `auth: "board"` route when the caller is any
  human (browser session or a human's API key) **and a member of the company, in any role**
  (`@paperclipai/server/dist/routes/plugins.js:377-381` `assertBoard`, then `assertCompanyAccess`,
  `dist/routes/authz.js:61-81`). There is no admin-only check. This settles the ASSUMPTION in
  CURRENT-STATE.md.
- The plugin only learns the user id (`actorId`/`userId`). It is not told whether the call came
  from a browser or from an API key (`authz.js:166-191`, `plugins.js:1458-1468`). Only five
  headers are passed on: accept, content-type, user-agent, x-paperclip-run-id, x-request-id
  (`plugins.js:313-333`).
- The email service's board API key belongs to a user, today the owner/admin, so the plugin
  cannot tell "the email service" from "the owner in a browser".

### What the plugin does
`onApiRequest` (`plugin/src/worker.ts:299-386`) never reads `input.actor`. Every route trusts
whoever Paperclip let in.

### Unit proof: `plugin/tests/routeauth.test.ts` (9 tests, all fail today)
Ana has a handback email waiting. Dee is a teammate signed in with her own account.
Using only answers from the plugin's routes, Dee:

| Route | What Dee got or did |
| --- | --- |
| `briefings-pending` | Ana's email with freshly signed Approve and Reject links (200) |
| `link-execute` (Approve) | **Approved Ana's task**: "publish to GitHub … Approved by ana@example.com" |
| `link-execute` (Reject) | Rejected Ana's task: "T1 was rejected. Reason saved." |
| `pr-update` | Marked Ana's waiting pull request "merged", so the task is recorded accepted |
| `handover-status` | Ana's handover status |
| `handover-start` | Reached the start logic for Ana; only refused by a fixture detail |
| `invite-create` | Reached the invite logic; only refused by a fixture detail |
| `prs-waiting`, `links-stuck` | The email service's work queues |
| `numbers-csv` | The whole team's event log export |

### Live proof: `scripts/deploy-rehearsal.sh`, block "S1"
Real Paperclip in authenticated mode behind Caddy, as on the server. Dee joined through an
invite (role operator), signed in with her own password and called the routes over HTTPS with
her own cookie. **Paperclip let her through on all 7 routes tried.** Every answer came from the
plugin, none was 401/403:

| Check | Answer Dee got |
| --- | --- |
| pending handback emails | `200 {"emails":[]}` (no email was pending at that moment; the route is open to her) |
| owner's handover status | `200`, the owner's schedule and current handover |
| start a handover for the owner | `409 a handover is already in progress` (the plugin processed it as a valid request) |
| create an invite | `409 the new agent needs its own system user first` (plugin logic, not a refusal) |
| export the event log | `200`, the team's CSV |
| waiting pull requests | `200` |
| report a pull request merged | `200 no waiting pull request for this task` (plugin logic) |

Together: real Paperclip lets Dee in, and the plugin hands her Ana's links and lets her act on
Ana's tasks. Severity stays **Critical**.
