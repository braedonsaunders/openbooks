import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { createKdfExecutor, KdfCapacityError } from "./auth-kdf-capacity";

const VERSION = "s2";
const RECOMMENDED_N = 16_384;
const RECOMMENDED_R = 8;
const RECOMMENDED_P = 1;
const SALT_BYTES = 16;
const HASH_BYTES = 64;
const passwordKdfExecutor = createKdfExecutor({ maxActive: 4, maxQueued: 32 });

type ParsedPasswordHash = {
  salt: Buffer;
  expected: Buffer;
  N: number;
  r: number;
  p: number;
  legacy: boolean;
};

function scryptAsync(
  password: string,
  salt: Buffer,
  length: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  const maxmem = Math.max(32 * 1024 * 1024, 128 * options.N * options.r + 1024 * 1024);
  return passwordKdfExecutor.run(
    () => new Promise((resolve, reject) => {
      scrypt(password, salt, length, { ...options, maxmem }, (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      });
    }),
  );
}

function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  const legacy = stored.match(/^([0-9a-f]{32}):([0-9a-f]{128})$/i);
  if (legacy) {
    return {
      salt: Buffer.from(legacy[1], "hex"),
      expected: Buffer.from(legacy[2], "hex"),
      N: RECOMMENDED_N,
      r: RECOMMENDED_R,
      p: RECOMMENDED_P,
      legacy: true,
    };
  }

  const versioned = stored.match(/^s2:(\d+):(\d+):(\d+):([0-9a-f]{32}):([0-9a-f]{128})$/i);
  if (!versioned) return null;
  const N = Number(versioned[1]);
  const r = Number(versioned[2]);
  const p = Number(versioned[3]);
  // Bound database-controlled work factors before allocating KDF memory.
  if (
    !Number.isSafeInteger(N)
    || N < 16_384
    || N > 262_144
    || (N & (N - 1)) !== 0
    || !Number.isSafeInteger(r)
    || r < 1
    || r > 16
    || !Number.isSafeInteger(p)
    || p < 1
    || p > 4
  ) return null;
  return {
    salt: Buffer.from(versioned[4], "hex"),
    expected: Buffer.from(versioned[5], "hex"),
    N,
    r,
    p,
    legacy: false,
  };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, HASH_BYTES, {
    N: RECOMMENDED_N,
    r: RECOMMENDED_R,
    p: RECOMMENDED_P,
  });
  return `${VERSION}:${RECOMMENDED_N}:${RECOMMENDED_R}:${RECOMMENDED_P}:${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<{ valid: boolean; needsRehash: boolean; capacityLimited?: true }> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return { valid: false, needsRehash: false };
  let actual: Buffer;
  try {
    actual = await scryptAsync(password, parsed.salt, parsed.expected.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
    });
  } catch (error) {
    if (error instanceof KdfCapacityError) {
      return { valid: false, needsRehash: false, capacityLimited: true };
    }
    throw error;
  }
  const valid = actual.length === parsed.expected.length
    && timingSafeEqual(actual, parsed.expected);
  return {
    valid,
    needsRehash: valid && (
      parsed.legacy
      || parsed.N !== RECOMMENDED_N
      || parsed.r !== RECOMMENDED_R
      || parsed.p !== RECOMMENDED_P
    ),
  };
}
