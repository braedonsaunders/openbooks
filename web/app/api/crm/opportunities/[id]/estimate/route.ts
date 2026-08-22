import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'

export const runtime = 'nodejs'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('ar.create', 'crm')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const today = await businessToday(user.orgId)
  const result = await db.transaction(async (tx) => {
    const opportunity = (await tx.execute<any>(sql`
      select * from crm_opportunities where id = ${id} and org_id = ${user.orgId} and is_active for update`))
    const op = opportunity.rows[0]
    if (!op?.party_id) throw new Error('The opportunity needs an account before an estimate can be created')
    const sequence = (await tx.execute<any>(sql`
      insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
      values (${user.orgId}, 'quote', null, 'EST-')
      on conflict on constraint sequences_org_kind_sub do update set next_number = number_sequences.next_number + 1
      returning prefix, next_number, padding`))
    const seq = sequence.rows[0]
    const number = `${seq.prefix}${String(seq.next_number).padStart(seq.padding, '0')}`
    const document = (await tx.execute<{ id: string }>(sql`
      insert into documents
        (org_id, kind, document_number, party_id, subsidiary_id, document_date, due_date, currency,
         status, department_id, location_id, class_id, extra_dims, memo, subtotal, tax_total, total,
         created_by, updated_by)
      values (${user.orgId}, 'quote', ${number}, ${op.party_id}, ${op.subsidiary_id}, ${today},
              ${op.expected_close_date}, ${op.currency}, 'draft', ${op.department_id}, ${op.location_id},
              ${op.class_id}, ${JSON.stringify(op.extra_dims ?? {})}::jsonb, ${op.title}, ${op.projected_amount},
              0, ${op.projected_amount}, ${user.id}, ${user.id}) returning id`))
    const docId = document.rows[0]!.id
    const lines = (await tx.execute<any>(sql`select * from crm_opportunity_lines where opportunity_id = ${id} and org_id = ${user.orgId} order by line_number`))
    for (const line of lines.rows) await tx.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, item_id, account_id, description, quantity, unit, unit_price,
         amount, tax_amount, created_by, updated_by)
      select ${user.orgId}, ${docId}, ${line.line_number}, ${line.item_id}, i.income_account_id,
             ${line.description}, ${line.quantity}, ${line.unit}, ${line.unit_price}, ${line.amount}, 0, ${user.id}, ${user.id}
        from items i where i.id = ${line.item_id} and i.org_id = ${user.orgId}`)
    await tx.execute(sql`
      insert into crm_opportunity_documents (org_id, opportunity_id, document_id, created_by, updated_by)
      values (${user.orgId}, ${id}, ${docId}, ${user.id}, ${user.id})`)
    return { id: docId, documentNumber: number }
  }).catch((error: unknown) => ({ error: error instanceof Error ? error.message : 'Could not create estimate' }))
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 422 })
  return NextResponse.json(result)
}
