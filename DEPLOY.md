# Putting Vision and Tom on a server

This is a checklist. Do the steps in order and tick each box.

- 🔑 means **only you can do this step**. It needs your money, your accounts or your passwords. Nobody else should do it for you, Claude included.
- `Grey boxes` are things to type. Copy them exactly. Replace the words in CAPITALS with your own values.
- On the server, everything is typed after you have logged in (step 6). After each command, wait until the blinking cursor comes back.

**What you end up with:** one web address, for example `https://team.example.com`, with:

- Paperclip, where everyone signs in with a password.
- The Vision and Tom plugin.
- The handback emails, with Approve and Reject links. Approve opens a pull request on GitHub and merges it.
- Invite links for new teammates.
- A backup every night, and everything starting again by itself after a restart.

**Time:** about 1 hour, plus up to a day for the web address to start working (step 2).

---

## Part A: before the server (on your own computer)

### ☐ 1. 🔑 Rent the server

Rent a "cloud server" (also called a VPS) from any provider. Hetzner, DigitalOcean, OVH and Vultr all work.

| Choose | Minimum (2–4 people) | Better (up to 10 people) |
|---|---|---|
| System | **Ubuntu 24.04 LTS** (64-bit) | same |
| Processors (vCPU) | 2 | 4 |
| Memory (RAM) | 4 GB | 8 GB |
| Disk (SSD) | 40 GB | 80 GB |
| Extra option | **Backups** (or "snapshots"). Turn them on. It keeps a copy outside the server. | same |

These sizes are estimates, not measurements. During a handover, each person's agent runs at the same time as the others'. Measure it during your first real handover (see "During the first real handover: measure memory" in Part C). If the server feels slow, move up to the next size in your provider's control panel.

When you create the server, the provider shows its **IP address** (four numbers, for example `203.0.113.10`) and either a **root password** or an SSH key setup. Write down the IP address.

### ☐ 2. 🔑 Point a web address at the server

You need a domain you own, for example `example.com`. If you don't have one, buy one at any domain shop.

In your domain shop's **DNS settings**, add one record:

| Type | Name | Value |
|---|---|---|
| `A` | `team` (any word you like) | your server's IP address |

Your web address is then `team.example.com`. It can take from a few minutes to a day before it works everywhere. The HTTPS certificate is created automatically at step 9, but only after this record works.

### ☐ 3. 🔑 Get your email account's sending settings

The handback emails and invites are sent from your own email account, through what is called "SMTP". Look up four things in your email provider's help pages (search for "SMTP settings"):

- **SMTP server**, for example `smtp.gmail.com` or `smtp.fastmail.com`
- **Port**: use `587` if offered, otherwise `465`
- **User name**: usually your full email address
- **Password**: many providers (Gmail, Outlook, iCloud) want an **app password** here, not your normal password. Create one in your account's security settings.

Keep the password somewhere safe until step 7. Never put it in a file or an email.

### ☐ 4. 🔑 Create three GitHub tokens and protect your main branch

On GitHub: **your picture → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.**

Make these three tokens. For each, under "Repository access", choose **Only select repositories**:

| Token name (any) | Repository | Permissions (all others: "No access") | Used for |
|---|---|---|---|
| `vt-push` | the repository your agents work on | **Contents: Read and write**, **Pull requests: Read and write** (Metadata: Read is added automatically) | Approve: push, open the pull request, merge. Only the email service holds it; the agents can never read it. |
| `vt-read` | the same repository | **Contents: Read-only** | the agents download the code |
| `vt-download` | `singularity-inc-dev/aurora` | **Contents: Read-only** | downloading this app once, in step 5 |

Each token is shown **once**. Copy it into your password manager straight away.

Then protect the main branch. In the repository your agents work on: **Settings → Branches → Add branch protection rule** (or **Rules → Rulesets**). Use branch name `main` and tick:

- **Require a pull request before merging.**
- If you want a second person to look at every change: **Require approvals: 1.** Then Approve in the email opens the pull request and it waits for that review. The email and the confirmation page say "waiting for review".
- **Do not allow bypassing the above settings.** This matters: without it, your own token could skip the rules.

