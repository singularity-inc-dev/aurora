# Thin version 1, piece B: each owner's agent on that owner's own Claude access
# (spec gap 2, owner's answer 5). Sourced by scripts/integration-test.sh after v1a.sh
# (it reuses v1a's company, agents and SSH bed; with IT_ONLY=v1b it runs v1a first).
#
# - Ana uses her own subscription: her own SSH key may only start Claude Code's own
#   sign-in (deploy/bin/vt-claude-login) as her agent's user, and the login stays in
#   that user's home. A stand-in plays Claude Code (scripts/it/lib/fake-claude-login).
# - Bo uses his own API key: a Paperclip secret he stored, bound by deploy/bin/vt-model-access.mjs.
# - Each agent's real run reports which account it used. Never one shared account.
# No real account and no network: the key is random text and the login a stand-in.

if [ -z "${V1A_CID:-}" ]; then . "$ROOT/scripts/it/v1a.sh"; fi
[ -n "${V1A_CID:-}" ] && [ -n "${SSHBED_KNOWN_HOSTS:-}" ] || { fail "v1b: needs the v1a test bed"; return 0; }
# Back to v1a's full settings (its last step left out the checks sandbox on purpose).
v1a_config "$V1A_PEOPLE"
v1b_access() { node "$ROOT/deploy/bin/vt-model-access.mjs" "$BASE" - "$V1A_CID" "$@" 2>&1 || true; }
v1b_run() { # agentId title -> prints the probe JSON the stand-in agent wrote
  api POST "/api/companies/$V1A_CID/issues" "{\"title\":\"$2\",\"projectId\":\"$V1A_PID\",\"assigneeAgentId\":\"$1\",\"status\":\"todo\",\"executionWorkspaceSettings\":{\"mode\":\"isolated_workspace\",\"workspaceStrategy\":{\"type\":\"git_worktree\",\"branchTemplate\":\"vt/{{issue.identifier}}-{{slug}}\"}}}"
  local iss wt="" ew
  iss=$(echo "$API_BODY" | json 'd.id')
  for _ in $(seq 1 90); do
    api GET "/api/issues/$iss"
    ew=$(echo "$API_BODY" | json 'd.executionWorkspaceId || ""')
    if [ -n "$ew" ]; then
      api GET "/api/execution-workspaces/$ew"
      wt=$(echo "$API_BODY" | json 'd.cwd')
      [ -n "$wt" ] && [ -f "$wt/vt-probe.json" ] && break
    fi
    sleep 2
  done
  api PATCH "/api/issues/$iss" '{"status":"done"}'
  cat "${wt:-/nonexistent}/vt-probe.json" 2>/dev/null || echo '{}'
}

echo "-- Ana chooses her own Claude subscription"
check "v1b: vt-model-access records Ana's choice" "$(v1b_access ana@example.com subscription | json 'd.ok && d.modelAccess')" "subscription"
# Her own SSH key may only start the sign-in (the test copy runs the stand-in instead of Claude Code).
sed -e "s#^CLAUDE=.*#CLAUDE=\"$ROOT/scripts/it/lib/fake-claude-login\"#" "$ROOT/deploy/bin/vt-claude-login" >"$SSHBED/vt-claude-login" && chmod 755 "$SSHBED/vt-claude-login"
sshbed_key ana-owner
printf 'restrict,pty,command="%s" %s vt-owner-login\n' "$SSHBED/vt-claude-login" "$(cut -d' ' -f1-2 "$SSHBED/keys/ana-owner.pub")" >>"$SSHBED_AUTH_DIR/vt-agent-ana"
V1B_LOGIN=$(printf 'code-from-the-sign-in-page\n' | sshbed_ssh vt-agent-ana ana-owner 2>&1 || true)
check "v1b: Ana signs in herself through Claude Code's own sign-in, on her agent's user" "$(echo "$V1B_LOGIN" | grep -c 'Login successful')" "1"
V1B_RC=0; sshbed_ssh vt-agent-ana ana-owner "cat /etc/passwd" >/dev/null 2>&1 || V1B_RC=$?
check "v1b: her key can do nothing else (no shell, no other command)" "$V1B_RC" "2"
check "v1b: the login is in her agent's home, readable by that user only" "$(stat -c '%U %a' /home/vt-agent-ana/.claude/.vt-standin-login 2>/dev/null)" "vt-agent-ana 600"

