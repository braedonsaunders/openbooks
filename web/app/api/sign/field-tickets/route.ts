import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgContext } from '@openbooks/engine/src/db.ts'
import { verifySigningToken } from '../../../../lib/field-ticket-token'

export const runtime = 'nodejs'

/**
 * Public customer-sign endpoint — possession-authenticated by the HMAC token.
 * Stores the drawn signature (data-URL PNG), signer name, and comment on the
 * ticket, and marks the send state responded. One-shot: an already-signed
 * ticket refuses a second signature (reset happens in-app).
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const verified = verifySigningToken(String(body.token ?? ''))
  if (!verified) return NextResponse.json({ error: 'This signing link is invalid or expired' }, { status: 401 })

  const signature = String(body.signature ?? '')
  const name = String(body.name ?? '').trim().slice(0, 120)
  const comment = body.comment ? String(body.comment).slice(0, 500) : null
  if (!signature.startsWith('data:image/png;base64,') || signature.length > 400_000) {
    return NextResponse.json({ error: 'A drawn signature is required' }, { status: 422 })
  }
  if (!name) return NextResponse.json({ error: 'Your name is required' }, { status: 422 })

  return withOrgContext(verified.orgId, async () => {
    const doc = (await db.execute(sql`
      select id, status, custom from documents
       where id = ${verified.ticketId} and org_id = ${verified.orgId} and kind = 'field_ticket'`)) as unknown as {
      rows: { id: string; status: string; custom: { fieldTicket?: { signatures?: { customer?: unknown } } } }[]
    }
    const row = doc.rows[0]
    if (!row) return NextResponse.json({ error: 'Ticket not found' }, { status: 404 })
    if (row.status !== 'approved') return NextResponse.json({ error: 'This ticket is not open for signing' }, { status: 422 })
    if (row.custom?.fieldTicket?.signatures?.customer) {
      return NextResponse.json({ error: 'This ticket is already signed' }, { status: 422 })
    }

    const sig = { image: signature, name, comment, at: new Date().toISOString() }
    await db.execute(sql`
      update documents
         set custom = jsonb_set(
               jsonb_set(
                 jsonb_set(
                   jsonb_set(custom, '{fieldTicket,signatures}', coalesce(custom->'fieldTicket'->'signatures', '{}'::jsonb), true),
                   '{fieldTicket,signatures,customer}', ${JSON.stringify(sig)}::jsonb, true),
                 '{fieldTicket,send}', coalesce(custom->'fieldTicket'->'send', '{}'::jsonb), true),
               '{fieldTicket,send,respondedAt}', ${JSON.stringify(new Date().toISOString())}::jsonb, true),
             updated_at = now()
       where id = ${verified.ticketId} and org_id = ${verified.orgId}`)
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${verified.orgId}, 'documents', ${verified.ticketId}, 'update',
              ${JSON.stringify({ fieldTicketCustomerSigned: { name, at: sig.at } })}, null)`)
    return NextResponse.json({ ok: true })
  })
}
