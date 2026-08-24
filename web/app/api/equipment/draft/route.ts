import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'

export async function POST() {
  const gate = await guardFeaturePermission('assets.manage', 'equipment')
  if (gate instanceof NextResponse) return gate
  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${gate.user.orgId}::text))`)
    const root = ((await tx.execute(sql`
      select id from subsidiaries where org_id = ${gate.user.orgId} and is_active and not is_elimination
        ${gate.allowedSubsidiaryIds ? sql`and id = any(${`{${[...gate.allowedSubsidiaryIds].join(',')}}`}::uuid[])` : sql``}
       order by (parent_id is null) desc, name limit 1
    `)))
    if (!root.rows[0]) return null
    const seq = ((await tx.execute(sql`
      select coalesce(max((regexp_replace(unit_number, '\\D', '', 'g'))::int), 0) + 1 as n
        from equipment_units where org_id = ${gate.user.orgId} and unit_number ~ '^EQ-\\d+$'
    `)))
    const unitNumber = `EQ-${String(Number(seq.rows[0]?.n ?? 1)).padStart(4, '0')}`
    const inserted = (await tx.execute(sql`
      insert into equipment_units (org_id, subsidiary_id, unit_number, name, status, created_by, updated_by)
      values (${gate.user.orgId}, ${root.rows[0].id}, ${unitNumber}, 'New equipment unit', 'draft', ${gate.user.id}, ${gate.user.id}) returning id
    `)) as any
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${gate.user.orgId}, 'equipment_units', ${inserted.rows[0].id}, 'insert',
              ${JSON.stringify({ unitNumber, status: 'draft' })}::jsonb, ${gate.user.id})
    `)
    return inserted
  })
  if (!created) return NextResponse.json({ error: 'no_available_subsidiary' }, { status: 409 })
  return NextResponse.json({ id: created.rows[0].id })
}
