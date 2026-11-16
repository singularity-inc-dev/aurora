# Thin version 1, piece A: agent isolation (spec gap 1). Sourced by scripts/integration-test.sh.
#
# Real Paperclip runs each owner's agent over SSH as that owner's own system user
# (vt-agent-ana, vt-agent-bo), on a private sshd that hides other users' processes
# like the server's ProtectProc=invisible. The test bed's data folder gets the
# server's permissions first (Paperclip's data is private to Paperclip).
#
# Ana's agent is a stand-in that behaves like a hostile agent (scripts/it/lib/fake-claude):
# it tries to read Paperclip's data, secrets and keys, Bo's files, other processes,
# and the secrets API with its own run token. Then the checks gate runs as Ana's
# agent user through deploy/bin/vt-check-runner.
#
# Needs Linux, root and scripts/it/lib/setup-test-users.sh (changes the machine; ask first).

. "$ROOT/scripts/it/lib/sshbed.sh"
if ! sshbed_require; then fail "v1a: isolation test bed is not available"; return 0; fi
V1A_D="$ROOT/.paperclip-data"
v1a_run_status() { # issueId -> status of the newest run for that issue
  api GET "/api/companies/$V1A_CID/heartbeat-runs"
  echo "$API_BODY" | json "((Array.isArray(d)?d:d.items).filter(r=>r.issueId==='$1'||(r.contextSnapshot&&r.contextSnapshot.issueId==='$1'))[0]||{}).status||''"
}
v1a_wait_file() { # file seconds
  for _ in $(seq 1 "$2"); do [ -f "$1" ] && return 0; sleep 1; done
  return 1
}

echo "-- server-like permissions on the test bed's data (on the server: /var/lib/paperclip is 750, agents are not in its group)"
chmod 711 "$V1A_D" "$V1A_D/it" "$V1A_D/it/instances" "$V1A_D/it/instances/default"
for d in "$V1A_D/it/instances/default/logs" "$V1A_D/it/instances/default/data" "$V1A_D"/it-repos "$V1A_D"/m*-it; do [ -e "$d" ] && chmod 700 "$d"; done
mkdir -p "$V1A_D/it-repos" && chmod 700 "$V1A_D/it-repos"

echo "-- private sshd (key login only, no forwarding, hidden processes)"
sshbed_start || { fail "v1a: sshd did not start"; return 0; }
sshbed_known_hosts
for who in ana bo; do
  sshbed_key "$who-run"
  sshbed_key "$who-checks"
  # Paperclip's key: commands, nothing else. The checks key: only the runner.
  sshbed_authorize "vt-agent-$who" "$who-run" 'from="127.0.0.1",restrict'
  sshbed_authorize "vt-agent-$who" "$who-checks" "restrict,command=\"$ROOT/deploy/bin/vt-check-runner\""
done

