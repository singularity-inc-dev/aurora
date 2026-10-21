import { describe, expect, it } from "vitest";
import { isForbiddenFileName, redact, scanAddedLines, scanLine } from "../src/secretscan.js";
import { fakeGithubToken } from "./helpers.js";

const fakes: Record<string, string> = {
  "github-token": fakeGithubToken(),
  "aws-access-key": ["AK", "IA"].join("") + "ABCDEFGHIJKLMNOP",
  "private-key": ["-----BEGIN RSA ", "PRIVATE KEY-----"].join(""),
  "anthropic-key": ["sk-", "ant-"].join("") + "x".repeat(30),
  "generic-assignment": `api_key = "${"z".repeat(20)}"`,
};

describe("secret scan", () => {
  it.each(Object.entries(fakes))("detects %s", (rule, text) => {
    expect(scanLine(`const v = ${text};`)?.id).toBe(rule);
  });

  it("ignores ordinary code", () => {
    expect(scanLine("const token = getToken();")).toBeUndefined();
    expect(scanLine("password: process.env.DB_PASSWORD")).toBeUndefined();
  });

  it("reports location and rule but never the value", () => {
    const findings = scanAddedLines([{ file: "a.ts", line: 3, text: fakes["github-token"]! }]);
    expect(findings).toEqual([{ file: "a.ts", line: 3, rule: "github-token" }]);
    expect(JSON.stringify(findings)).not.toContain(fakes["github-token"]);
  });

  it("redacts secrets from free text", () => {
    const out = redact(`error: bad token ${fakes["github-token"]} rejected`);
    expect(out).not.toContain(fakes["github-token"]);
    expect(out).toContain("[redacted:github-token]");
  });

  it.each([
    [".env", true],
    ["config/.env.production", true],
    [".env.example", false],
    ["certs/server.pem", true],
    ["src/env.ts", false],
  ])("forbidden file name %s -> %s", (file, expected) => {
    expect(isForbiddenFileName(file)).toBe(expected);
  });
});
