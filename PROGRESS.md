# Progress

Updated after every phase. Newest phase at the top of each section.

## Phase A: real Paperclip test bed (done)

### Checked against live Paperclip (2026.1012.0, in the cloud session)
- Paperclip starts with `npx paperclipai@2026.1012.0`, in local trusted mode on 127.0.0.1 only.
- The plugin installs from `plugin/` with the documented local-path command and shows `status=ready`.
- Valid settings: "Test" says valid, save succeeds, and the plugin worker reads them back (2 people, default 3 tasks a night). Secret ids never appear in the worker's output.
- Settings that break the basic rules are refused on save: an hour of 24, or a pasted raw value instead of a secret pick.
- Two people sharing one agent: "Test" says `people[1].agentId: already bound to another person`. Paperclip still saves it, and the plugin then refuses to work (fails closed).
- `scripts/integration-test.sh` runs all of this: 20 live checks, all passing, on two runs in a row.

### Unit tests only
- Owner-only key lookup and read-only-by-default (7 tests). Live Paperclip only lets a plugin read a key's value from inside a real agent action, which arrives in M2/M3.

### Unverified
- The settings page in a browser. The API that page uses was tested, but not the page itself.

### Answers to the milestone 1 questions
1. **Does Paperclip refuse invalid settings or only warn?** Both. It refuses anything that breaks the settings schema. It does not run our own checks on save, only when you press "Test". Our plugin therefore refuses to act on invalid settings.
2. **Does `paperclipai` work after npx?** Yes, written as `npx -y paperclipai@2026.1012.0 plugin ...`. A bare `paperclipai` command is not available unless you install it globally, which we don't need.

### How to test on your laptop
```bash
git clone https://github.com/singularity-inc-dev/aurora.git
cd aurora && git checkout claude/eloquent-hopper-9m2e04
(cd plugin && pnpm install && pnpm test)
scripts/integration-test.sh
```
Expect `Result: 20 passed, 0 failed` at the end. The script runs its own private Paperclip on port 3199 with its own data in `.paperclip-data/it`, so it won't touch a Paperclip you already use. To look around in the browser afterwards, run `KEEP_RUNNING=1 scripts/integration-test.sh` and open http://127.0.0.1:3199.

### Open questions for you
- None blocking.
