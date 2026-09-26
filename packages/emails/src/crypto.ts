// Server-only email provider secret sealing (AES-256-GCM under the shared
// OPENBOOKS_DATA_KEY, purpose `email.provider.secret`).
// (No `server-only` import: this package is also consumed by the Node worker.)
//
// The wire format is byte-compatible with the engine's platform/secrets
// (`enc:v2:<keyId>:<nonce>:<ct>:<tag>`, AAD `${orgId}:email.provider.secret`)
// so the rotation script can re-seal email credentials with the same code
// path as every other sealed column. Any change here must mirror
// engine/src/platform/secrets.ts.
//
// Credentials sealed before this move used a SESSION_SECRET-derived key in
// `{ciphertext, nonce}` shape. That shape still UNSEALS (rotation window,
// backup-restore validation) but never seals: a session-secret rotation must
// no longer brick SMTP credentials.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { resolveVerifiedAddresses, type AddressLookup } from '@openbooks/networking/ssrf'

const EMAIL_SECRET_PURPOSE = 'email.provider.secret'
const V2_PREFIX = 'enc:v2:'

const FALLBACK_SECRET = 'openbooks-dev-insecure-secret'
const HKDF_INFO = 'openbooks.secret.v1'

function sourceSecret(): string {
  const secret = process.env.SESSION_SECRET
  if (secret && (process.env.NODE_ENV !== 'production' || secret.length >= 32)) return secret
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[email/crypto] SESSION_SECRET must contain at least 32 characters in production to seal provider secrets.',
    )
  }
  return FALLBACK_SECRET
}

let cachedLegacyKey: Buffer | null = null
function legacyKey(): Buffer {
  if (!cachedLegacyKey) {
    cachedLegacyKey = Buffer.from(hkdfSync('sha256', Buffer.from(sourceSecret()), Buffer.alloc(0), Buffer.from(HKDF_INFO), 32))
  }
  return cachedLegacyKey
}

function decodeKeyMaterial(raw: string): Buffer {
  const text = raw.trim()
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex')
  return Buffer.from(text, 'base64')
}

const PLACEHOLDER_RE = /(replace|change.?me|password|openbooks|example|insecure)/i

function keyRemedy(): string {
  return 'generate one with `openssl rand -hex 32`, set OPENBOOKS_DATA_KEY (single-key installs) ' +
    'or OPENBOOKS_DATA_KEYS as `id=base64,id=base64` with OPENBOOKS_DATA_KEY_ACTIVE=<id> (rotated installs)'
}

function checkedKey(id: string, raw: string): Buffer {
  if (!raw || !raw.trim()) throw new Error(`[email/crypto] data key ${id} is empty — ${keyRemedy()}`)
  if (PLACEHOLDER_RE.test(raw)) throw new Error(`[email/crypto] data key ${id} looks like a placeholder — ${keyRemedy()}`)
  const buf = decodeKeyMaterial(raw)
  if (buf.length !== 32) throw new Error(`[email/crypto] data key ${id} must decode to exactly 32 bytes (hex or base64) — ${keyRemedy()}`)
  return buf
}