echo "-- company, repository, one SSH environment per owner"
api POST /api/companies "{\"name\":\"VT v1a $(date +%s)\"}"
V1A_CID=$(echo "$API_BODY" | json 'd.id')
api PATCH /api/instance/settings/experimental '{"enableIsolatedWorkspaces":true}'
V1A_REPO="$V1A_D/it-repos/v1a-$(date +%s)"
mkdir -p "$V1A_REPO" && git -C "$V1A_REPO" init -q -b main && echo hello >"$V1A_REPO/README.md"
git -C "$V1A_REPO" add README.md && git -C "$V1A_REPO" -c user.email=t@example.com -c user.name=T commit -q -m init
api POST "/api/companies/$V1A_CID/projects" "{\"name\":\"app\",\"executionWorkspacePolicy\":{\"enabled\":true,\"defaultMode\":\"isolated_workspace\",\"allowIssueOverride\":true,\"workspaceStrategy\":{\"type\":\"git_worktree\"}},\"workspace\":{\"name\":\"app\",\"sourceType\":\"local_path\",\"cwd\":\"$V1A_REPO\",\"isPrimary\":true}}"
V1A_PID=$(echo "$API_BODY" | json 'd.id')
v1a_env() { # who -> environment id (the private key goes to Paperclip, which stores it as its own secret)
  local body
  body=$(node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({name:`${process.argv[1]}'"'"'s agent user (${process.argv[5]})`,driver:"ssh",config:{host:"127.0.0.1",port:Number(process.argv[2]),username:`vt-agent-${process.argv[1]}`,remoteWorkspacePath:`/home/vt-agent-${process.argv[1]}/work`,privateKey:fs.readFileSync(process.argv[3],"utf8"),knownHosts:process.argv[4],strictHostKeyChecking:true}}))' "$1" "$SSHBED_PORT" "$SSHBED/keys/$1-run" "$SSHBED_KNOWN_HOSTS" "$V1A_CID")
  api POST "/api/companies/$V1A_CID/environments" "$body"
  echo "$API_BODY" | json 'd.id'
}
V1A_ENV_A=$(v1a_env ana)
V1A_ENV_B=$(v1a_env bo)
api POST "/api/environments/$V1A_ENV_A/probe" '{}'
check "v1a: Paperclip reaches Ana's agent user over SSH" "$(echo "$API_BODY" | json 'd.ok')" "true"
api GET "/api/environments/$V1A_ENV_A"
check "v1a: Paperclip keeps the SSH key as its own secret (not in the environment's settings)" "$(echo "$API_BODY" | json 'd.config.privateKey===null && !!d.config.privateKeySecretRef')" "true"

echo "-- secrets: the link signing key and each owner's checks key"
V1A_SIGN_VALUE=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
api POST "/api/companies/$V1A_CID/secrets" "{\"name\":\"vt-link-signing\",\"key\":\"vt-link-signing\",\"value\":\"$V1A_SIGN_VALUE\"}"
V1A_SIGN=$(echo "$API_BODY" | json 'd.id')
v1a_secret() { # name file -> secret id
  api POST "/api/companies/$V1A_CID/secrets" "$(node -e 'process.stdout.write(JSON.stringify({name:process.argv[1],key:process.argv[1],value:require("fs").readFileSync(process.argv[2],"utf8")}))' "$1" "$2")"
  echo "$API_BODY" | json 'd.id'
}
V1A_CK_A=$(v1a_secret vt-checks-key-ana "$SSHBED/keys/ana-checks")
V1A_CK_B=$(v1a_secret vt-checks-key-bo "$SSHBED/keys/bo-checks")

