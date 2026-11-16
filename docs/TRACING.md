# Tracing: Paperclip's built-in OpenTelemetry export

OpenTelemetry is a standard for sending **traces** (the timeline of one action) from a program to a viewer.
Paperclip 2026.1012.0 has an exporter built in. This kit turns it on with one command and sends it to a
viewer **on the same server**: Jaeger (recommended) or Langfuse.

## Read this first (what you actually get)

Measured on the real stack (Paperclip in authenticated mode behind Caddy, the deployment rehearsal):

1. **It does not show your handovers.** In this Paperclip version the only traces come from Paperclip's
   **sign-in library** (better-auth): sign-in, sign-up, session checks, and the database lookups behind them.
   Web requests, agent runs, plugin calls and handover steps create **no spans**. Paperclip's own run spans
   exist only for sandbox and native-runner paths, which our local Claude agents do not use. So Jaeger will answer
   "who signed in and what failed", not "where is my handover stuck".
2. **Metrics exist but are off.** Paperclip also exports host metrics (event loop, memory, garbage collection).
   Jaeger and Langfuse take traces only, so the switch leaves metrics off unless you pass `--with-metrics`.
3. **Langfuse is the wrong fit today.** It is built for model traces (prompts, tokens, cost). Paperclip sends none, so it
   would show only sign-in noise, and a self-hosted Langfuse needs Postgres, ClickHouse, Redis and S3 storage:
   too heavy for the minimum server (2 vCPU, 4 GB). Use Jaeger.
4. **Nothing in the other direction is traced.** The email service, the plugin and GitHub calls are not instrumented,
   and there is no shared id across them (design note: docs/design/FRAMEWORKS.md, item 8). That is a separate, later job.

The first spike (Paperclip in local trusted mode, no sign-in library) showed no spans at all; the authenticated stack
does. Everything below is from the authenticated stack.

## Turn it on

Tracing is **off** unless the file `/etc/vision-and-tom/tracing.env` exists.

```bash
sudo vt-tracing on --endpoint http://127.0.0.1:4318
sudo vt-tracing status
sudo vt-tracing off
```

`on` restarts Paperclip (add `--no-restart` to do it later). It writes these settings, readable by root only:

| Setting | Why |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL` | where to send, `http/json` by default (`--protocol http/protobuf` also works; gRPC is not offered) |
| `OTEL_SERVICE_NAME=paperclip` | the name in the viewer (`--service-name` changes it) |
| `OTEL_NODE_RESOURCE_DETECTORS=env` | send **only** the service name and version. Without it every trace carries the host name, machine id, user name, process id and install folder (measured) |
| `OTEL_METRICS_EXPORTER=none`, `OTEL_LOGS_EXPORTER=none` | traces only |

The address must be on this server (`127.0.0.1` or `localhost`). Anything else is refused unless you add `--allow-remote`.

### Jaeger on the same server (recommended)

Not run in this repository (no Jaeger here); follow Jaeger's own install guide, then check three things:

1. Its OTLP **HTTP** receiver listens on `127.0.0.1:4318`, and its web page on `127.0.0.1:16686`. Neither goes through Caddy
   and neither is opened in the firewall. Reach the page with an SSH tunnel: `ssh -L 16686:127.0.0.1:16686 you@your-server`.
2. It keeps traces in memory or on disk **with a short retention** (days, not months).
3. It runs as its own system user, not as `paperclip`.

Then `sudo vt-tracing on --endpoint http://127.0.0.1:4318`.

### Langfuse on the same server (possible, not recommended; not tested here)

```bash
printf '%s\n' 'Authorization=Basic%20<base64 of publicKey:secretKey>' | sudo vt-tracing on --endpoint http://127.0.0.1:3000/api/public/otel --headers-stdin
```

The keys are read from standard input, so they are not in `ps` or your shell history. They are stored in
`tracing.env` (root only) and are in Paperclip's environment, so use a Langfuse project made only for this. The spec for this
setting percent-encodes header values (a space is `%20`); check Langfuse's current OpenTelemetry page for the exact header and endpoint.

## Is anything secret or personal in the traces? Tested, with canary values

`scripts/deploy-rehearsal.sh` (section 16, also run by the full live suite) runs the whole deployment: sign-ins, invites, an
agent's handover, approvals, backup and restore. A stand-in for Jaeger records **everything** Paperclip sends. An auditor
(`scripts/rehearsal/otlp-audit.mjs`, itself unit-tested with deliberately leaky payloads) then looks for **canary values**,
as written, URL-encoded and base64-encoded:

the GitHub token, the SMTP password, the owner's and invitee's passwords, the board API key, an invite token, the owner's
and invitees' email addresses, a stranger's email, password and name (used in sign-in and sign-up calls, where a library might
echo input back), this machine's host name and the install folder.

Result on 2026.1012.0 (122 checks pass in the rehearsal):

- **Nothing leaked**, in the shipped setting and with metrics switched on.
- **Only these names appear** on traces: `http.route` (a template such as `/sign-in/email`, never the real URL or query),
  `better_auth.operation_id`, `db.operation.name`, `db.collection.name` (a table name, never a statement or value),
  and on failures `exception.type`, `exception.message`, `exception.stacktrace`. With metrics on, also event-loop, garbage-collection and memory names.
- **Only the service name and version** describe the program: no host, machine id, user or folder.
- The error messages seen were `Invalid email or password` and `User already exists. Use another email.` (fixed text).

The test fails, on purpose, if Paperclip ever sends a **new source of spans or a new attribute name**, so a person looks before
that data goes anywhere.

### What this does not prove

- **Error text is free text from libraries.** `exception.message` and `exception.stacktrace` could carry something sensitive
  in a flow the test did not drive. The test drives the usual sign-in and sign-up failures only.
- A different Paperclip version can send different data. The kit pins 2026.1012.0 and the exact OpenTelemetry packages it asks for;
  `scripts/it/otel.sh` fails if the two drift apart. Re-run the rehearsal before any Paperclip upgrade.
- **Do not add Node's generic auto-instrumentation** (`node --import ... auto-instrumentations-node/register`) to get
  request spans. That records full URLs and SQL text. It was not measured and is not supported by this kit.
- Anyone who can read the viewer sees what was sent. Keep it on 127.0.0.1, reach it through an SSH tunnel, set a short retention.

## The packages (and one open item)

`deploy/paperclip/package.json` now lists five `@opentelemetry/*` packages at **the exact versions Paperclip's own package.json
requires** (it checks them at start and ignores tracing if one is wrong): sdk-node 0.221.0, auto-instrumentations-node 0.79.0,
exporter-trace-otlp-http 0.221.0, resources 2.10.0, semantic-conventions 1.43.0. They do nothing unless `vt-tracing on` is run.

`pnpm audit --prod` on the kit's lockfile reports 6 advisories:
- 2 moderate (`minimatch`, `glob`) inside the Google Cloud resource detector of the OpenTelemetry bundle. That detector is not loaded
  with `OTEL_NODE_RESOURCE_DETECTORS=env`.
- **4 in Paperclip's own `better-auth` (1 critical, 1 high, 2 low), present before this change.** Not fixed here: the kit pins
  Paperclip, and these need a decision (override to a patched `better-auth` after a test, or wait for a Paperclip release).