echo "-- Bo chooses his own API key, stored as his own Paperclip secret"
V1B_KEY="sk-ant-standin-$(node -e "process.stdout.write(require('crypto').randomBytes(12).toString('hex'))")"
api POST "/api/companies/$V1A_CID/secrets" "{\"name\":\"Bo's Anthropic key\",\"key\":\"anthropic-api-key-bo\",\"value\":\"$V1B_KEY\"}"
check "v1b: vt-model-access points Bo's agent at his own secret" "$(v1b_access bo@example.com api-key anthropic-api-key-bo | json 'd.ok && d.modelAccess')" "api-key"
check "v1b: Bo's key cannot be given to Ana's agent too (never one shared account)" "$(v1b_access ana@example.com api-key anthropic-api-key-bo | json 'd.message')" "that secret is already bo@example.com's key (never one shared account)"
v1a_audit
check "v1b: the audit passes for both owners' access" "$(echo "$API_BODY" | json 'd.data.ok')" "true"

echo "-- each agent's real run uses its own owner's access"
# Bo's agent also tries to read Ana's login.
api GET "/api/agents/$V1A_B"
api PATCH "/api/agents/$V1A_B" "$(echo "$API_BODY" | json "({adapterConfig:{...d.adapterConfig,env:{...d.adapterConfig.env,VT_PROBE_FILES:'/home/vt-agent-ana/.claude/.vt-standin-login'}}})")"
V1B_ANA=$(v1b_run "$V1A_A" "Which account does Ana's agent use")
check "v1b: Ana's agent uses Ana's own subscription login" "$(echo "$V1B_ANA" | json 'd.user+" "+d.access+" "+d.identity')" "vt-agent-ana subscription vt-agent-ana-subscription-code-from-the-sign-in-page"
V1B_BO=$(v1b_run "$V1A_B" "Which account does Bo's agent use")
check "v1b: Bo's agent uses Bo's own API key" "$(echo "$V1B_BO" | json 'd.user+" "+d.access+" "+d.identity')" "vt-agent-bo api-key key-$(printf '%s' "$V1B_KEY" | sha256sum | cut -c1-12)"
check "v1b: Bo's agent cannot read Ana's login" "$(echo "$V1B_BO" | json "d['read:/home/vt-agent-ana/.claude/.vt-standin-login']")" "refused"
check "v1b: the key's value is in nothing that came back" "$(echo "$V1B_ANA$V1B_BO" | grep -cF "$V1B_KEY" | tr -d ' ')" "0"

echo "-- the audit refuses a shared or misplaced account"
api GET "/api/agents/$V1A_A"
api PATCH "/api/agents/$V1A_A" "$(echo "$API_BODY" | json "({adapterConfig:{...d.adapterConfig,env:{...d.adapterConfig.env,ANTHROPIC_API_KEY:'sk-typed-into-the-settings'}}})")"
v1a_audit
check "v1b: a key typed into Ana's agent while she uses her subscription is flagged" "$(echo "$API_BODY" | json "d.data.agents.find(a=>a.email==='ana@example.com').problems.join().includes('uses their own subscription')")" "true"
v1b_access ana@example.com subscription >/dev/null
api GET "/api/agents/$V1A_A"
check "v1b: choosing again removes it" "$(echo "$API_BODY" | json '"ANTHROPIC_API_KEY" in (d.adapterConfig.env||{}) ? "still there" : "removed"')" "removed"
unset V1B_KEY
