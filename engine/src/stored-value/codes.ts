import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Gift card codes. Sixteen random characters from an unambiguous alphabet
 * (no 0/O, 1/I/L) shown grouped as XXXX-XXXX-XXXX-XXXX and revealed exactly
 * once at issuance. Only a salted SHA-256 digest is stored: the code cannot
 * be recovered from the database, and support looks balances up by code
 * without ever seeing another account's secret.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_GROUPS = 4;
const CODE_GROUP_LEN = 4;

export function generateStoredValueCode(): string {
  const bytes = randomBytes(CODE_GROUPS * CODE_GROUP_LEN);
  const chars: string[] = [];
  for (const byte of bytes) {
    chars.push(CODE_ALPHABET[byte! % CODE_ALPHABET.length]!);
  }
  const groups: string[] = [];
  for (let group = 0; group < CODE_GROUPS; group++) {
    groups.push(chars.slice(group * CODE_GROUP_LEN, (group + 1) * CODE_GROUP_LEN).join(""));
  }
  return groups.join("-");
}

/** Canonical form for hashing and comparison: uppercase, separators stripped. */
export function normalizeStoredValueCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Per-org salted digest. The org id is a uniqueness salt, not a secret —
 * secrecy comes from the 80 bits of code entropy. Salting keeps one code's
 * digest from matching across organizations.
 */
export function hashStoredValueCode(orgId: string, code: string): string {
  return createHash("sha256").update(`${orgId}:${normalizeStoredValueCode(code)}`, "utf8").digest("hex");
}

export function codeLast4(code: string): string {
  const normalized = normalizeStoredValueCode(code);
  return normalized.slice(-4);
}

/**
 * Constant-time digest comparison so a lookup does not leak how much of a
 * guessed code is right through timing.
 */
export function digestsEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
