import { crmOpportunityScope } from '../../../../../../lib/crm-scope'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { isDocKindEnabled } from "../../../../../../lib/documents.ts";
import { guardPermission } from '../../../../../../lib/authz'
import { canonicalDecimal } from '../../../../../../lib/exact-decimal'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../../../../lib/features'
import { isUuid } from '../../../../../../lib/list-params'
import { getTranslations } from 'next-intl/server'
import { claimSetupCreate, SetupCreateConflict } from '../../../../../../lib/api/idempotency'
import { draftDocumentId } from '../../../../../../lib/order-cycle'

export const runtime = 'nodejs'

const INVENTORY_ITEM_KINDS = new Set(['inventory', 'assembly', 'kit'])

/** Persist leftover estimate projected amount through exact decimal then ledger money. Fail closed. */
function persistEstimateProjectedAmount(value: unknown): string {
  const exact = canonicalDecimal(value, 4)
  if (exact === null) throw new Error('projected amount must be an exact decimal')
  try {
    return normalizeMoney(exact)
  } catch {
    throw new Error('projected amount must be an exact decimal')
  }
}

/** Persist leftover estimate line amount through exact decimal then ledger money. Fail closed. */
function persistEstimateLineAmount(value: unknown): string {
  const exact = canonicalDecimal(value, 4)
  if (exact === null) throw new Error('line amount must be an exact decimal')
  try {
    return normalizeMoney(exact)
  } catch {
    throw new Error('line amount must be an exact decimal')
  }
}

/** Persist leftover estimate line quantity through exact decimal then ledger money. Fail closed. */
function persistEstimateLineQuantity(value: unknown): string {
  const exact = canonicalDecimal(value, 4)
  if (exact === null) throw new Error('line quantity must be an exact decimal')
  try {
    return normalizeMoney(exact)
  } catch {
    throw new Error('line quantity must be an exact decimal')
  }
}

