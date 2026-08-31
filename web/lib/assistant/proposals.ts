import "server-only";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { env } from "@openbooks/engine/src/db.ts";
import type { Authz } from "../authz";

/**
 * HMAC-signed write proposals. A draft tool builds a
 * `preview` and signs it; the commit route re-hashes the client-returned
 * preview and rejects any tampering or expiry. The signing key is derived from
 * SESSION_SECRET (the same secret the session cookie uses) — no new env var,
 * no secret in the DB.
 */

let cachedKey: Buffer | undefined;

function proposalKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (!env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is required to sign assistant write proposals");
  }
  cachedKey = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(env.SESSION_SECRET),
      Buffer.alloc(0),
      Buffer.from("openbooks.proposal.v1"),
      32,
    ),
  );
  return cachedKey;
}
const TTL_MS = 15 * 60 * 1000; // a draft is good for 15 minutes

export type ProposalKind = "create_journal_entry";

export type JournalLinePreview = {
  accountId: string;
  /** "5100 · Equipment rentals" — resolved server-side so the card is readable. */
  accountLabel: string;
  description: string | null;
  /** Signed base amount: + debit / − credit (matches document_lines.amount). */
  amount: string;
};

export type JournalPreview = {
  documentDate: string;
  memo: string | null;
  lines: JournalLinePreview[];
};

/** Deterministic JSON (recursively sorted keys) so a re-sent preview hashes the
 *  same on the server regardless of property order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",")}}`;
}

function hmacHex(body: string): string {
  return createHmac("sha256", proposalKey()).update(body).digest("hex");
}

export function signProposal(kind: ProposalKind, preview: unknown, authz: Authz): string {
  const exp = Date.now() + TTL_MS;
  const sig = hmacHex(
    canonical({ kind, preview, userId: authz.user.id, orgId: authz.user.orgId, exp }),
  );
  return Buffer.from(JSON.stringify({ exp, sig })).toString("base64url");
}

export function verifyProposal(
  kind: ProposalKind,
  preview: unknown,
  token: string,
  authz: Authz,
): boolean {
  let parsed: { exp?: number; sig?: string };
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (typeof parsed.exp !== "number" || typeof parsed.sig !== "string") return false;
  if (Date.now() > parsed.exp) return false;
  const expected = hmacHex(
    canonical({ kind, preview, userId: authz.user.id, orgId: authz.user.orgId, exp: parsed.exp }),
  );
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parsed.sig, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
