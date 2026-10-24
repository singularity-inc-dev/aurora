# Putting Vision and Tom on a server

This is a checklist. Do the steps in order and tick each box.

- 🔑 means **only you can do this step**. It needs your money, your accounts or your passwords. Nobody else should do it for you, Claude included.
- `Grey boxes` are things to type. Copy them exactly. Replace the words in CAPITALS with your own values.
- On the server, everything is typed after you have logged in (step 6). After each command, wait until the blinking cursor comes back.

**What you end up with:** one web address, for example `https://team.example.com`, with:

- Paperclip, where everyone signs in with a password.
- The Vision and Tom plugin.
- The morning emails, with Approve and Reject links. Approve opens a pull request on GitHub and merges it.
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

These sizes are estimates, not measurements. At night, each person's agent runs at the same time as the others'. If the server feels slow, move up to the next size in your provider's control panel.

When you create the server, the provider shows its **IP address** (four numbers, for example `203.0.113.10`) and either a **root password** or an SSH key setup. Write down the IP address.

### ☐ 2. 🔑 Point a web address at the server

You need a domain you own, for example `example.com`. If you don't have one, buy one at any domain shop.

In your domain shop's **DNS settings**, add one record:

| Type | Name | Value |
|---|---|---|
| `A` | `team` (any word you like) | your server's IP address |

Your web address is then `team.example.com`. It can take from a few minutes to a day before it works everywhere. The HTTPS certificate is created automatically at step 9, but only after this record works.

### ☐ 3. 🔑 Get your email account's sending settings

The morning emails and invites are sent from your own email account, through what is called "SMTP". Look up four things in your email provider's help pages (search for "SMTP settings"):

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

It also turns on the firewall (only SSH and web traffic are let in). The last line should be:

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
- your own night agent
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

### ☐ 12. 🔑 Connect the agents to Claude (not tested yet; see "Known gaps")

The agents use the Claude Code tool installed in step 9. It needs your Anthropic account. In Paperclip, open each agent, follow its **Adapter** settings, and use **Test environment**. This step was not rehearsed in this milestone.

---

## Part C: everyday use

### Invite a teammate

```
vt-invite ana@example.com Europe/London
```

Ana gets an email with a link. The command also prints the link, so you can send it another way.

- The link works **once** and expires after 2 days.
- Opening it, Ana picks her name and a password. That creates her Paperclip account, her own night agent with safe settings, and her row in the plugin settings.
- A used or expired link shows "Invite already used" or "Invite expired" and creates nothing. Just run `vt-invite` again.

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
| Paperclip and the agents | user `paperclip` | only through Caddy (it listens on 127.0.0.1:3100) |
| Email service (morning emails, Approve/Reject/invite pages at `/vt/...`) | user `vt-mail` | only through Caddy (127.0.0.1:3299) |
| PostgreSQL 16 | user `postgres` | only on the server |

- **Sign-up through the web address is closed.** New accounts are only made by invite links.
- **The GitHub token that can push and merge** is read only by the email service. It is handed over by the system, and only when Approve is used (and to check pull requests that wait for review). It is not stored in Paperclip at all.
- **Everything restarts by itself** if it crashes, and starts by itself after a reboot. The backup runs even if the server was off at 03:30 (it catches up).

All versions are listed in `deploy/versions.env` and in the lockfiles next to it.

## Known gaps

- **Agents run as the same system user as Paperclip.** A badly behaved agent could read Paperclip's own database and its stored secrets. What it still can't do:
  - read the GitHub push token or the email password
  - push or merge on GitHub by itself

  But in principle it could forge an Approve link. Your branch protection (step 4, "Require approvals") is the backstop: even a forged Approve only opens a pull request that waits for a human review. The real fix is to run agents in Paperclip's separate "ssh" or "sandbox" environment. That's a decision for a later milestone.
- **Email account approval power.** Anyone who can read your email can use its links. There is no second step before Approve or Reject applies (your decision, M4).
- **Not tested for real:**
  - a real server and a real reboot (rehearsed in a folder on the build machine instead)
  - real Let's Encrypt certificates (rehearsed with Caddy's local certificate authority)
  - a real email provider (rehearsed with a mail server that needs a password and STARTTLS)
  - real GitHub (rehearsed with a stand-in that runs real git and the same pull-request calls)
  - the agents' Claude Code login (step 12)
