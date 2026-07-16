// Server-only secret sealing (AES-256-GCM). Ported from beaconhs-platform.
// (No `server-only` import: this package is also consumed by the Node worker.)
// The key is derived from the existing SESSION_SECRET via HKDF — no new env var,
// no plaintext secrets in the DB. A secret sealed by a web admin action unseals
// in the scheduler as long as both share SESSION_SECRET.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

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
 * Simplified SMTP host resolver (beaconhs uses a full egress SSRF guard). We
 * reject IP literals so TLS identity can be verified against a DNS name;
 * nodemailer resolves DNS itself, and we keep `rejectUnauthorized` + servername.
 */
export async function resolvePublicHost(
  host: string,
  _opts?: { timeoutMs?: number },
): Promise<{ address: string; hostname: string; family?: number; ipLiteral: boolean }> {
  const { isIP } = await import('node:net')
  const h = host.trim()
  return { address: h, hostname: h, family: undefined, ipLiteral: isIP(h) !== 0 }
}