echo "-- agents: Claude adapter (stand-in program), each in its owner's environment"
V1A_PC="$V1A_D/it/instances/default"
V1A_FILES="$V1A_PC/secrets/master.key:$V1A_PC/secrets/decision-signing.key:$V1A_PC/config.json:$V1A_PC/.env:/home/vt-agent-bo/.bashrc:$SSHBED/keys/ana-run:$SSHBED/keys/bo-checks"
V1A_DIRS="$V1A_D/it:$V1A_D/it-repos:$V1A_PC/logs:$V1A_PC/data:/home/vt-agent-bo"
v1a_agent() { # name env -> agent id
  api POST "/api/companies/$V1A_CID/agents" "{\"name\":\"$1\",\"role\":\"engineer\",\"adapterType\":\"claude_local\",\"adapterConfig\":{\"engine\":\"cli\",\"command\":\"$ROOT/scripts/it/lib/fake-claude\",\"env\":{\"VT_PROBE_FILES\":\"$V1A_FILES\",\"VT_PROBE_DIRS\":\"$V1A_DIRS\",\"VT_PROBE_SECRET_PATH\":\"/api/companies/$V1A_CID/secrets\",\"VT_PROBE_API\":\"$BASE\",\"VT_PROBE_SECRET_KEYS\":\"vt-link-signing vt-checks-key-bo vt-checks-key-ana\"}},\"defaultEnvironmentId\":\"$2\"}"
  local id; id=$(echo "$API_BODY" | json 'd.id')
  api PATCH "/api/agents/$id/permissions" '{"canCreateAgents":false,"canCreateSkills":false,"canAssignTasks":true}'
  echo "$id"
}
V1A_A=$(v1a_agent "Ana's agent" "$V1A_ENV_A")
V1A_B=$(v1a_agent "Bo's agent" "$V1A_ENV_B")
v1a_person() { # email agent env user checksKey
  echo "{\"email\":\"$1\",\"agentId\":\"$2\",\"agentEnvironmentId\":\"$3\",\"agentUser\":\"$4\",\"checksKey\":{\"type\":\"secret_ref\",\"secretId\":\"$5\"},\"modelAccess\":\"subscription\",\"timezone\":\"UTC\",\"nightStartHour\":22,\"nightBudgetCapCents\":500}"
}
V1A_PEOPLE="[$(v1a_person ana@example.com "$V1A_A" "$V1A_ENV_A" vt-agent-ana "$V1A_CK_A"),$(v1a_person bo@example.com "$V1A_B" "$V1A_ENV_B" vt-agent-bo "$V1A_CK_B")]"
# The test command passes only when it runs as an owner's agent user; the lint command only when Paperclip's master key is out of reach.
V1A_CHECKS="{\"testCommand\":\"case \\\"\$(id -un)\\\" in vt-agent-*) exit 0;; *) echo ran as \$(id -un); exit 1;; esac\",\"lintCommand\":\"! head -c1 $V1A_PC/secrets/master.key\",\"sandbox\":{\"host\":\"127.0.0.1\",\"port\":$SSHBED_PORT,\"knownHosts\":\"$SSHBED_KNOWN_HOSTS\"}}"
v1a_config() { # people json
  api POST "/api/plugins/$PLUGIN_ID/config" "{\"companyId\":\"$V1A_CID\",\"configJson\":{\"serviceUserId\":\"$IT_SERVICE_USER\",\"checks\":$V1A_CHECKS,\"links\":{\"baseUrl\":\"http://127.0.0.1:3298\",\"signingSecret\":{\"type\":\"secret_ref\",\"secretId\":\"$V1A_SIGN\"}},\"people\":$1}}"
}
v1a_config "$V1A_PEOPLE"
check "v1a: save settings (isolation required, the default)" "$API_STATUS" "200"
v1a_audit() { api POST "/api/plugins/$PLUGIN_ID/data/route-audit" "{\"companyId\":\"$V1A_CID\",\"params\":{}}"; }
v1a_audit
check "v1a: isolation audit passes for both owners" "$(echo "$API_BODY" | json 'd.data.ok && d.data.isolationRequired')" "true"

echo "-- the audit refuses agents that are not isolated"
api PATCH "/api/agents/$V1A_B" "{\"defaultEnvironmentId\":\"$V1A_ENV_A\"}"
v1a_audit
check "v1a: Bo's agent pointed at Ana's environment is flagged" "$(echo "$API_BODY" | json "d.data.agents.find(a=>a.email==='bo@example.com').problems.join().includes(\"owner's own environment\")")" "true"
api PATCH "/api/agents/$V1A_B" "{\"defaultEnvironmentId\":\"$V1A_ENV_B\"}"
api POST "/api/companies/$V1A_CID/agents" '{"name":"host agent","role":"engineer","adapterType":"process","adapterConfig":{"command":"pwd"}}'
V1A_P=$(echo "$API_BODY" | json 'd.id')
api PATCH "/api/agents/$V1A_P" "{\"defaultEnvironmentId\":\"$V1A_ENV_B\"}"
check "v1a: Paperclip itself refuses an SSH environment for an adapter that runs on the host" "$API_STATUS" "422"
api PATCH "/api/agents/$V1A_P/permissions" '{"canCreateAgents":false,"canCreateSkills":false,"canAssignTasks":true}'
v1a_config "[$(v1a_person ana@example.com "$V1A_A" "$V1A_ENV_A" vt-agent-ana "$V1A_CK_A"),$(v1a_person bo@example.com "$V1A_P" "$V1A_ENV_B" vt-agent-bo "$V1A_CK_B")]"
v1a_audit
check "v1a: a 'process' agent (always Paperclip's own user) is flagged" "$(echo "$API_BODY" | json "d.data.agents.find(a=>a.email==='bo@example.com').problems.join().includes('always runs as Paperclip')")" "true"
v1a_config "$V1A_PEOPLE"

