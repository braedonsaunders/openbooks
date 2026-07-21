import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { LABOR_RATE_TEMPLATE_BY_ID } from '../../../../../lib/labor-rate-templates'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const { orgId, id: actorId } = gate.user
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const template = LABOR_RATE_TEMPLATE_BY_ID.get(String(body.templateId ?? ''))
  if (!template) return NextResponse.json({ error: 'Unknown labor-rate template' }, { status: 404 })
  const currency = String(body.currency ?? '').toUpperCase()
  const effectiveFrom = String(body.effectiveFrom ?? '')
  const code = String(body.code ?? template.code).trim().toUpperCase()
  const name = String(body.name ?? template.name).trim()
  if (!/^[A-Z]{3}$/.test(currency)) return NextResponse.json({ error: 'Choose an ISO currency' }, { status: 422 })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) return NextResponse.json({ error: 'Choose an effective date' }, { status: 422 })
  if (!/^[A-Z][A-Z0-9_\-]{1,62}$/.test(code) || !name) {
    return NextResponse.json({ error: 'Enter a valid rate-book code and name' }, { status: 422 })
  }

  try {
    const result = await db.transaction(async (tx) => {
      const knownCurrency = (await tx.execute(sql`select 1 from currencies where code = ${currency}`)) as any
      if (!knownCurrency.rows.length) throw new Error('Unknown currency')
      const insertedBook = (await tx.execute(sql`
        insert into item_rate_books (org_id, code, name, currency, is_default, is_active, created_by, updated_by)
        values (${orgId}, ${code}, ${name}, ${currency},
                not exists(select 1 from item_rate_books where org_id = ${orgId} and is_default and is_active),
                true, ${actorId}, ${actorId}) returning id`)) as any
      const rateBookId = String(insertedBook.rows[0].id)
      const insertedVersion = (await tx.execute(sql`
        insert into item_rate_versions (org_id, rate_book_id, effective_from, status, created_by, updated_by)
        values (${orgId}, ${rateBookId}, ${effectiveFrom}, 'draft', ${actorId}, ${actorId}) returning id`)) as any
      const versionId = String(insertedVersion.rows[0].id)

      const classes = new Map<string, string>()
      for (const laborClass of template.classes) {
        await tx.execute(sql`
          insert into labor_classes (org_id, code, name, is_active, created_by, updated_by)
          values (${orgId}, ${laborClass.code}, ${laborClass.name}, true, ${actorId}, ${actorId})
          on conflict (org_id, code) do nothing`)
        const selected = (await tx.execute(sql`
          select id from labor_classes where org_id = ${orgId} and code = ${laborClass.code}`)) as any
        classes.set(laborClass.code, String(selected.rows[0].id))
      }
      for (const timeType of template.timeTypes) {
        const existing = (await tx.execute(sql`
          select id from time_types where org_id = ${orgId} and lower(name) = lower(${timeType.name}) limit 1`)) as any
        if (!existing.rows.length) {
          await tx.execute(sql`
            insert into time_types (org_id, name, cost_multiplier, bill_multiplier, is_billable_default, is_active)
            values (${orgId}, ${timeType.name}, ${timeType.costMultiplier}, ${timeType.billMultiplier}, ${timeType.billable}, true)`)
        }
      }
      for (const line of template.lines) {
        await tx.execute(sql`
          insert into labor_rate_lines
            (org_id, version_id, code, name, lane, method, amount, percent, currency, base_hours,
             labor_class_id, priority, is_active, created_by, updated_by)
          values (${orgId}, ${versionId}, ${line.code}, ${line.name}, ${line.lane}, ${line.method},
                  ${line.amount ?? null}, ${line.percent ?? null}, ${currency}, 1,
                  ${line.laborClassCode ? classes.get(line.laborClassCode) ?? null : null}, ${line.priority ?? 0}, true,
                  ${actorId}, ${actorId})`)
      }
      for (const component of template.components) {
        await tx.execute(sql`
          insert into labor_rate_components
            (org_id, version_id, code, name, lane, method, value, currency, sequence, is_active, created_by, updated_by)
          values (${orgId}, ${versionId}, ${component.code}, ${component.name}, ${component.lane}, ${component.method},
                  ${component.value}, ${component.method === 'fixed_per_hour' ? currency : null}, ${component.sequence}, true,
                  ${actorId}, ${actorId})`)
      }
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'item_rate_books', ${rateBookId}, 'insert',
                ${JSON.stringify({ source: 'labor-rate-template', templateId: template.id, versionId })}, ${actorId})`)
      return { rateBookId, versionId }
    })
    return NextResponse.json(result)
  } catch (error) {
    const code = (error as { code?: string }).code
    const message = code === '23505' ? 'A rate book with this code already exists' : (error as Error).message
    return NextResponse.json({ error: message }, { status: 422 })
  }
}
