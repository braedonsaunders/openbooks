import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { allocateDocumentNumber } from '@openbooks/engine/src/records/numbering.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid } from '../../../../lib/list-params'
import { OrderDraftError } from '../../../../lib/order-cycle'
import { claimIdempotentCreate, resolveIdempotentReplay } from '../../../../lib/api/idempotency'

export const runtime = 'nodejs'

/**
 * Instant-into-draft: create an empty draft purchase order and return its id.
 *
 * Idempotent under the canonical order-create contract
 * (web/app/api/_order/create.ts): the caller's `Idempotency-Key` header is a
 * UUID that becomes the document id, so a lost-response retry replays the
 * same purchase order (200) instead of creating a second one and burning a
 * second PO number. A reused key with different request-controlled details
 * is a 409, never the older order returned as though it matched.
 */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('ap.create', 'orders')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

  const requestId = req.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!isUuid(requestId)) {
    return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 400 })
  }

  try {
    if (!(await isFeatureEnabled(user.orgId, 'orders'))) {
      throw new OrderDraftError('Orders feature is disabled')
    }
    const org = (await db.execute<{ base_currency: string | null }>(
      sql`select base_currency from orgs where id = ${user.orgId}`,
    ))
    // The order currency is the org's base currency — never invented. A
    // missing org row (or an unconfigured base currency) refuses by name
    // instead of silently booking foreign-currency intent as CAD, the same
    // rule the canonical order create enforces.
    const baseCurrency = org.rows[0]?.base_currency
    if (!baseCurrency) {
      throw new OrderDraftError('this organization has no base currency configured — set one before creating orders')
    }
    const today = await businessToday(user.orgId)
    // The request-controlled image a retry must equal: the kind plus the
    // subsidiary this route always drafts under. Derived values (number,
    // date, currency, totals) are excluded so an identical retry still
    // replays after midnight or a configuration change.
    const match = { kind: 'purchase_order', subsidiary_id: null }

    let replayed = false
    try {
      const outcome = await db.transaction(async (tx) => {
        // Same-key fence first: two concurrent first-clicks with one key
        // serialize so the loser replays (200) instead of racing past the
        // prior-row check and dying on the insert conflict (409).
        await tx.execute(sql`
          select pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`)
        // The lookup never reads another org's row: a key minted elsewhere
        // misses here, hits the insert conflict below, and refuses as 409.
        if ((await claimIdempotentCreate(tx, { orgId: user.orgId, table: 'documents', key: requestId })) === 'exists') {
          const verdict = await resolveIdempotentReplay(tx, {
            orgId: user.orgId,
            table: 'documents',
            key: requestId,
            match,
          })
          if (verdict !== 'replay') throw new Error('idempotency_key_conflict')
          return { replayed: true }
        }
        // The number allocates HERE, inside the successful draft transaction:
        // a retried click never reaches this statement, so it burns neither
        // a row nor a sequence value.
        const documentNumber = await allocateDocumentNumber(tx, user.orgId, 'purchase_order', 'PO-')
        const inserted = (await tx.execute<{ id: string }>(sql`
          insert into documents (id, org_id, kind, document_number, document_date, currency, subsidiary_id, subtotal, tax_total, total, created_by)
          values (${requestId}, ${user.orgId}, 'purchase_order', ${documentNumber}, ${today},
                  ${baseCurrency}, null, '0', '0', '0', ${user.id})
          on conflict (id) do nothing
          returning id
        `))
        if (!inserted.rows[0]) throw new Error('idempotency_key_conflict')
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
          values (${user.orgId}, 'documents', ${requestId}, 'insert',
                  ${JSON.stringify({ before: null, after: { ...match, status: 'draft' } })}::jsonb,
                  ${user.id}, ${requestId})
        `)
        return { replayed: false }
      })
      replayed = outcome.replayed
    } catch (error) {
      const message = error instanceof Error
        ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}`
        : String(error)
      if (message.includes('idempotency_key_conflict')) {
        return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 409 })
      }
      throw error
    }

    const doc = (await db.execute<{ id: string; document_number: string }>(sql`
      select id, document_number from documents
       where id = ${requestId} and org_id = ${user.orgId} and kind = 'purchase_order'
    `))
    if (!doc.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json(doc.rows[0], { status: replayed ? 200 : 201 })
  } catch (error) {
    if (error instanceof OrderDraftError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
  }
}
