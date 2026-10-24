/**
 * Small built-in secret scanner. Findings name the file, line and rule only;
 * the matched text is never returned, logged or written to a report.
 */
export interface SecretRule {
  id: string;
  description: string;
  pattern: RegExp;
}

export const SECRET_RULES: readonly SecretRule[] = [
  { id: "private-key", description: "Private key block", pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ },
  { id: "aws-access-key", description: "AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "github-token", description: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { id: "slack-token", description: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "stripe-key", description: "Stripe secret key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  { id: "google-api-key", description: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "anthropic-key", description: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "openai-key", description: "OpenAI API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  {
    id: "generic-assignment",
    description: "Hard-coded secret assignment",
    pattern: /\b(?:api[_-]?key|secret|token|passw(?:or)?d|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i,
  },
];

/** File names that should never be committed, whatever their content. */
const FORBIDDEN_FILE_RE = /(^|\/)(\.env(\..+)?|id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.key)$/;
const ALLOWED_ENV_TEMPLATES = /(^|\/)\.env\.(example|sample|template)$/;

export interface SecretFinding {
  file: string;
  line: number | null;
  rule: string;
}

export function scanLine(text: string): SecretRule | undefined {
  return SECRET_RULES.find((r) => r.pattern.test(text));
}

export function isForbiddenFileName(file: string): boolean {
  return FORBIDDEN_FILE_RE.test(file) && !ALLOWED_ENV_TEMPLATES.test(file);
}

export interface AddedLine {
  file: string;
  line: number;
  text: string;
}

export function scanAddedLines(lines: Iterable<AddedLine>): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const l of lines) {
    const rule = scanLine(l.text);
    if (rule) findings.push({ file: l.file, line: l.line, rule: rule.id });
  }
  return findings;
}

export function scanFileNames(files: Iterable<string>): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const f of files) if (isForbiddenFileName(f)) findings.push({ file: f, line: null, rule: "forbidden-file" });
  return findings;
}

/** Replace anything that looks like a secret in free text (e.g. test output). */
export function redact(text: string): string {
  let out = text;
  for (const rule of SECRET_RULES) {
    const global = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g");
    out = out.replace(global, `[redacted:${rule.id}]`);
  }
  return out;
}