echo "-- Ana's hostile stand-in agent runs one task (as vt-agent-ana, over SSH)"
api POST "/api/companies/$V1A_CID/issues" "{\"title\":\"Probe what an agent can reach\",\"projectId\":\"$V1A_PID\",\"assigneeAgentId\":\"$V1A_A\",\"status\":\"todo\",\"executionWorkspaceSettings\":{\"mode\":\"isolated_workspace\",\"workspaceStrategy\":{\"type\":\"git_worktree\",\"branchTemplate\":\"vt/{{issue.identifier}}-{{slug}}\"}}}"
V1A_ISS=$(echo "$API_BODY" | json 'd.id')
V1A_WT=""
for _ in $(seq 1 90); do
  api GET "/api/issues/$V1A_ISS"
  V1A_EW=$(echo "$API_BODY" | json 'd.executionWorkspaceId || ""')
  if [ -n "$V1A_EW" ]; then
    api GET "/api/execution-workspaces/$V1A_EW"
    V1A_WT=$(echo "$API_BODY" | json 'd.cwd')
    [ -n "$V1A_WT" ] && [ -f "$V1A_WT/vt-probe.json" ] && break
  fi
  sleep 2
done
check "v1a: the agent's work came back to the task's own worktree on the host" "$([ -n "$V1A_WT" ] && [ -f "$V1A_WT/vt-probe.json" ] && echo yes || echo no)" "yes"
check "v1a: ...as a commit on the task's branch" "$(git -C "${V1A_WT:-/nonexistent}" log -1 --format=%s 2>/dev/null)" "stand-in agent report"
V1A_PROBE=$(cat "${V1A_WT:-/nonexistent}/vt-probe.json" 2>/dev/null || echo '{}')
check "v1a: the agent ran as Ana's own system user" "$(echo "$V1A_PROBE" | json 'd.user')" "vt-agent-ana"
check "v1a: it sees no other user's processes (so no other run's token on a command line)" "$(echo "$V1A_PROBE" | json 'd.otherProcesses')" "0"
check "v1a: Paperclip's master key, signing keys, config and .env are refused" "$(echo "$V1A_PROBE" | json "['master.key','decision-signing.key','config.json','.env'].map(f=>d['read:$V1A_PC/'+(f.endsWith('.key')?'secrets/':'')+f]).join()")" "refused,refused,refused,refused"
check "v1a: Bo's files and the SSH keys are refused" "$(echo "$V1A_PROBE" | json "[d['read:/home/vt-agent-bo/.bashrc'],d['read:$SSHBED/keys/ana-run'],d['read:$SSHBED/keys/bo-checks']].join()")" "refused,refused,refused"
check "v1a: Paperclip's data folders, the repositories and Bo's home cannot be listed" "$(echo "$V1A_PROBE" | json "['$V1A_D/it','$V1A_D/it-repos','$V1A_PC/logs','$V1A_PC/data','/home/vt-agent-bo'].map(x=>d['list:'+x]).join()")" "refused,refused,refused,refused,refused"
check "v1a: its own run token works (control: it may read its own agent)" "$(echo "$V1A_PROBE" | json 'd.meApi')" "200"
check "v1a: ...but cannot list the company's secrets" "$(echo "$V1A_PROBE" | json 'd.secretApi')" "403"
check "v1a: inside its run, Paperclip refuses it the link signing key and the checks keys" "$(echo "$V1A_PROBE" | json "['vt-link-signing','vt-checks-key-bo','vt-checks-key-ana'].map(k=>d['agentSecret:'+k]).join()")" "403,403,403"
check "v1a: no Paperclip secret is handed to it (environment names)" "$(echo "$V1A_PROBE" | json "d.envNames.split(' ').filter(n=>!n.startsWith('VT_PROBE_')&&/SECRET|BETTER_AUTH|JWT|DATABASE|MASTER|SIGN|GITHUB_TOKEN|SMTP/.test(n)).join()||'none'")" "none"
check "v1a: the signing key's value appears nowhere in what came back" "$(grep -rlF "$V1A_SIGN_VALUE" "$V1A_WT" 2>/dev/null | wc -l | tr -d ' ')" "0"
api PATCH "/api/issues/$V1A_ISS" '{"status":"done"}'

