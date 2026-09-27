import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Secret sealing (AES-256-GCM), engine-level so BOTH the web app (sealing on a
 * tenant's save) and the background worker (unsealing at run time) share it.
 * One data key protects everything at rest, and no plaintext secret ever
 * lives outside the DB.
 *
 * Wire format is `enc:v2:<keyId>:<nonce>:<ct>:<tag>` (all binary parts
 * base64). Every seal binds additional authenticated data
 * `${orgId}:${purpose}`, where purpose is a short stable string naming the
 * call site (e.g. `connection.secrets`). A blob copied into another tenant's
 * row or another purpose's column fails authentication and refuses by name
 * instead of decrypting — a DB writer cannot swap sealed blobs between rows.
 *
 * Key rotation uses `OPENBOOKS_DATA_KEYS` (`id=base64,id=base64`, ids are
 * short labels such as `k1`, `k2`) with `OPENBOOKS_DATA_KEY_ACTIVE=<id>`.
 * The legacy single-key `OPENBOOKS_DATA_KEY` keeps working as key id `k1`.
 * Seals always use the active key; unseals resolve the key by the id named
 * in the blob. `enc:v1:` blobs (no key id, no AAD) still decrypt so a rolling
 * deploy and the rotation script can read pre-v2 rows — new seals are v2
 * only. Run `scripts/rotate-data-key.ts` to re-seal every v1 blob under the
 * active key.
 *
 * (web/lib/secrets.ts re-exports this module for web-side use.)
 */

export const SEALED_V1_PREFIX = "enc:v1:";
export const SEALED_V2_PREFIX = "enc:v2:";
const LEGACY_SINGLE_KEY_ID = "k1";

const PURPOSE_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** Who a sealed blob belongs to. Baked into the ciphertext as AAD. */
export type SecretScope = {
  /** Tenant (or user, for user-level secrets such as MFA) the blob belongs to. */
  orgId: string;
  /** Short stable string naming the call site, e.g. `connection.secrets`. */
  purpose: string;
};

/**
 * A stored secret that cannot be authenticated: tampered, sealed under an
 * unknown or retired key, bound to another tenant or purpose, or malformed.
 * Names the org, purpose, and key id so the operator knows exactly which
 * credential to re-enter, and how (see the remedy in the message).
 */
export class SecretIntegrityError extends Error {
  readonly orgId: string;
  readonly purpose: string;
  readonly keyId: string;
  constructor(orgId: string, purpose: string, keyId: string, detail: string) {
    super(
      `stored secret for org ${orgId} purpose ${purpose} (key ${keyId}) cannot be unsealed: ${detail}. ` +
        `Re-enter the credential on its settings page and save again, or re-run scripts/rotate-data-key.ts ` +
        `with the key that sealed it configured`,
    );
    this.name = "SecretIntegrityError";
    this.orgId = orgId;
    this.purpose = purpose;
    this.keyId = keyId;
  }
}

function checkScope(scope: SecretScope): { orgId: string; purpose: string } {
  const orgId = scope?.orgId?.trim() ?? "";
  const purpose = scope?.purpose?.trim() ?? "";
  if (!orgId) throw new Error("seal scope requires a non-empty orgId (tenant or user id the blob belongs to)");
  if (!PURPOSE_RE.test(purpose)) {
    throw new Error(
      `seal scope requires a stable purpose like "connection.secrets" (lowercase letters, digits, dot, dash, underscore; got ${JSON.stringify(scope?.purpose ?? null)})`,
    );
  }
  return { orgId, purpose };
}

function aadFor(scope: SecretScope): string {
  return `${scope.orgId}:${scope.purpose}`;
}

function decodeKeyMaterial(raw: string): Buffer {
  const text = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  return Buffer.from(text, "base64");
}

const PLACEHOLDER_RE = /(replace|change.?me|password|openbooks|example|insecure)/i;

/** True only when the operator set NODE_ENV to development or test. */
export function isNamedNonProductionEnvironment(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return environment.NODE_ENV === "development" || environment.NODE_ENV === "test";
}

type DataKeyRing = { activeId: string; keys: Map<string, Buffer> };

function keyRemedy(): string {
  return "generate one with `openssl rand -hex 32`, set OPENBOOKS_DATA_KEY (single-key installs) " +
    "or OPENBOOKS_DATA_KEYS as `id=base64,id=base64` with OPENBOOKS_DATA_KEY_ACTIVE=<id> (rotated installs)";
}

function checkedKey(id: string, raw: string): Buffer {
  if (!raw || !raw.trim()) throw new Error(`data key ${id} is empty — ${keyRemedy()}`);
  if (PLACEHOLDER_RE.test(raw)) {
    throw new Error(`data key ${id} looks like a placeholder — ${keyRemedy()}`);
  }
  const buf = decodeKeyMaterial(raw);
  if (buf.length !== 32) throw new Error(`data key ${id} must decode to exactly 32 bytes (hex or base64) — ${keyRemedy()}`);
  return buf;
}

/** Parse and validate the configured data keys. Throws naming the remedy. */
export function loadDataKeyRing(
  environment: Record<string, string | undefined> = process.env,
): DataKeyRing {
  const multi = environment.OPENBOOKS_DATA_KEYS?.trim() ?? "";
  if (multi) {
    const keys = new Map<string, Buffer>();
    for (const entry of multi.split(",")) {
      const eq = entry.indexOf("=");
      if (eq <= 0) throw new Error(`OPENBOOKS_DATA_KEYS must be id=key pairs separated by commas — ${keyRemedy()}`);
      const id = entry.slice(0, eq).trim();
      const raw = entry.slice(eq + 1).trim();
      if (!id || !/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
        throw new Error(`data key id ${JSON.stringify(id)} is invalid (letters, digits, dash, underscore) — ${keyRemedy()}`);
      }
      if (keys.has(id)) throw new Error(`data key id ${JSON.stringify(id)} is listed twice — ${keyRemedy()}`);
      keys.set(id, checkedKey(id, raw));
    }
    if (keys.size === 0) throw new Error(`OPENBOOKS_DATA_KEYS is set but holds no keys — ${keyRemedy()}`);
    const activeId = environment.OPENBOOKS_DATA_KEY_ACTIVE?.trim() ?? "";
    if (!activeId) {
      throw new Error(
        `OPENBOOKS_DATA_KEY_ACTIVE names no key (available: ${[...keys.keys()].join(", ")}) — set it to the id new seals must use`,
      );
    }
    if (!keys.has(activeId)) {
      throw new Error(
        `OPENBOOKS_DATA_KEY_ACTIVE names ${JSON.stringify(activeId)}, which is not in OPENBOOKS_DATA_KEYS (${[...keys.keys()].join(", ")})`,
      );
    }
    return { activeId, keys };
  }
  const raw = environment.OPENBOOKS_DATA_KEY ?? "";
  if (!raw || !raw.trim()) {
    throw new Error(`OPENBOOKS_DATA_KEY is not set — required to seal stored secrets (32-byte key, hex or base64); ${keyRemedy()}`);
  }
  return { activeId: LEGACY_SINGLE_KEY_ID, keys: new Map([[LEGACY_SINGLE_KEY_ID, checkedKey(LEGACY_SINGLE_KEY_ID, raw)]]) };
}

/**
 * Fail closed when the data key is absent, a placeholder, or the wrong
 * length — the same shape as the session-secret policy. Call at startup
 * (bootstrap `--check`, web/worker boot): any seal or unseal throws the same
 * way, this names the problem before the first row is touched.
 */
export function requireDataKey(
  environment: Record<string, string | undefined> = process.env,
): string {
  return loadDataKeyRing(environment).activeId;
}

function activeKey(): { id: string; key: Buffer } {
  // Live read: db.ts snapshots the environment at module evaluation, so a
  // snapshot read misses keys assigned after that import.
  const ring = loadDataKeyRing();
  return { id: ring.activeId, key: ring.keys.get(ring.activeId)! };
}

function keyById(keyId: string, scope: SecretScope, ring: DataKeyRing): Buffer {
  const key = ring.keys.get(keyId);
  if (!key) {
    throw new SecretIntegrityError(
      scope.orgId,
      scope.purpose,
      keyId,
      `key ${keyId} is not configured (available: ${[...ring.keys.keys()].join(", ") || "none"}); ` +
        `configure the sealing key or restore it before reading this credential`,
    );
  }
  return key;
}

/** Seal with the active key, binding `${orgId}:${purpose}` as AAD. */
export function sealSecret(plain: string, scope: SecretScope): string {
  const checked = checkScope(scope);
  const { id, key } = activeKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aadFor(checked), "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const b64 = (b: Buffer): string => b.toString("base64");
  return `${SEALED_V2_PREFIX}${id}:${b64(iv)}:${b64(ct)}:${b64(cipher.getAuthTag())}`;
}

/** Which key sealed a stored blob, without touching key material. */
export function describeSealedBlob(stored: string | null | undefined): { version: "v1" | "v2"; keyId: string } | null {
  if (typeof stored !== "string") return null;
  if (stored.startsWith(SEALED_V2_PREFIX)) {
    const keyId = stored.slice(SEALED_V2_PREFIX.length).split(":")[0] ?? "";
    return keyId ? { version: "v2", keyId } : null;
  }
  if (stored.startsWith(SEALED_V1_PREFIX)) return { version: "v1", keyId: LEGACY_SINGLE_KEY_ID };
  return null;
}

/**
 * Unseal, verifying the `${orgId}:${purpose}` binding. Throws
 * SecretIntegrityError on any tampered, mis-bound, wrong-key, or malformed
 * input — never null. A null or missing column is "unconfigured", which the
 * CALLER distinguishes with an explicit null check before calling; reaching
 * here with no stored value is itself an integrity failure.
 */
export function unsealSecret(stored: string, scope: SecretScope): string {
  const checked = checkScope(scope);
  const fail = (keyId: string, detail: string): never => {
    throw new SecretIntegrityError(checked.orgId, checked.purpose, keyId, detail);
  };
  if (typeof stored !== "string" || stored === "") {
    return fail("unknown", "no sealed value is stored where one is required");
  }
  // Live read per unseal so a rotation (new active key, retired old key)
  // takes effect without a restart.
  let ring: DataKeyRing;
  try {
    ring = loadDataKeyRing();
  } catch (error) {
    return fail("unknown", error instanceof Error ? error.message : String(error));
  }
  if (stored.startsWith(SEALED_V2_PREFIX)) {
    const parts = stored.slice(SEALED_V2_PREFIX.length).split(":");
    const [keyId, ivB64, ctB64, tagB64] = parts;
    if (!keyId || !ivB64 || !ctB64 || !tagB64 || parts.length !== 4) {
      return fail("unknown", "stored value is not a well-formed v2 sealed blob");
    }
    const key = keyById(keyId, checked, ring);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
      decipher.setAAD(Buffer.from(aadFor(checked), "utf8"));
      decipher.setAuthTag(Buffer.from(tagB64, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
    } catch {
      return fail(
        keyId,
        "authentication failed — the blob was tampered with, copied from another org or purpose, or sealed under a different key value",
      );
    }
  }
  if (stored.startsWith(SEALED_V1_PREFIX)) {
    // Rotation window: v1 bound no AAD, so any key holding the value opens
    // it. Re-seal through scripts/rotate-data-key.ts to gain the binding.
    const parts = stored.slice(SEALED_V1_PREFIX.length).split(":");
    const [ivB64, ctB64, tagB64] = parts;
    if (!ivB64 || !ctB64 || !tagB64 || parts.length !== 3) {
      return fail("v1-legacy", "stored value is not a well-formed sealed blob");
    }
    const ordered = [ring.activeId, ...[...ring.keys.keys()].filter((id) => id !== ring.activeId)];
    for (const id of ordered) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", ring.keys.get(id)!, Buffer.from(ivB64, "base64"));
        decipher.setAuthTag(Buffer.from(tagB64, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
      } catch {
        continue;
      }
    }
    return fail("v1-legacy", "legacy blob does not open under any configured data key; configure the sealing key before reading it");
  }
  return fail("unknown", "stored value is not a sealed secret (missing enc:v1:/enc:v2: prefix)");
}

/** Seal/unseal a JSON object of credentials (the connection `secrets` blob). */
export function sealJson(obj: object, scope: SecretScope): string {
  return sealSecret(JSON.stringify(obj), scope);
}

export function unsealJson<T = Record<string, unknown>>(stored: string, scope: SecretScope): T {
  const checked = checkScope(scope);
  const version = describeSealedBlob(stored);
  const plain = unsealSecret(stored, checked);
  try {
    return JSON.parse(plain) as T;
  } catch {
    throw new SecretIntegrityError(
      checked.orgId,
      checked.purpose,
      version?.keyId ?? "unknown",
      "stored secret decrypted but is not valid JSON — the row is corrupt; re-enter the credential and save again",
    );
  }
}

/**
 * A KEYED fingerprint of a confidential identifier — for proving that a value
 * CHANGED without ever storing or displaying the value.
 *
 * The motivating case is a payroll filing amendment: "the SIN on this T4 was
 * wrong" is one of the commonest reasons an employer amends, and the operator
 * (and the agency's own review) must see that the identifier moved. Storing
 * the SIN in the filing snapshot to make that comparison possible would
 * spread a sealed identifier into a second table; a PLAIN hash would not help
 * either, because a nine-digit number has only 10^9 preimages and is
 * brute-forced in seconds.
 *
 * So this is HMAC-SHA-256 under the ACTIVE data key that seals the
 * identifier itself: without the key the digest is meaningless, and with the
 * key you already had the plaintext. `namespace` domain-separates fields, so
 * a SIN fingerprint can never collide with an SSN fingerprint of the same
 * digits.
 *
 * The fingerprint carries the key id that produced it (`<keyId>:<hmac>`),
 * so a comparison made AFTER a rotation can recompute under the STORED key
 * id instead of misreading every identifier as changed. Bare-hex
 * fingerprints predate key ids and read as `k1` (the legacy single-key id).
 */
export function keyedFingerprint(namespace: string, plain: string): string {
  const { id, key } = activeKey();
  return `${id}:${fingerprintHmac(key, namespace, plain)}`;
}

function fingerprintHmac(key: Buffer, namespace: string, plain: string): string {
  return createHmac("sha256", key)
    .update(`${namespace}\u0000${plain}`, "utf8")
    .digest("hex");
}

/**
 * A stored fingerprint whose key id is not configured: the comparison cannot
 * recompute, so it refuses by name. The operator keeps the retired key in
 * OPENBOOKS_DATA_KEYS until amendments are re-fingerprinted, or runs
 * scripts/rotate-data-key.ts --apply, which re-fingerprints snapshots under
 * the active key.
 */
export class KeyedFingerprintError extends Error {
  readonly keyId: string;
  constructor(keyId: string) {
    super(
      `confidential identifier fingerprints under data key ${keyId} cannot be compared `
      + `because key ${keyId} is not configured — keep the retired key in OPENBOOKS_DATA_KEYS `
      + `until amendments are re-fingerprinted, or run scripts/rotate-data-key.ts --apply to `
      + `re-fingerprint filing snapshots under the active key`,
    );
    this.name = "KeyedFingerprintError";
    this.keyId = keyId;
  }
}

const FINGERPRINT_KEY_RE = /^[A-Za-z0-9_-]{1,32}$/;
const FINGERPRINT_HMAC_RE = /^[0-9a-f]{64}$/i;

/**
 * Split a stored fingerprint into the key id that produced it and the
 * digest. Legacy bare-hex fingerprints predate key ids and read as `k1`.
 * Null when the value is not a fingerprint at all (empty, corrupt) — the
 * caller treats that as unmatchable, never as equal.
 */
export function parseKeyedFingerprint(stored: string): { keyId: string; hmac: string } | null {
  if (typeof stored !== "string" || stored === "") return null;
  const colon = stored.indexOf(":");
  if (colon <= 0) {
    return FINGERPRINT_HMAC_RE.test(stored) ? { keyId: LEGACY_SINGLE_KEY_ID, hmac: stored.toLowerCase() } : null;
  }
  const keyId = stored.slice(0, colon);
  const hmac = stored.slice(colon + 1);
  if (!FINGERPRINT_KEY_RE.test(keyId) || !FINGERPRINT_HMAC_RE.test(hmac)) return null;
  return { keyId, hmac: hmac.toLowerCase() };
}

/**
 * Fingerprint a value under a NAMED key from the ring (not necessarily the
 * active one). Throws KeyedFingerprintError naming the remedy when the key
 * id is absent — a retired key the comparison still needs.
 */
export function fingerprintUnderKey(keyId: string, namespace: string, plain: string): string {
  const ring = loadDataKeyRing();
  const key = ring.keys.get(keyId);
  if (!key) throw new KeyedFingerprintError(keyId);
  return `${keyId}:${fingerprintHmac(key, namespace, plain)}`;
}

/**
 * The comparison half of `keyedFingerprint`: recompute the CURRENT value
 * under the STORED fingerprint's key id, so a rotation never reads an
 * unchanged identifier as changed. A stored value with no usable key id
 * (empty, corrupt) cannot prove equality and reads as different; a stored
 * key id absent from the ring throws KeyedFingerprintError naming the
 * remedy. Pass the previous snapshot fingerprint through so both halves
 * stay in one place.
 */
export function keyedFingerprintForComparison(
  namespace: string,
  plain: string,
  previous: string | undefined,
): string {
  if (!previous) return keyedFingerprint(namespace, plain);
  const parsed = parseKeyedFingerprint(previous);
  if (!parsed) return keyedFingerprint(namespace, plain);
  return fingerprintUnderKey(parsed.keyId, namespace, plain);
}

/**
 * True when `plain` is the value a stored fingerprint was taken from,
 * recomputed under the stored fingerprint's key id (timing-safe). Throws
 * KeyedFingerprintError when the stored key id is absent from the ring.
 */
export function matchKeyedFingerprint(namespace: string, stored: string, plain: string): boolean {
  const parsed = parseKeyedFingerprint(stored);
  if (!parsed) return false;
  const recomputed = fingerprintUnderKey(parsed.keyId, namespace, plain);
  const expected = Buffer.from(parsed.hmac, "hex");
  const actual = Buffer.from(recomputed.slice(recomputed.indexOf(":") + 1), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
