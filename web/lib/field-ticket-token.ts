import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '@openbooks/engine/src/db.ts'

/**
 * Customer-signing links: a compact HMAC token (orgId.ticketId.expiry.sig)
 * signed with SESSION_SECRET — same trust model as the flow email-approve
 * tokens. The link is possession-authenticated: whoever the customer forwards
 * it to can sign, exactly like the paper sheet handed across the counter.
 */

const b64u = (b: Buffer) => b.toString('base64url')

function sign(payload: string): string {
  return b64u(createHmac('sha256', env.SESSION_SECRET ?? 'dev-secret').update(payload).digest())
}

export function mintSigningToken(orgId: string, ticketId: string, ttlDays = 14): string {
  const exp = Date.now() + ttlDays * 24 * 60 * 60 * 1000
  const payload = `${orgId}.${ticketId}.${exp}`
  return `${b64u(Buffer.from(payload))}.${sign(payload)}`
}

export function verifySigningToken(token: string): { orgId: string; ticketId: string } | null {
  const dot = token.lastIndexOf('.')
  if (dot < 0) return null
  const payloadB64 = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  let payload: string
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString()
  } catch {
    return null
  }
  const expected = sign(payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const [orgId, ticketId, expStr] = payload.split('.')
  if (!orgId || !ticketId || !expStr) return null
  if (Number(expStr) < Date.now()) return null
  return { orgId, ticketId }
}