echo "-- the checks gate runs as Ana's agent user, never as Paperclip's"
api GET "/api/companies/$V1A_CID/heartbeat-runs"
V1A_RUN=$(echo "$API_BODY" | json "(Array.isArray(d)?d:d.items).filter(r=>r.agentId==='$V1A_A').map(r=>r.id)[0] || ''")
api POST /api/plugins/tools/execute "{\"tool\":\"$PLUGIN_KEY:run_checks\",\"parameters\":{\"issueId\":\"$V1A_ISS\"},\"runContext\":{\"agentId\":\"$V1A_A\",\"runId\":\"$V1A_RUN\",\"companyId\":\"$V1A_CID\",\"projectId\":\"$V1A_PID\"}}"
check "v1a: tests ran as an owner's agent user (the test passes only there)" "$(echo "$API_BODY" | json 'd.result.data.results.find(r=>r.name==="tests").status')" "passed"
check "v1a: agent-written check code cannot read Paperclip's master key" "$(echo "$API_BODY" | json 'd.result.data.results.find(r=>r.name==="lint").status')" "passed"
V1A_RC=0; printf 'hi' | sshbed_ssh vt-agent-ana ana-checks "bash -i" >/dev/null 2>&1 || V1A_RC=$?
check "v1a: the checks key can only start the runner (anything else is a bad request)" "$V1A_RC" "2"
V1A_RC=0; sshbed_ssh vt-agent-ana bo-run true >/dev/null 2>&1 || V1A_RC=$?
check "v1a: Bo's key does not open Ana's user" "$V1A_RC" "255"

echo "-- with isolation required, test commands never run as Paperclip's own user"
api POST "/api/plugins/$PLUGIN_ID/config" "{\"companyId\":\"$V1A_CID\",\"configJson\":{\"serviceUserId\":\"$IT_SERVICE_USER\",\"checks\":{\"testCommand\":\"true\"},\"people\":$V1A_PEOPLE}}"
api POST /api/plugins/tools/execute "{\"tool\":\"$PLUGIN_KEY:run_checks\",\"parameters\":{\"issueId\":\"$V1A_ISS\"},\"runContext\":{\"agentId\":\"$V1A_A\",\"runId\":\"$V1A_RUN\",\"companyId\":\"$V1A_CID\",\"projectId\":\"$V1A_PID\"}}"
check "v1a: without a checks sandbox the commands are refused, not run" "$(echo "$API_BODY" | json 'd.result.data.results.find(r=>r.name==="tests").summary')" "not run: the checks sandbox is not configured (commands never run as Paperclip's own user)"
api PATCH "/api/issues/$V1A_ISS" '{"status":"done"}'
unset V1A_SIGN_VALUE
# The SSH bed stays up for scripts/it/v1b.sh; the test script stops it at the end.
