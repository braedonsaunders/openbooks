import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { pgTextArrayLiteral } from '../../../../lib/pg-array'
import { subsidiaryDeclaredTypeIds } from '../../../../lib/records'

export const runtime = 'nodejs'

/** All of the org's record types (builder data source). */
export async function GET() {
  const gate = await guardPermission('records.manage_types')
  if (gate instanceof NextResponse) return gate
  // A subsidiary-restricted type manager sees only the records their fence
  // admits: types that declare subsidiary_id count in-fence rows; field-less
  // types stay org-visible unless a row still carries a JSON subsidiary_id
  // outside the fence (dropping the field must not unscope those rows).
  const fence = gate.allowedSubsidiaryIds
  const scopedTypeIds =
    fence === null
      ? null
      : subsidiaryDeclaredTypeIds(
          (
            await db.execute<{ id: string; name: string; fields: unknown }>(sql`
              select id, name, fields from custom_record_types where org_id = ${gate.user.orgId}`)
          ).rows,
        )
  const countScope =
    fence === null || scopedTypeIds === null
      ? sql``
      : sql`and (
          cr.data ->> ${'subsidiary_id'} = any(${pgTextArrayLiteral([...fence])}::text[])
          or (
            not (t.id = any(${`{${scopedTypeIds.join(',')}}`}::uuid[]))
            and cr.data ->> ${'subsidiary_id'} is null
          )
        )`
  const r = ((await db.execute(sql`
    select t.id, t.key, t.name, t.plural_name, t.icon_key, t.description, t.fields,
           t.status, t.show_in_nav, t.allowed_roles, t.sort_order, t.updated_at,
           (select count(*) from custom_records cr where cr.type_id = t.id ${countScope}) as record_count
      from custom_record_types t
     where t.org_id = ${gate.user.orgId}
     order by t.sort_order, t.name
  `)))
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

  const existing = (await db.execute<{ key: string }>(sql`
    select key from custom_record_types
     where org_id = ${user.orgId} and key like 'new-record-type%'
  `))
  const taken = new Set(existing.rows.map((r) => r.key))
  let key = 'new-record-type'
  for (let n = 2; taken.has(key); n++) key = `new-record-type-${n}`

  const r = (await db.execute<{ id: string }>(sql`
    insert into custom_record_types (org_id, key, name, plural_name, created_by, updated_by)
    values (${user.orgId}, ${key}, 'New record type', 'New records', ${user.id}, ${user.id})
    returning id
  `))
  return NextResponse.json({ id: r.rows[0]!.id })
}
