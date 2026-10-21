import { createHmac, timingSafeEqual } from "node:crypto";

export type LinkKind = "approve" | "reject";

/** What a morning-email link may do. Signed; the plugin also checks it against its database. */
export interface LinkClaims {
  v: 1;
  /** Link action id (one per task and kind). */
  a: string;
  /** Company id. */
  c: string;
  /** Owner email. */
  o: string;
  /** Task (issue) id. */
  t: string;
  k: LinkKind;
  /** Expiry, seconds since epoch. */
  e: number;
}

export type VerifyResult = { ok: true; claims: LinkClaims } | { ok: false; reason: "invalid" | "expired" };

const b64url = (buf: Buffer) => buf.toString("base64url");

function sign(payload: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(payload).digest());
}

export function signLink(claims: LinkClaims, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  return `${payload}.${sign(payload, secret)}`;
}

/** Read the claims without checking them (only to route the request to the right company). */
export function peekClaims(token: string): Partial<LinkClaims> | null {
  try {
    return JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function verifyLink(token: string, secret: string, now: Date): VerifyResult {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return { ok: false, reason: "invalid" };
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "invalid" };
  let claims: LinkClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const strings = [claims.a, claims.c, claims.o, claims.t].every((x) => typeof x === "string" && x.length > 0);
  if (claims.v !== 1 || !strings || (claims.k !== "approve" && claims.k !== "reject") || !Number.isInteger(claims.e)) {
    return { ok: false, reason: "invalid" };
  }
  if (claims.e * 1000 <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
