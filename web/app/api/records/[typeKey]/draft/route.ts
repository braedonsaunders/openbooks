import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { resolveDefaultValue, type FieldValueMap } from '@openbooks/forms-core'
import { guardPermission } from '../../../../../lib/authz'
import { nextDocumentNumber } from '../../../../../lib/bills'
import { buildSearchText, inTypeAudience, loadRecordTypeByKey } from '../../../../../lib/records'
import {
  lintRecordFields,
  recordNumberPrefix,
  withComputedFormulas,
} from '../../../../../lib/record-schema'

export const runtime = 'nodejs'

/**
 * Instant-into-draft for a generated record module: allocate the next
 * per-type record number ('custrec:'+typeKey in number_sequences), seed
 * field defaults (today/now/current-user/expression), persist, and return
 * the id for the flyout to open.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ typeKey: string }> }) {
  const gate = await guardPermission('records.create')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { typeKey } = await params

  const type = await loadRecordTypeByKey(user.orgId, typeKey)
  if (!type || type.status !== 'published' || !inTypeAudience(user.role, type.allowed_roles)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const lint = lintRecordFields(type.fields, type.name)
  if (!lint.success) {
    return NextResponse.json({ error: 'This record type has an invalid definition' }, { status: 422 })
  }

  const values: FieldValueMap = {}
  const ctx = {
    values,
    rows: {},
    requestContext: { now: new Date(), currentUserName: user.name ?? null },
  }
  // Seed header-field defaults (today/now/current-user/expression); repeating
  // line lists start empty — rows and their defaults are added in the drawer.
  for (const section of lint.sections) {
    if (section.repeating) {
      values[section.id] = []
      continue
    }
    for (const field of section.fields) {
      if (!field.defaultValue) continue
      const v = resolveDefaultValue(field.defaultValue, ctx)
      if (v !== undefined && v !== null && v !== '') values[field.id] = v
    }
  }
  const data = withComputedFormulas(lint.sections, values)

  const recordNumber = await nextDocumentNumber(
    user.orgId,
    `custrec:${typeKey}`,
    recordNumberPrefix(typeKey),
  )
  const searchText = await buildSearchText(lint.sections, data, recordNumber)

  const r = (await db.execute(sql`
    insert into custom_records (org_id, type_id, type_key, record_number, data, search_text, created_by, updated_by)
    values (${user.orgId}, ${type.id}, ${typeKey}, ${recordNumber}, ${JSON.stringify(data)}::jsonb,
            ${searchText}, ${user.id}, ${user.id})
    returning id, record_number
  `)) as unknown as { rows: { id: string; record_number: string }[] }

  return NextResponse.json({ id: r.rows[0]!.id, recordNumber: r.rows[0]!.record_number })
}
