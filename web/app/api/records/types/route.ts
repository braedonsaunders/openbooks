import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

/** All of the org's record types (builder data source). */
export async function GET() {
  const gate = await guardPermission('records.manage_types')
  if (gate instanceof NextResponse) return gate
  const r = (await db.execute(sql`
    select t.id, t.key, t.name, t.plural_name, t.icon_key, t.description, t.fields,
           t.status, t.show_in_nav, t.allowed_roles, t.sort_order, t.updated_at,
           (select count(*) from custom_records cr where cr.type_id = t.id) as record_count
      from custom_record_types t
     where t.org_id = ${gate.user.orgId}
     order by t.sort_order, t.name
  `)) as any
  return NextResponse.json({ types: r.rows })
}

/**
 * Instant-into-draft for the type builder: create an empty draft record type
 * with a unique placeholder key and return its id — the builder drawer opens
 * on it immediately and autosaves from there.
 */
export async function POST() {
  const gate = await guardPermission('records.manage_types')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

  const existing = (await db.execute(sql`
    select key from custom_record_types
     where org_id = ${user.orgId} and key like 'new-record-type%'
  `)) as unknown as { rows: { key: string }[] }
  const taken = new Set(existing.rows.map((r) => r.key))
  let key = 'new-record-type'
  for (let n = 2; taken.has(key); n++) key = `new-record-type-${n}`

  const r = (await db.execute(sql`
    insert into custom_record_types (org_id, key, name, plural_name, created_by, updated_by)
    values (${user.orgId}, ${key}, 'New record type', 'New records', ${user.id}, ${user.id})
    returning id
  `)) as unknown as { rows: { id: string }[] }
  return NextResponse.json({ id: r.rows[0]!.id })
}
