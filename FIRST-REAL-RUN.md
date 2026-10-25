# First real run: checklist

One real server, one real email account, one real GitHub test repository, your own Claude sign-in, and one real handover, from start to finish. Until now everything ran against stand-ins (spec gap 3). Do the parts in order and tick each box.

- 🔑 means **only you can do this step**: it needs your money, your accounts or your passwords. Nobody else should do it for you, Claude included.
- "You should see" says what a working step looks like. If you see something else, stop there, run `sudo vt-check`, and send me its output (it never shows secrets).
- **Emergency stop at any moment:** `sudo vt-stop` on the server (part 7).

**Time:** an afternoon, plus up to a day for your web address to start working.

---

## 1. The server

☐ 🔑 Do **DEPLOY.md steps 1 to 11**: rent the server, point a web address at it, install, run `vt-setup`, check.

You should see:
- `sudo vt-check` ends with **All good.** (or "All good, but N warning(s) above.": read the warnings).
- `https://YOUR-DOMAIN` shows a padlock with no warning, and you can sign in with the email and password you chose in `vt-setup`.
- After `reboot` and logging in again, `sudo vt-check` still says **All good.**

## 2. One real email account

☐ 🔑 Make an email account only for sending Aurora's emails (for example a new account at your email provider). Its Sent folder keeps a copy of every Approve link, and anyone who can read a link can use it, so share this account with nobody. The emails go **to** the address you gave `vt-setup`.

☐ 🔑 Get its SMTP settings and an app password (DEPLOY.md step 3) and store the password with `sudo vt-secret smtp-password` (DEPLOY.md step 8).

You should see: nothing yet. The first email is the handback email in part 5. If it does not come, `journalctl -u vt-email -n 50` on the server says why (wrong password, wrong port), without showing the password.

## 3. One protected test repository

☐ 🔑 On GitHub, make a **new private repository** for this run only (for example `aurora-first-run`), with:
- a `README.md`
- a `test.sh` that checks something small, for example: `grep -q "Hello" README.md`
- a `CODEOWNERS` file at the top that names **people, never teams**:
  ```
  *   @YOUR-GITHUB-LOGIN
  ```
  (A team like `@your-org/web` matches nobody. Aurora now warns about it: `vt-check` and every plan name the team and its line.)

☐ 🔑 Protect `main` (DEPLOY.md step 4): **Require a pull request before merging**, **Require approvals: 1**, **Do not allow bypassing**. Leave "Require review from Code Owners" off for this run.

☐ 🔑 Ask **a second person** (a friend or teammate) to be your reviewer, and give them access to the repository. GitHub never lets the author of a pull request approve it, and Aurora's pull requests are opened with your token, so they count as yours.

☐ 🔑 Make the three tokens of DEPLOY.md step 4 for this repository, and set `GITHUB_REPO` in `/etc/vision-and-tom/install.conf` to it (before step 9 of DEPLOY.md, or run `sudo vt-setup` again after changing it).

☐ In Paperclip, open the Vision and Tom plugin's settings. In the **Checks gate** box, set **Test command** to `sh test.sh`. Save, then press **Test**.

You should see: `sudo vt-check` says **CODEOWNERS names people only (no GitHub teams)**.

## 4. Your own Claude sign-in for your agent

☐ 🔑 Do **DEPLOY.md step 12, way 1** for yourself: send your SSH public key to the server with `vt-model-access`, then type the `ssh -t ...` line it prints **on your own computer** and sign in with your own Claude account.

You should see: Claude Code's own sign-in, in your own browser. Afterwards, the same line with `status` at the end says you are signed in. `sudo vt-check` shows no problem for your agent. Never sign in to Claude as `root` on the server.

## 5. One real handover

☐ In Paperclip, make **one small ticket** for your agent: assign it to your agent, status **Backlog**, for example:
> Title: Add a greeting to the README
> Description: Add a line "Hello from Aurora" to README.md. Only change README.md. When done, run the run_checks tool on this ticket, then mark it done.

☐ Open `https://YOUR-DOMAIN/vt/handover` (signed in to Paperclip) and tap **Hand over now**.

You should see, in order:
1. The page says **Started**. In Paperclip, a ticket "Plan for YOU's handover now ..." appears for your agent.
2. Within a few minutes your agent proposes the task on the plan ticket, with its claims (`README.md`), and the ticket shows **Approve the plan** and **Not this time**.
3. ☐ You tap **Approve the plan**. The task moves to "todo" and your agent starts. It works in its own branch (`vt/...`).
4. The agent runs the checks: a "Checks gate report" document appears on the task, and the task is marked done.
5. The **handback email** arrives: "Your handover of ...: 1 ready, 0 blocked, 0 failed", with **Approve** and **Reject** links.
6. ☐ 🔑 You tap **Approve**, then the button on the page. The page says **Waiting for review** and links to a pull request on GitHub.
7. ☐ 🔑 Your reviewer approves the pull request on GitHub and merges it (squash).
8. Within 10 minutes the task in Paperclip is **done**, and `sudo vt-numbers` shows a handover yield of 1 out of 1.

☐ While it works, measure memory as DEPLOY.md "During the first real handover: measure memory" says, and send me the numbers.

If a step does not happen within about 15 minutes, stop there and send me `sudo vt-check` and `journalctl -u paperclip -n 50`.

## 6. After the run

☐ Send me: what you saw at each step (a tick, or what was different), the memory numbers, and `sudo vt-numbers`.


## 7. Stop everything at once

```
sudo vt-stop
```

It stops Paperclip, every agent (including programs they left running) and the email service. Approve, Reject and invite links stop working. It stays stopped after a restart of the server. Nothing is deleted, and backups keep running. Start again with `sudo vt-start`, which ends with `vt-check`.

If you cannot reach the server, or want to be sure nothing can change your code:

☐ 🔑 On GitHub, **revoke the `vt-push` token** (Settings → Developer settings → Fine-grained tokens). Without it nothing can push to or merge in your repository. Make a new one later and store it with `sudo vt-secret github-token`.

☐ 🔑 At your server provider, **power the server off**.
