// A stand-in for Jaeger or Langfuse in tests: accepts OTLP over HTTP on 127.0.0.1 and
// appends every request (path + body, one JSON per line) to a file. Stores what it is
// sent so the audit (otlp-audit.mjs) can look for anything that must not be there.
// Usage: node otlp-sink.mjs PORT FILE
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const [port, file] = process.argv.slice(2);
createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    appendFileSync(file, JSON.stringify({ url: req.url, contentType: req.headers["content-type"] ?? null, body: Buffer.concat(chunks).toString("utf8") }) + "\n", { mode: 0o600 });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
}).listen(Number(port), "127.0.0.1");