function dataKeys(): { activeId: string; keys: Map<string, Buffer> } {
  const multi = (process.env.OPENBOOKS_DATA_KEYS ?? '').trim()
  if (multi) {
    const keys = new Map<string, Buffer>()
    for (const entry of multi.split(',')) {
      const eq = entry.indexOf('=')
      if (eq <= 0) throw new Error(`[email/crypto] OPENBOOKS_DATA_KEYS must be id=key pairs separated by commas — ${keyRemedy()}`)
      const id = entry.slice(0, eq).trim()
      const raw = entry.slice(eq + 1).trim()
      if (!id || !/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error(`[email/crypto] invalid data key id — ${keyRemedy()}`)
      if (keys.has(id)) throw new Error(`[email/crypto] data key id ${JSON.stringify(id)} is listed twice — ${keyRemedy()}`)
      keys.set(id, checkedKey(id, raw))
    }
    const activeId = (process.env.OPENBOOKS_DATA_KEY_ACTIVE ?? '').trim()
    if (!activeId || !keys.has(activeId)) {
      throw new Error(`[email/crypto] OPENBOOKS_DATA_KEY_ACTIVE must name one of (${[...keys.keys()].join(', ')})`)
    }
    return { activeId, keys }
  }
  const raw = process.env.OPENBOOKS_DATA_KEY ?? ''
  if (!raw.trim()) throw new Error(`[email/crypto] OPENBOOKS_DATA_KEY is not set — ${keyRemedy()}`)
  return { activeId: 'k1', keys: new Map([['k1', checkedKey('k1', raw)]]) }
}

function checkOrgId(orgId: string): string {
  const id = orgId?.trim() ?? ''
  if (!id) throw new Error('[email/crypto] sealing requires the org id the credential belongs to')
  return id
}

/** Legacy SESSION_SECRET-derived sealed shape. Reads only — never written. */
export type SealedSecret = { ciphertext: string; nonce: string }

/** Seal a provider credential under the active data key for one org. */
export function sealSecret(plain: string, orgId: string): string {
  const org = checkOrgId(orgId)
  const ring = dataKeys()
  const key = ring.keys.get(ring.activeId)!
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`${org}:${EMAIL_SECRET_PURPOSE}`, 'utf8'))
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const b64 = (b: Buffer): string => b.toString('base64')
  return `${V2_PREFIX}${ring.activeId}:${b64(iv)}:${b64(enc)}:${b64(cipher.getAuthTag())}`
}

/**
 * Unseal a data-key credential. Throws naming the org and key id — the
 * caller surfaces it as "re-enter the credential under Settings → Email",
 * never as "not configured".
 */
export function unsealSecret(sealed: string, orgId: string): string {
  const org = checkOrgId(orgId)
  if (typeof sealed !== 'string' || !sealed.startsWith(V2_PREFIX)) {
    throw new Error(
      `[email/crypto] stored credential for org ${org} is not a data-key sealed secret; ` +
        're-enter the credential under Settings → Email before mail can send',
    )
  }
  const parts = sealed.slice(V2_PREFIX.length).split(':')
  const [keyId, ivB64, ctB64, tagB64] = parts
  const ring = dataKeys()
  const key = keyId ? ring.keys.get(keyId) : undefined
  if (!keyId || !ivB64 || !ctB64 || !tagB64 || parts.length !== 4 || !key) {
    throw new Error(
      `[email/crypto] stored credential for org ${org} (key ${keyId || 'unknown'}) cannot be unsealed with the configured data key; ` +
        're-enter the credential under Settings → Email before mail can send',
    )
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
    decipher.setAAD(Buffer.from(`${org}:${EMAIL_SECRET_PURPOSE}`, 'utf8'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error(
      `[email/crypto] stored credential for org ${org} (key ${keyId}) failed authentication — it was tampered with, moved from another org, or sealed under a different key value; ` +
        're-enter the credential under Settings → Email before mail can send',
    )
  }
}

/**
 * Unseal a pre-move `{ciphertext, nonce}` credential sealed under the
 * SESSION_SECRET-derived key. Rotation-window and backup-restore reads only.
 */
export function unsealLegacyEmailSecret(sealed: SealedSecret): string | null {
  try {
    const raw = Buffer.from(sealed.ciphertext, 'base64')
    const iv = Buffer.from(sealed.nonce, 'base64')
    const tag = raw.subarray(raw.length - 16)
    const enc = raw.subarray(0, raw.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', legacyKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/**
 * SMTP host resolver. Resolve and validate every DNS answer before handing
 * Nodemailer a pinned address; TLS still authenticates the original hostname.
 */
export async function resolvePublicHost(
  host: string,
  lookupAddresses?: AddressLookup,
): Promise<{ address: string; hostname: string; family?: number; ipLiteral: boolean }> {
  const h = host.trim()
  if (!h || isIP(h)) {
    throw new Error('External SMTP host must be a DNS name so its TLS identity can be verified.')
  }
  const target = new URL(`https://${h}/`)
  if (target.username || target.password || target.port || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('SMTP host must contain only a DNS hostname.')
  }
  const addresses = await resolveVerifiedAddresses(target, lookupAddresses)
  return {
    address: addresses[0]!,
    hostname: target.hostname,
    family: isIP(addresses[0]!) || undefined,
    ipLiteral: false,
  }
}
