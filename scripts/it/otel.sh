# Tracing: the kit pins Paperclip's OpenTelemetry add-ons exactly, and vt-tracing
# writes a safe, root-only setting. (The test that nothing sensitive leaves Paperclip
# runs in the deployment rehearsal, scripts/deploy-rehearsal.sh, "tracing".)
# Sourced by scripts/integration-test.sh; needs nothing from the other scripts.

echo "-- the pinned OpenTelemetry packages are exactly the ones Paperclip asks for"
OTEL_VERSIONS=$(node -e '
const fs=require("fs");
const root=process.argv[1];
const pkg=JSON.parse(fs.readFileSync(root+"/deploy/paperclip/package.json","utf8")).dependencies;
const lock=fs.readFileSync(root+"/deploy/paperclip/pnpm-lock.yaml","utf8");
const block=lock.split("\n  \x27@paperclipai/server@")[1]||"";
const peers={};
for (const m of block.split("\n    peerDependenciesMeta:")[0].matchAll(/^      \x27?(@opentelemetry\/[a-z-]+)\x27?: (\S+)$/gm)) peers[m[1]]=m[2].replace(/\x27/g,"");
const wrong=[];
for (const name of ["@opentelemetry/sdk-node","@opentelemetry/auto-instrumentations-node","@opentelemetry/exporter-trace-otlp-http","@opentelemetry/resources","@opentelemetry/semantic-conventions"]) if (!peers[name] || pkg[name]!==peers[name]) wrong.push(name+" pinned "+pkg[name]+" wants "+peers[name]);
console.log(wrong.length? wrong.join("; ") : "same");
' "$ROOT")
check "otel: the kit pins each add-on at the exact version Paperclip's package.json lists as its peer" "$OTEL_VERSIONS" "same"
check "otel: the lockfile resolves them (frozen installs get exactly these)" "$([ "$(grep -c "^  '@opentelemetry/sdk-node@0.221.0'\|^  '@opentelemetry/exporter-trace-otlp-http@0.221.0'" "$ROOT/deploy/paperclip/pnpm-lock.yaml")" -ge 2 ] && echo yes || echo no)" "yes"
check "otel: Paperclip's service file reads the optional tracing file (and starts without it)" "$(grep -c '^EnvironmentFile=-@ETC@/tracing.env$' "$ROOT/deploy/systemd/paperclip.service")" "1"

echo "-- vt-tracing"
OTEL_T=$(mktemp -d)
OTEL_ENV="$OTEL_T/etc/vision-and-tom/tracing.env"
vt_tracing() { VT_ROOT="$OTEL_T" VT_REHEARSAL=1 bash "$ROOT/deploy/bin/vt-tracing" "$@"; }
OTEL_SECRET="Authorization=Basic Q0FOQVJZLU9URUwtU0VDUkVU"
check "otel: tracing starts off" "$(vt_tracing status 2>&1)" "Tracing is OFF."
check "otel: a name that would send traces off the server is refused" "$(vt_tracing on --endpoint http://tracing.example.com:4318 --no-restart 2>&1 | grep -c 'would leave this server')/$([ -f "$OTEL_ENV" ] && echo wrote || echo none)" "1/none"
check "otel: gRPC and odd protocols are refused" "$(vt_tracing on --endpoint http://127.0.0.1:4318 --protocol grpc --no-restart 2>&1 | grep -c 'http/json or http/protobuf')" "1"
check "otel: quotes and spaces in the address are refused" "$(vt_tracing on --endpoint 'http://127.0.0.1:4318 "x"' --no-restart 2>&1 | grep -c 'must look like')" "1"
check "otel: a name with odd characters is refused" "$(vt_tracing on --endpoint http://127.0.0.1:4318 --service-name 'a b;c' --no-restart 2>&1 | grep -c 'letters, digits')" "1"
OTEL_OUT=$(printf '%s\n' "$OTEL_SECRET" | vt_tracing on --endpoint http://127.0.0.1:4318 --headers-stdin --no-restart 2>&1)
check "otel: on saves the setting, root-only" "$(stat -c %a "$OTEL_ENV")" "600"
check "otel: it sends only the service name and version (no host, user, process or paths) and no metrics or logs" "$(grep -c '^OTEL_NODE_RESOURCE_DETECTORS=env$' "$OTEL_ENV")/$(grep -c '^OTEL_METRICS_EXPORTER=none$' "$OTEL_ENV")/$(grep -c '^OTEL_LOGS_EXPORTER=none$' "$OTEL_ENV")" "1/1/1"
check "otel: the header was read from standard input and is never printed" "$(echo "$OTEL_OUT" | grep -c 'Q0FOQVJZ')/$(vt_tracing status | grep -c 'Q0FOQVJZ')/$(vt_tracing status | grep -c 'saved, hidden')" "0/0/1"
check "otel: status says it is on" "$(vt_tracing status | head -1)" "Tracing is ON."
vt_tracing on --endpoint http://localhost:4318 --protocol http/protobuf --with-metrics --no-restart >/dev/null 2>&1
check "otel: turning it on again replaces the setting (and --with-metrics lets host metrics through; old header is gone)" "$(grep -c 'OTEL_METRICS_EXPORTER' "$OTEL_ENV")/$(grep -c 'OTEL_EXPORTER_OTLP_HEADERS' "$OTEL_ENV")/$(grep -c 'http/protobuf' "$OTEL_ENV")" "0/0/1"
vt_tracing on --endpoint http://tracing.example.com:4318 --allow-remote --no-restart >/dev/null 2>&1
check "otel: a remote address needs --allow-remote and then works" "$(grep -c 'tracing.example.com' "$OTEL_ENV")" "1"
vt_tracing off --no-restart >/dev/null 2>&1
check "otel: off removes the file and status says off" "$(vt_tracing status 2>&1)" "Tracing is OFF."
rm -rf "$OTEL_T"
