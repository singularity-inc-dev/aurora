// Looks at everything an OTLP sink received and reports: how much arrived, which
// attribute names appeared, and which canary values (secrets, emails, names) leaked.
// It reports canary NAMES only, never their values.
// Usage: node otlp-audit.mjs SINK_FILE CANARIES_JSON     (CANARIES_JSON: {"name": "value", ...}, mode 600)
import { readFileSync, existsSync } from "node:fs";

/** @param {string} text lines of {url, contentType, body}; @param {Record<string,string>} canaries */
export function audit(text, canaries) {
  const requests = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const paths = {};
  const attributeKeys = new Set();
  const scopes = new Set();
  const exceptionMessages = new Set();
  let spans = 0;
  let notJson = 0;
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object") {
      if (typeof o.key === "string" && "value" in o) {
        attributeKeys.add(o.key);
        if (o.key === "exception.message" && typeof o.value?.stringValue === "string") exceptionMessages.add(o.value.stringValue.slice(0, 120));
      }
      if (o.scope && typeof o.scope.name === "string") scopes.add(o.scope.name);
      if (Array.isArray(o.spans)) spans += o.spans.length;
      Object.values(o).forEach(walk);
    }
  };
  const haystack = [];
  for (const r of requests) {
    paths[r.url] = (paths[r.url] ?? 0) + 1;
    haystack.push(r.url, r.body);
    try {
      walk(JSON.parse(r.body));
    } catch {
      notJson += 1;
    }
  }
  const all = haystack.join("\n");
  // A value counts as leaked when it appears as is, URL-encoded or base64-encoded.
  const forms = (v) => [v, encodeURIComponent(v), Buffer.from(v).toString("base64").replace(/=+$/, "")];
  const leaked = Object.entries(canaries)
    .filter(([, v]) => v && v.length >= 4 && forms(v).some((f) => f && all.includes(f)))
    .map(([name]) => name);
  return { requests: requests.length, paths, spans, scopes: [...scopes].sort(), attributeKeys: [...attributeKeys].sort(), exceptionMessages: [...exceptionMessages].sort().slice(0, 20), leaked, notJson };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [sink, canaryFile] = process.argv.slice(2);
  const text = existsSync(sink) ? readFileSync(sink, "utf8") : "";
  console.log(JSON.stringify(audit(text, JSON.parse(readFileSync(canaryFile, "utf8")))));
}
