import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { nextNumber } from '@openbooks/engine/src/payments.ts'
import { guardPermission } from '@/lib/authz'
import { guardLienWaiverFeature, loadLienWaivers } from '@/lib/compliance'
import { isUuid, pickString } from '@/lib/list-params'

export const runtime = 'nodejs'

const WAIVER_TYPES = new Set([
  'conditional_progress',
  'unconditional_progress',
  'conditional_final',
  'unconditional_final',
])

export async function GET(req: Request) {
  const gate = await guardPermission('compliance.read')
  if (gate instanceof NextResponse) return gate
  const blocked = await guardLienWaiverFeature(gate.user.orgId)
  if (blocked) return blocked
  const url = new URL(req.url)
  const direction = pickString(url.searchParams.get('direction') ?? undefined)
  const waivers = await loadLienWaivers({
    orgId: gate.user.orgId,
    direction: direction === 'received' || direction === 'issued' ? direction : null,
    status: pickString(url.searchParams.get('status') ?? undefined) ?? null,
    projectId: pickString(url.searchParams.get('projectId') ?? undefined) ?? null,
    partyId: pickString(url.searchParams.get('partyId') ?? undefined) ?? null,
  })
  return NextResponse.json({ waivers })
}

/**
 * Create a lien waiver.
 *
 * A waiver is a non-posting document: no journal entry, no lines. What makes it
 * load-bearing is its through-date and amount, which the payment control reads
 * directly — so both are required, and the amount defaults from the bill it
 * covers rather than being retyped.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('compliance.manage')
  if (gate instanceof NextResponse) return gate
  const blocked = await guardLienWaiverFeature(gate.user.orgId)
  if (blocked) return blocked
  const { orgId, id: actorId } = gate.user

  const body = (await req.json()) as {
    direction?: 'received' | 'issued'
    partyId?: string
    projectId?: string
    waiverType?: string
    throughDate?: string
    amount?: string
    currency?: string
    jurisdiction?: string | null
    billDocumentId?: string | null
    payApplicationId?: string | null
    notes?: string | null
  }
  const direction = body.direction === 'issued' ? 'issued' : 'received'
  if (!isUuid(body.partyId ?? '')) return NextResponse.json({ error: 'partyId is required' }, { status: 400 })
  if (!isUuid(body.projectId ?? '')) {
    return NextResponse.json({ error: 'a lien waiver is always against a project' }, { status: 400 })
  }
  if (!body.throughDate) return NextResponse.json({ error: 'throughDate is required' }, { status: 400 })

  const [org] = (
    (await db.execute(sql`select base_currency from orgs where id = ${orgId}`)) as unknown as {
      rows: { base_currency: string }[]
    }
  ).rows
  const project = (await db.execute(sql`
    select p.id, cls.default_lien_waiver_type as class_default
      from projects p
      left join vendor_roles vr on vr.org_id = p.org_id and vr.party_id = ${body.partyId}
      left join compliance_classes cls on cls.id = vr.compliance_class_id and cls.org_id = p.org_id
     where p.org_id = ${orgId} and p.id = ${body.projectId}
  `)) as unknown as { rows: { id: string; class_default: string | null }[] }
  if (project.rows.length === 0) return NextResponse.json({ error: 'project not found' }, { status: 404 })

  const waiverType = body.waiverType ?? project.rows[0]!.class_default ?? 'unconditional_progress'
  if (!WAIVER_TYPES.has(waiverType)) {
    return NextResponse.json({ error: 'unknown lien waiver type' }, { status: 400 })
  }

  // Default the amount from the bill being released, so the released figure and
  // the money it releases cannot drift apart through a typo.
  let amount = body.amount ?? null
  let currency = body.currency ?? org?.base_currency ?? 'USD'
  if (body.billDocumentId && isUuid(body.billDocumentId)) {
    const bill = (await db.execute(sql`
      select coalesce(open_balance, total) as amount, currency, party_id
        from documents
       where org_id = ${orgId} and id = ${body.billDocumentId}
         and kind in ('vendor_bill', 'expense_report')
    `)) as unknown as { rows: { amount: string; currency: string; party_id: string | null }[] }
    const row = bill.rows[0]
    if (!row) return NextResponse.json({ error: 'bill not found' }, { status: 404 })
    if (row.party_id !== body.partyId) {
      return NextResponse.json({ error: 'that bill belongs to a different vendor' }, { status: 422 })
    }
    amount = amount ?? row.amount
    currency = body.currency ?? row.currency
  }
  if (amount === null) return NextResponse.json({ error: 'amount is required' }, { status: 400 })

  try {
    const waiverNumber = await nextNumber(orgId, 'lien_waiver', 'LW-')
    const inserted = (await db.execute(sql`
      insert into lien_waivers
        (org_id, waiver_number, direction, party_id, project_id, waiver_type, status,
         through_date, amount, currency, jurisdiction, bill_document_id, pay_application_id,
         notes, created_by, updated_by)
      values (${orgId}, ${waiverNumber}, ${direction}, ${body.partyId}, ${body.projectId},
              ${waiverType}, 'draft', ${body.throughDate}, ${amount}, ${currency},
              ${body.jurisdiction ?? null}, ${body.billDocumentId ?? null},
              ${body.payApplicationId ?? null}, ${body.notes ?? null}, ${actorId}, ${actorId})
      returning id
    `)) as unknown as { rows: { id: string }[] }
    const id = inserted.rows[0]!.id
    await db.execute(sql`
      insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'lien_waivers', ${id}, 'insert',
              ${JSON.stringify({ after: { waiverNumber, direction, waiverType, amount, currency, ...body } })}::jsonb,
              ${actorId})`)
    return NextResponse.json({ id, waiverNumber })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'save failed' }, { status: 400 })
  }
}
