// Server-only secret sealing (AES-256-GCM).
// (No `server-only` import: this package is also consumed by the Node worker.)
// The key is derived from the existing SESSION_SECRET via HKDF — no new env var,
// no plaintext secrets in the DB. A secret sealed by a web admin action unseals
// in the scheduler as long as both share SESSION_SECRET.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { resolveVerifiedAddresses, type AddressLookup } from '@openbooks/networking/ssrf'

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

let cachedKey: Buffer | null = null
function key(): Buffer {
  if (!cachedKey) {
    cachedKey = Buffer.from(hkdfSync('sha256', Buffer.from(sourceSecret()), Buffer.alloc(0), Buffer.from(HKDF_INFO), 32))
  }
  return cachedKey
}

export type SealedSecret = { ciphertext: string; nonce: string }

export function sealSecret(plain: string): SealedSecret {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    ciphertext: Buffer.concat([enc, tag]).toString('base64'),
    nonce: iv.toString('base64'),
  }
}

export function unsealSecret(sealed: SealedSecret): string | null {
  try {
    const raw = Buffer.from(sealed.ciphertext, 'base64')
    const iv = Buffer.from(sealed.nonce, 'base64')
    const tag = raw.subarray(raw.length - 16)
    const enc = raw.subarray(0, raw.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', key(), iv)
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
