import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import { uploadAndAttach } from '../../../../lib/file-cabinet'
import { resolveFieldTicketLockId } from '../../../../lib/field-ticket-lock'
import { validateSigningRequest, verifySigningToken } from '../../../../lib/field-ticket-token'

export const runtime = 'nodejs'

/**
 * Public customer-sign endpoint — possession-authenticated by the HMAC token.
 * Stores the drawn signature as an immutable, versioned File Cabinet object
 * and records first-class signature evidence. Each persisted request is
 * independently revocable and can be consumed only once.
 *
 * Signing is one atomic unit (`withOrgTransaction`): advisory lock → request
 * re-validation → ticket status + double-sign checks → cabinet upload →
 * signature row → request response stamp → audit log, all on one pinned
 * connection that commits or rolls back together. The cabinet helpers join the
 * pinned transaction automatically (nested db.transaction participates), so a
 * loser of the race or any mid-flight failure leaves NO artifacts behind —
 * never an uploaded signature image without its evidence row, and never two
 * evidence rows for one request.
 */
export async function POST(req: Request) {
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  const verified = verifySigningToken(String(body.token ?? ''))
  if (!verified) return NextResponse.json({ error: 'This signing link is invalid or expired' }, { status: 401 })

  const signature = String(body.signature ?? '')
  const name = String(body.name ?? '').trim().slice(0, 120)
  const comment = body.comment ? String(body.comment).slice(0, 500) : null
  if (!signature.startsWith('data:image/png;base64,') || signature.length > 400_000) {
    return NextResponse.json({ error: 'A drawn signature is required' }, { status: 422 })
  }
  if (!name) return NextResponse.json({ error: 'Your name is required' }, { status: 422 })
  let signatureBytes: Buffer
  try {
    signatureBytes = Buffer.from(signature.slice('data:image/png;base64,'.length), 'base64')
  } catch {
    return NextResponse.json({ error: 'The signature image is invalid' }, { status: 422 })
  }
  if (
    signatureBytes.length < 8
    || !signatureBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return NextResponse.json({ error: 'The signature image is invalid' }, { status: 422 })
  }

  return withOrgTransaction(verified.orgId, async () => {
    // Serialize signers of this request BEFORE any check or write; the lock is
    // transaction-scoped on the pinned connection, so it holds until commit.
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${resolveFieldTicketLockId('sign', verified.orgId, verified.ticketId, verified.requestId)}, 0))`)
    if (!(await validateSigningRequest(String(body.token ?? ''), verified))) {
      return NextResponse.json({ error: 'This signing request is no longer available' }, { status: 422 })
    }
    const doc = (await db.execute<{ id: string; status: string; document_number: string }>(sql`
      select d.id, d.status, d.document_number
        from documents d
        join field_tickets ft on ft.document_id = d.id and ft.org_id = d.org_id
       where d.id = ${verified.ticketId} and d.org_id = ${verified.orgId}
         and d.kind = 'field_ticket'`))
    const row = doc.rows[0]
    if (!row) return NextResponse.json({ error: 'Ticket not found' }, { status: 404 })
    if (row.status !== 'approved') return NextResponse.json({ error: 'This ticket is not open for signing' }, { status: 422 })
    const existing = await db.execute(sql`
      select id from field_ticket_signatures
       where org_id = ${verified.orgId} and field_ticket_id = ${verified.ticketId}
         and role = 'customer'
    `)
    if (existing.rows.length) {
      return NextResponse.json({ error: 'This ticket is already signed' }, { status: 422 })
    }

    // Runs inside this same transaction: file + version + blob + attachment
    // rows commit only when the signature evidence does (an S3 put failure or
    // a later-step error rolls the whole unit back).
    const file = await uploadAndAttach({
      orgId: verified.orgId,
      targetTable: 'documents',
      targetId: verified.ticketId,
      filename: `Field-Ticket-${row.document_number}-Customer-Signature.png`,
      contentType: 'image/png',
      bytes: signatureBytes,
      createdBy: null,
    })
    const acceptedAt = new Date().toISOString()
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into field_ticket_signatures
        (org_id, field_ticket_id, role, signer_name, comment,
         signature_file_id, signed_at, created_by)
      values (${verified.orgId}, ${verified.ticketId}, 'customer', ${name},
              ${comment}, ${file.id}, ${acceptedAt}, null)
      returning id
    `))
    await db.execute(sql`
      update field_ticket_signature_requests
         set responded_at = ${acceptedAt}
       where id = ${verified.requestId} and org_id = ${verified.orgId}
         and responded_at is null and revoked_at is null
    `)
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${verified.orgId}, 'field_ticket_signatures', ${inserted.rows[0]!.id}, 'insert',
              ${JSON.stringify({
                fieldTicketId: verified.ticketId,
                role: 'customer',
                signerName: name,
                signedAt: acceptedAt,
                signatureFileId: file.id,
                signatureRequestId: verified.requestId,
              })}::jsonb, null)
    `)
    return NextResponse.json({ ok: true })
  })
}