/** Persist leftover estimate line unit price through exact decimal then ledger money. Fail closed. */
function persistEstimateLineUnitPrice(value: unknown): string {
  const exact = canonicalDecimal(value, 4)
  if (exact === null) throw new Error('line unit price must be an exact decimal')
  try {
    return normalizeMoney(exact)
  } catch {
    throw new Error('line unit price must be an exact decimal')
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Creating an estimate mutates CRM state (it links the quote to the
  // opportunity and copies its title, amounts, dimensions and lines) AND
  // creates an AR document, so the caller needs both the CRM manage right
  // and the AR create right; an AR-only role must not read pipeline data
  // through a quote it minted.
  const gate = await guardFeaturePermission('crm.opportunities.manage', 'crm')
  if (gate instanceof NextResponse) return gate
  const arGate = await guardPermission('ar.create')
  if (arGate instanceof NextResponse) return arGate
  const { user } = gate
  if (!(await isDocKindEnabled(user.orgId, 'quote'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // A retry or double click must not mint a second quote. The caller sends
  // one Idempotency-Key per estimate action (the house draft-route pattern):
  // same key replays the first quote, a changed payload conflicts, and a
  // fresh key deliberately starts a new revision.
  const t = await getTranslations('crm')
  const idempotencyKey = req.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!isUuid(idempotencyKey)) {
    return NextResponse.json({ error: t('opportunities.estimateKeyRequired') }, { status: 400 })
  }
  const draftId = draftDocumentId(user.orgId, `${id}:${idempotencyKey}`)
  // Opportunity lines stay as stored. Turning Inventory off must 404 a new
  // estimate that would copy inventory / assembly / kit onto a quote.
  if (!(await isFeatureEnabled(user.orgId, 'inventory'))) {
    const lineItems = (await db.execute<{ kind: string }>(sql`
      select i.kind
        from crm_opportunity_lines line
        join items i on i.id = line.item_id and i.org_id = line.org_id
       where line.org_id = ${user.orgId} and line.opportunity_id = ${id}`))
    if (lineItems.rows.some((row) => INVENTORY_ITEM_KINDS.has(row.kind))) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
  }
  const today = await businessToday(user.orgId)
  const result = await db.transaction(async (tx) => {
    // Serialize concurrent retries on the key so the loser replays instead
    // of racing past the claim and dying on the insert conflict.
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${draftId}, 0))`)
    const opportunity = (await tx.execute(sql`
      select o.* from crm_opportunities o where o.id = ${id} and o.org_id = ${user.orgId} and o.is_active${crmOpportunityScope(gate.allowedSubsidiaryIds)} for update of o`))
    const op = opportunity.rows[0]
    if (!op) return NextResponse.json({ error: 'not found' }, { status: 404 })
    if (!op?.party_id) throw new Error('The opportunity needs an account before an estimate can be created')
    // The revision pins the conversion inputs: an identical retry replays
    // the first quote, while a reused key over an edited opportunity
    // conflicts instead of returning a stale quote as though it matched.
    const match = { opportunity_id: id, opportunity_revision: String(op.revision_seq ?? '') }
    const claim = await claimSetupCreate(tx, { orgId: user.orgId, table: 'documents', key: draftId, match })
    if (claim.kind === 'replay') {
      const live = (await tx.execute<{ id: string; document_number: string }>(sql`
        select id, document_number from documents where id = ${draftId} and org_id = ${user.orgId}`)).rows[0]
      if (live) return { replay: true as const, id: live.id, documentNumber: live.document_number }
    }
    // Every source line must be represented on the quote: document lines
    // require an item or an account (doc_lines_target), and opportunity
    // lines carry no account, so an itemless line has nowhere to post —
    // inventing an account would be a silent financial fallback. Refuse by
    // name, listing the lines, before the number is consumed or anything is
    // written. (A non-null item_id always joins: the line FK is composite on
    // (org_id, item_id), so the item exists in this org by construction.)
    const itemless = (await tx.execute<{ line_number: number }>(sql`
      select line_number from crm_opportunity_lines
       where org_id = ${user.orgId} and opportunity_id = ${id} and item_id is null
       order by line_number`)).rows
    if (itemless.length) {
      return NextResponse.json({ error: t('opportunities.estimateItemlessLines',
        { lines: itemless.map((row) => String(row.line_number)).join(', ') }) }, { status: 422 })
    }
    const sequence = (await tx.execute<{ prefix: string; next_number: number; padding: number }>(sql`
      insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
      values (${user.orgId}, 'quote', null, 'EST-')
      on conflict on constraint sequences_org_kind_sub do update set next_number = number_sequences.next_number + 1
      where number_sequences.org_id = ${user.orgId}
      returning prefix, next_number, padding`))
    const seq = sequence.rows[0]!
    const number = `${seq.prefix}${String(seq.next_number).padStart(seq.padding, '0')}`
    const projected = persistEstimateProjectedAmount(op.projected_amount ?? '0')
    const document = (await tx.execute<{ id: string }>(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, due_date, currency,
         status, department_id, location_id, class_id, extra_dims, memo, subtotal, tax_total, total,
         created_by, updated_by)
      values (${draftId}, ${user.orgId}, 'quote', ${number}, ${op.party_id}, ${op.subsidiary_id}, ${today},
              ${op.expected_close_date}, ${op.currency}, 'draft', ${op.department_id}, ${op.location_id},
              ${op.class_id}, ${JSON.stringify(op.extra_dims ?? {})}::jsonb, ${op.title}, ${projected},
              0, ${projected}, ${user.id}, ${user.id}) returning id`))
    const docId = document.rows[0]!.id
    const lines = (await tx.execute(sql`select * from crm_opportunity_lines where opportunity_id = ${id} and org_id = ${user.orgId} order by line_number`))
    for (const line of lines.rows) await tx.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, item_id, account_id, description, quantity, unit, unit_price,
         amount, tax_amount, created_by, updated_by)
      select ${user.orgId}, ${docId}, ${line.line_number}, ${line.item_id}, i.income_account_id,
             ${line.description}, ${persistEstimateLineQuantity(line.quantity)}, ${line.unit}, ${persistEstimateLineUnitPrice(line.unit_price)},
             ${persistEstimateLineAmount(line.amount)}, 0, ${user.id}, ${user.id}
        from items i where i.id = ${line.item_id} and i.org_id = ${user.orgId}`)
    await tx.execute(sql`
      insert into crm_opportunity_documents (org_id, opportunity_id, document_id, created_by, updated_by)
      values (${user.orgId}, ${id}, ${docId}, ${user.id}, ${user.id})`)
    // The replay lookup reads this row's match image: without it a retry
    // could never replay and every key would conflict.
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (${user.orgId}, 'documents', ${docId}, 'insert', ${JSON.stringify({ match })}::jsonb, ${user.id}, ${draftId})`)
    return { replay: false as const, id: docId, documentNumber: number }
  }).catch((error: unknown) => {
    if (error instanceof SetupCreateConflict) {
      return NextResponse.json({ error: t('opportunities.estimateKeyConflict') }, { status: error.status })
    }
    return { error: error instanceof Error ? error.message : 'Could not create estimate' }
  })
  if (result instanceof NextResponse) return result
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 422 })
  return NextResponse.json({ id: result.id, documentNumber: result.documentNumber }, { status: result.replay ? 200 : 201 })
}
