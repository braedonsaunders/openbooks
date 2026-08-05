import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function encodeBase32(input: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(value: string): Buffer | null {
  const clean = value.toUpperCase().replace(/[\s=-]/g, "");
  if (!clean) return null;
  let bits = 0;
  let current = 0;
  const bytes: number[] = [];
  for (const character of clean) {
    const index = BASE32.indexOf(character);
    if (index < 0) return null;
    current = (current << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((current >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function totpCode(
  secret: string,
  epochMs = Date.now(),
  options: { digits?: number; periodSeconds?: number } = {},
): { code: string; step: number } | null {
  const key = decodeBase32(secret);
  if (!key) return null;
  const digits = options.digits ?? 6;
  const periodSeconds = options.periodSeconds ?? 30;
  const step = Math.floor(epochMs / 1000 / periodSeconds);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = ((digest[offset] & 127) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3];
  return { code: String(binary % (10 ** digits)).padStart(digits, "0"), step };
}

function equalCode(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Accept one clock step either side, while rejecting replayed/older steps. */
export function verifyTotpCode(
  secret: string,
  supplied: string,
  epochMs = Date.now(),
  lastUsedStep: number | null = null,
): number | null {
  const normalized = supplied.replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(normalized)) return null;
  for (const offset of [-1, 0, 1]) {
    const candidate = totpCode(secret, epochMs + offset * 30_000);
    if (candidate && candidate.step > (lastUsedStep ?? -1) && equalCode(candidate.code, normalized)) {
      return candidate.step;
    }
  }
  return null;
}

export function totpProvisioningUri(input: { secret: string; email: string; issuer?: string }): string {
  const issuer = input.issuer?.trim() || "OpenBooks";
  const label = `${issuer}:${input.email}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = encodeBase32(randomBytes(8)).slice(0, 12);
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  });
}

export function normalizeRecoveryCode(value: string): string | null {
  const normalized = value.toUpperCase().replace(/[^A-Z2-7]/g, "");
  return normalized.length === 12 ? normalized : null;
}

/**
 * Recovery codes carry 60 random bits. Salted, versioned SHA-256 hashes keep
 * them independent of rotatable session-signing keys and prevent precomputed
 * tables if the database is disclosed.
 */
export function hashRecoveryCode(userId: string, normalizedCode: string): string {
  const salt = randomBytes(16);
  const digest = createHash("sha256")
    .update("openbooks:mfa-recovery:s1\0")
    .update(userId)
    .update("\0")
    .update(salt)
    .update(normalizedCode)
    .digest("hex");
  return `s1:${salt.toString("hex")}:${digest}`;
}

export function verifyRecoveryCodeHash(
  userId: string,
  normalizedCode: string,
  storedHash: string,
): boolean {
  const match = storedHash.match(/^s1:([0-9a-f]{32}):([0-9a-f]{64})$/i);
  if (!match) return false;
  const salt = Buffer.from(match[1], "hex");
  const expected = Buffer.from(match[2], "hex");
  const actual = createHash("sha256")
    .update("openbooks:mfa-recovery:s1\0")
    .update(userId)
    .update("\0")
    .update(salt)
    .update(normalizedCode)
    .digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
