import { describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript test helper
import { audit } from "../../scripts/rehearsal/otlp-audit.mjs";

const line = (url: string, body: unknown) => JSON.stringify({ url, contentType: "application/json", body: typeof body === "string" ? body : JSON.stringify(body) });
const kv = (key: string, v: string) => ({ key, value: { stringValue: v } });
const traces = (attrs: ReturnType<typeof kv>[]) => ({ resourceSpans: [{ resource: { attributes: [kv("service.name", "paperclip")] }, scopeSpans: [{ scope: { name: "better-auth" }, spans: [{ name: "x", attributes: attrs }] }] }] });
const canaries = { "the GitHub token": "ghp_CanaryValue123456", "the owner's email": "owner@example.com", "a password": "pa55word-Canary" };

describe("the OTLP audit (it must not give false comfort)", () => {
  it("reports an empty sink as nothing received", () => {
    expect(audit("", canaries)).toMatchObject({ requests: 0, spans: 0, attributeKeys: [], leaked: [] });
  });

  it("counts requests, paths, spans and attribute names", () => {
    const text = [line("/v1/traces", traces([kv("http.route", "/api/x")])), line("/v1/metrics", { resourceMetrics: [{ resource: { attributes: [kv("service.name", "paperclip")] } }] })].join("\n");
    const r = audit(text, canaries);
    expect(r.requests).toBe(2);
    expect(r.paths).toEqual({ "/v1/traces": 1, "/v1/metrics": 1 });
    expect(r.spans).toBe(1);
    expect(r.attributeKeys).toEqual(["http.route", "service.name"]);
    expect(r.scopes).toEqual(["better-auth"]);
    expect(r.leaked).toEqual([]);
  });

  it("lists the sources of spans and the distinct error messages, so a new source or a chatty message is noticed", () => {
    const body = { resourceSpans: [{ scopeSpans: [{ scope: { name: "http" }, spans: [{ attributes: [], events: [{ attributes: [kv("exception.message", "Invalid email or password")] }] }] }] }] };
    const r = audit(line("/v1/traces", body), canaries);
    expect(r.scopes).toEqual(["http"]);
    expect(r.exceptionMessages).toEqual(["Invalid email or password"]);
  });

  it("catches a secret in a span attribute, by name, without repeating its value", () => {
    const r = audit(line("/v1/traces", traces([kv("db.statement", "SELECT 1 -- ghp_CanaryValue123456")])), canaries);
    expect(r.leaked).toEqual(["the GitHub token"]);
    expect(JSON.stringify(r)).not.toContain("ghp_CanaryValue");
  });

  it("catches an email in a URL path or query, even URL-encoded", () => {
    expect(audit(line("/v1/traces", traces([kv("url.full", "http://x/api?u=owner%40example.com")])), canaries).leaked).toEqual(["the owner's email"]);
    expect(audit(line("/v1/traces", traces([kv("url.path", "/api/owner@example.com")])), canaries).leaked).toEqual(["the owner's email"]);
  });

  it("catches a value that was base64-encoded", () => {
    const b64 = Buffer.from("pa55word-Canary").toString("base64");
    expect(audit(line("/v1/traces", traces([kv("http.header.authorization", `Basic ${b64}`)])), canaries).leaked).toEqual(["a password"]);
  });

  it("catches a leak in a request that is not JSON at all", () => {
    const r = audit(line("/v1/traces", "binary\u0000pa55word-Canary\u0000"), canaries);
    expect(r.leaked).toEqual(["a password"]);
    expect(r.notJson).toBe(1);
  });

  it("ignores empty or very short canaries (they would match everything)", () => {
    expect(audit(line("/v1/traces", traces([kv("a", "abc")])), { empty: "", short: "abc" }).leaked).toEqual([]);
  });

  it("does not report a canary that is simply not there", () => {
    expect(audit(line("/v1/traces", traces([kv("http.route", "/api/health")])), canaries).leaked).toEqual([]);
  });
});
