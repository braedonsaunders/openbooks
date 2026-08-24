import 'server-only'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db, env } from '@openbooks/engine/src/db.ts'

/**
 * Customer-signing links: a compact HMAC token
 * (orgId.ticketId.requestId.expiry.sig)
 * signed with SESSION_SECRET — same trust model as the flow email-approve
 * tokens. The link is possession-authenticated: whoever the customer forwards
 * it to can sign, exactly like the paper sheet handed across the counter.
 */

const b64u = (b: Buffer) => b.toString('base64url')

function sign(payload: string): string {
  return b64u(createHmac('sha256', env.SESSION_SECRET!).update(payload).digest())
}

export function mintSigningToken(
  orgId: string,
  ticketId: string,
  requestId: string,
  expiresAt: Date,
): string {
  const payload = `${orgId}.${ticketId}.${requestId}.${expiresAt.getTime()}`
  return `${b64u(Buffer.from(payload))}.${sign(payload)}`
}

export function signingTokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function verifySigningToken(
  token: string,
): { orgId: string; ticketId: string; requestId: string; expiresAt: Date } | null {
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
  const [orgId, ticketId, requestId, expStr] = payload.split('.')
  if (!orgId || !ticketId || !requestId || !expStr) return null
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp < Date.now()) return null
  return { orgId, ticketId, requestId, expiresAt: new Date(exp) }
}

/** Validate the persisted, independently revocable request represented by the
 * token. Cryptographic validity alone never authorizes a signature. */
export async function validateSigningRequest(
  token: string,
  claims: NonNullable<ReturnType<typeof verifySigningToken>>,
  options: { allowResponded?: boolean } = {},
): Promise<boolean> {
  const result = (await db.execute<{ id: string }>(sql`
    select request.id
      from field_ticket_signature_requests request
      join email_log email
        on email.id = request.email_log_id and email.org_id = request.org_id
     where request.id = ${claims.requestId}
       and request.org_id = ${claims.orgId}
       and request.field_ticket_id = ${claims.ticketId}
       and request.token_digest = ${signingTokenDigest(token)}
       and request.sent_at is not null
       and request.revoked_at is null
       and request.expires_at > now()
       and email.status = 'sent'
       and (${options.allowResponded === true}
            or request.responded_at is null)
  `))
  return result.rows.length === 1
}