Then say who owns which part. Add a file called `CODEOWNERS` at the top of the repository (or in `.github/`) with one line per area: the folder, then its owner, by email or GitHub login. For example:

```
/src/ui/    ana@example.com
/src/api/   @bo-github-login
```

Commit it to `main`. Before every handover, Vision and Tom reads this committed file (never an agent's unsaved copy). A task that reaches into another person's area goes to that person's agent instead. If you name people by GitHub login, also enter each person's login as "GitHub login" in the plugin settings (step 10), so the two can be matched.

---

## Part B: on the server

### ☐ 5. 🔑 Log in to the server

On a Mac, open **Terminal**. On Windows, open **PowerShell**. Type:

```
ssh root@SERVER_IP
```

Type `yes` if asked, then the root password from step 1. You are now typing on the server.

First bring the server up to date. This takes a few minutes; then the server restarts and you log in again:

```
apt-get update && apt-get -y upgrade && reboot
```

```
ssh root@SERVER_IP
```

### ☐ 6. Download Vision and Tom

```
git clone https://github.com/singularity-inc-dev/aurora.git /opt/vision-and-tom/app
```

When asked for **Username**, type your GitHub user name. When asked for **Password**, paste the `vt-download` token. Nothing shows while you paste; that's normal. Then:

```
cd /opt/vision-and-tom/app && git checkout claude/eloquent-hopper-9m2e04
```

(Use `main` instead once this work has been merged there.)

### ☐ 7. Fill in the settings file

```
mkdir -p /etc/vision-and-tom && cp /opt/vision-and-tom/app/deploy/install.conf.example /etc/vision-and-tom/install.conf && nano /etc/vision-and-tom/install.conf
```

A simple editor opens. Use the arrow keys, change the values, then press **Ctrl+O, Enter** (save) and **Ctrl+X** (exit).

| Line | What to put |
|---|---|
| `DOMAIN=` | your web address from step 2, without `https://`, e.g. `team.example.com` |
| `ACME_EMAIL=` | your email (only for certificate warnings) |
| `SMTP_HOST=` / `SMTP_PORT=` / `SMTP_USER=` | from step 3 |
| `MAIL_FROM=` | who the emails come from, e.g. `"Vision and Tom <you@example.com>"` (keep the quotes) |
| `GITHUB_REPO=` | the repository your agents work on, as `owner/name` |
| `GITHUB_BASE_BRANCH=` | usually `main` |
| `COMPANY_NAME=` | your team's name, in quotes |

No passwords or tokens go in this file.

### ☐ 8. 🔑 Store the secrets

Type each line, then paste the matching secret when asked. Nothing shows while you paste, and nothing is kept in the command history.

```
/opt/vision-and-tom/app/deploy/bin/vt-secret smtp-password
```
```
/opt/vision-and-tom/app/deploy/bin/vt-secret github-token
```
```
/opt/vision-and-tom/app/deploy/bin/vt-secret github-read-token
```

| Secret | Paste | Where it ends up |
|---|---|---|
| `smtp-password` | the email password from step 3 | `/etc/vision-and-tom/secrets/smtp-password`: only root can read it; handed to the email service alone |
| `github-token` | the `vt-push` token | `/etc/vision-and-tom/secrets/github-token`: only root can read it; handed to the email service alone (the agents run as another user and cannot read it) |
| `github-read-token` | the `vt-read` token | stored with the project's copy of the code, so the agents can download updates (it can only read) |

Two more secrets are made automatically, and you never see them: the database password and Paperclip's key for the email service.

### ☐ 9. Install everything

```
bash /opt/vision-and-tom/app/deploy/install.sh
```

This takes about 10 minutes. It installs these exact versions and checks every download against its known fingerprint:

- PostgreSQL 16
- Node.js 24.22.1
- Caddy 2.11.7, which makes HTTPS work
- Paperclip 2026.1012.0
- the plugin and the email service
- the agents' Claude Code tool

It also turns on the firewall (only SSH and web traffic are let in), and sets up SSH so that each person's agent can run as a system user of its own, which cannot read Paperclip's data or secrets. For that it restarts the SSH service once: the window you are typing in stays connected. (If it ever drops, just log in again as in step 5.) The last line should be:

```
==> Installed. Next: sudo /opt/vision-and-tom/app/deploy/bin/vt-setup
```

If it stops with `STOPPED: ...`, the line says why. Fix that, then run the same command again: it continues where it can and never deletes anything.

### ☐ 10. 🔑 Create your own account and connect everything

```
/opt/vision-and-tom/app/deploy/bin/vt-setup
```

It asks for your name, your email, your timezone (for example `Europe/London`) and a new Paperclip password (12 characters or more, typed twice, not shown). Then it sets up the rest:

- your Paperclip account, made the administrator
- your company
- the plugin and its settings
- your own agent, with a system user of its own (its name starts with `vt-a-`)
- the copy of your repository the agents work in
- the email service

The last line should be `==> Done.`

### ☐ 11. Check that it works

```
vt-check
```

Every line should start with `OK`, and the last line should be **All good.** Right after installing, one line will say there is no backup yet. Make the first one now, then run the check again:

```
vt-backup && vt-check
```

Then, on your own computer:

1. Open `https://YOUR-DOMAIN`. The padlock should show, with no warning. Sign in with the email and password from step 10.
2. Restart the server, to check that everything comes back by itself:
   ```
   reboot
   ```
   Wait 2 minutes, log in again (step 5), and run `vt-check`. It should say **All good.** again.

### ☐ 12. 🔑 Connect each agent to its owner's own Claude account

Every agent uses **its own owner's** Claude access, never one shared account. Each owner chooses one of two ways, for themselves. Do this for yourself now, and for each teammate after they join (Part C).

**Never sign in to Claude as `root` or as the `paperclip` user on the server**, and never put a key into an agent's settings by hand. `vt-check` warns if Paperclip's own user has a Claude login.

**Way 1: the owner's own Claude subscription (Pro or Max).** The owner signs in with Claude Code's own sign-in page. The login stays with their agent; you never see it, and Vision and Tom never reads it.

1. The owner sends you their **SSH public key**: one line starting with `ssh-ed25519` (on their computer: `cat ~/.ssh/id_ed25519.pub`; if they have none, `ssh-keygen -t ed25519` makes one). A public key is not a secret.
2. On the server, type (with their email and their key in the quotes):
   ```
   vt-model-access ana@example.com subscription "ssh-ed25519 AAAA... ana@laptop"
   ```
   It prints a line like `ssh -t vt-a-1234567890@team.example.com`. Send that line to the owner.
3. 🔑 The owner types that line **on their own computer**. Claude Code's sign-in opens; they follow it with their own Claude account. That key can do nothing else on the server. Later, adding `status` or `logout` at the end of the line shows or ends the sign-in.

**Way 2: the owner's own API key.** The owner stores their key in Paperclip themselves; you only point their agent at it.

1. 🔑 The owner signs in to Paperclip, opens the company's **Secrets**, and adds a secret with the key `anthropic-api-key-THEIRNAME` and their own Anthropic API key as the value.
2. On the server, type:
   ```
   vt-model-access ana@example.com api-key anthropic-api-key-ana
   ```
   Only that owner's agent gets that key. Giving the same key to a second person is refused.

Then run `vt-check`. A person without a choice shows as a problem, and their agent does no work until they choose.

---

## Part C: everyday use

### Invite a teammate

```
vt-invite ana@example.com Europe/London
```

Ana gets an email with a link. The command also prints the link, so you can send it another way.

- The command also makes the system user Ana's agent will run as. Only an admin (root on the server) can invite.
- The link works **once** and expires after 2 days.
- Opening it, Ana picks her name and a password. That creates her Paperclip account, her own agent with safe settings (running as that system user), and her row in the plugin settings.
- Then connect her agent to her own Claude account (step 12, for Ana).
- A used or expired link shows "Invite already used" or "Invite expired" and creates nothing. Just run `vt-invite` again.

### Hand over now

Each person's agent works at their scheduled handover hour (set in the plugin settings). To start one at any other time, the person opens this page **while signed in to Paperclip**:

```
https://YOUR-DOMAIN/vt/handover
```

and taps **Hand over now**. Their agent plans up to three tasks right away. Nothing runs until they approve the plan in Paperclip, and nothing shared changes until they approve each result in the handback email. Only one handover per person runs at a time, and the page only ever acts for the person who is signed in.

### Before each handover: the pre-handover check

When an agent proposes its tasks, each task has to list the files and folders it may change (its "claims"). Vision and Tom compares them with everyone's areas in `CODEOWNERS` (step 4) and with the files other people's open tasks have already claimed:

- A task inside your own area, or in files nobody owns, stays in your plan.
- A task that reaches into someone else's area, or into files someone else's task claimed first, does not run in your handover. It becomes a waiting ticket for that person's agent, and they decide about it in one of their own plans. Plans already proposed are never changed.
- Your plan in Paperclip shows what was moved, as at most three questions. If something looks wrong, choose "Not this time" and say why.

A task's claim ends when you decide it in the handback email, or when its plan expires without approval.

### At handback: the merge replay

Before your handback email goes out, Vision and Tom test-merges each finished branch against everyone else's finished, undecided branches. It does this in git's memory only and merges nothing. If two branches change the same lines, both owners see it in their email (the other owner may get a short separate email), with the files involved. Agree who goes first, approve that one, and reject or redo the other.

### The pilot's numbers

Log in to the server (step 5) and type:

```
sudo vt-numbers numbers.csv
```

It prints the team's numbers and each person's (handover yield, minutes to approve, decisions per handback, overlaps caught before a handover, conflicts found after), and writes `numbers.csv`: one line per work order, in the measurement sheet's columns. Copy it to your computer with `scp root@YOUR-SERVER:numbers.csv .` and open it in any spreadsheet. "Minutes to approve" is the time from the email being sent to your last decision on it, not the time you spent reading.

### Before the pilot: the collision audit

Each pilot team can run this on its own computer, on its own copy of its repository. It reads the history, changes nothing and sends nothing anywhere. It needs git 2.38+ and Python 3.9+:

```
git clone https://github.com/OWNER/NAME.git team-repo
tools/collision-audit/collision-audit team-repo OWNER/NAME
```

It writes a folder with `summary.md`, the one page to read with the team. `tools/collision-audit/README.md` explains what it counts.

### During the first real handover: measure memory

The server sizes in step 1 are estimates. During your first real handover, while the agents work, log in (step 5) and type:

```
free -m && ps -eo user=,rss= | awk '{m[$1]+=$2} END {for (u in m) if (m[u] > 51200) printf "%-14s %6d MB\n", u, m[u]/1024}'
```

The first part shows how much memory is used and free. The second shows the memory each user takes: `paperclip` is Paperclip, and each `vt-a-...` line is one person's agent. Do it two or three times during the handover. If "available" in the `Mem:` line falls under about 500 MB, move up one server size (step 1). Note the numbers in PROGRESS.md so the sizes become measurements.

### Backups

- A backup is made **every night at 03:30** (server time). The newest 14 are kept, in `/var/backups/vision-and-tom/`.
- Each backup holds the whole database, Paperclip's files, the code the agents work on, and the settings.
- Because it must be able to rebuild everything, a backup **contains your secrets**. Only root can read it.
- See the list: `vt-restore`. Make one now: `vt-backup`.
- 🔑 **Keep a copy off the server**, for example once a week. On your own computer (not on the server), type:
  ```
  scp root@SERVER_IP:/var/backups/vision-and-tom/vt-backup-*.tar .
  ```
  Keep that file as safely as a password. Your provider's backup option (step 1) is a second copy.

### Restore a backup on the same server

```
vt-restore
```

This lists the backups. Pick one and type, for example:

```
vt-restore /var/backups/vision-and-tom/vt-backup-20261022T033000Z.tar
```

It works in this order:

1. It checks the backup isn't damaged. If it is, nothing changes.
2. It stops the services.
3. It moves today's data aside into `/var/backups/vision-and-tom/before-restore-...`. Nothing is deleted.
4. It puts the backup back and starts everything.

Run `vt-check` afterwards. Delete the `before-restore-...` folder only once you're happy.

### Restore on a brand-new server (if the old one is gone)

1. 🔑 Rent a new server (step 1), and change the DNS record (step 2) to its new IP address.
2. Do steps 5, 6 and 7, then step 9 (`install.sh`). Skip step 8 and step 10: the secrets, your account and all the settings come back from the backup.
3. 🔑 Copy your backup file onto the new server. On your own computer:
   ```
   scp vt-backup-XXXX.tar root@NEW_SERVER_IP:/root/
   ```
4. On the new server:
   ```
   vt-restore /root/vt-backup-XXXX.tar && vt-check
   ```

### If something is wrong

- `vt-check` says which part is wrong.
- See a part's latest messages: `journalctl -u paperclip -n 50`. The other parts are `vt-email` (emails and links), `caddy` (HTTPS) and `postgresql` (database).
- Restart one part: `systemctl restart vt-email`.
- Don't change version numbers yourself. Each set of versions is tested together first.

---

## How it fits together (for the curious)

| Part | Runs as | Reachable |
|---|---|---|
| Caddy (HTTPS, certificates from Let's Encrypt) | user `caddy` | from the internet, ports 80 and 443 |
| Paperclip | user `paperclip` | only through Caddy (it listens on 127.0.0.1:3100) |
| Each person's agent | its own user `vt-a-...`, not in the `paperclip` group | Paperclip logs in to it over SSH on 127.0.0.1 only; the owner's own key may only start Claude Code's sign-in (step 12) |
| Email service (handback emails; Approve/Reject, invite and Hand over now pages at `/vt/...`) | user `vt-mail` | only through Caddy (127.0.0.1:3299) |
| PostgreSQL 16 | user `postgres` | only on the server |

- **Sign-up through the web address is closed.** New accounts are only made by invite links.
- **Each agent runs as a system user of its own.** It cannot read Paperclip's files, its database password, its secrets or the key that signs Approve links, nor another person's agent. Nothing started over SSH can see other users' running programs. The checks (tests and lint) run as that same agent user, in a fresh folder each time, never as Paperclip's own user.
- **The GitHub token that can push and merge** is read only by the email service. It is handed over by the system, and only when Approve is used (and to check pull requests that wait for review). It is not stored in Paperclip at all.
- **Everything restarts by itself** if it crashes, and starts by itself after a reboot. The backup runs even if the server was off at 03:30 (it catches up).

All versions are listed in `deploy/versions.env` and in the lockfiles next to it.

## Known gaps

- **What an agent can still do.** It can use Paperclip's API as itself (with the run token Paperclip gives it), read and change its own working copy, and run its owner's own checks. Checks run as the agent's own user, so an agent could interfere with its own checks; Hardy's separate, locked sandbox for checks comes in a later milestone (M4). Your branch protection (step 4) stays the backstop for anything it merges.
- **Never run real agents on Paperclip's built-in database** (the laptop "quickstart" setup): its password is a fixed, well-known one. This server uses PostgreSQL with a random password.
- **Two plans at the very same moment.** If two people's agents propose overlapping tasks within the same second or so, both can pass the pre-handover check. The merge replay at handback is the backstop.
- **Updating a server that is already running** is not scripted yet. A version that needs new Paperclip permissions (0.8.0 needs read-only access to the project's folder) has to be reinstalled in Paperclip; uninstalling without `--force` keeps its settings. Until this is scripted, install fresh with this version.
- **CODEOWNERS teams.** Entries like `@org/team` are not matched to people; name people by email or login.
- **Email account approval power.** Anyone who can read your email can use its links. There is no second step before Approve or Reject applies (your decision, M4).
- **Not tested for real:**
  - a real server and a real reboot (rehearsed in a folder on the build machine instead)
  - real Let's Encrypt certificates (rehearsed with Caddy's local certificate authority)
  - a real email provider (rehearsed with a mail server that needs a password and STARTTLS)
  - real GitHub (rehearsed with a stand-in that runs real git and the same pull-request calls)
  - a real Claude Code sign-in and a real API key (step 12 was rehearsed with stand-ins)
  - the SSH rules and the hidden processes on a real Ubuntu SSH service (rehearsed on this build machine's own SSH server)
