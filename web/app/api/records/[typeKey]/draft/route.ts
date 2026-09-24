import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { resolveDefaultValue, type FieldValueMap } from '@openbooks/forms-core'
import { guardPermission } from '../../../../../lib/authz'
import { nextDocumentNumber } from "../../../../../lib/bills.ts";
import { buildSearchText, hasSubsidiaryField, inTypeAudience, loadRecordTypeByKey } from '../../../../../lib/records'
import {
  lintRecordFields,
  recordNumberPrefix,
  stripUnknownData,
  validateRecordData,
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
  if (!type || type.status !== 'published' || !inTypeAudience(user.roles.map(({ key }) => key), type.allowed_roles)) {
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
    requestContext: {
      now: new Date(),
      today: await businessToday(user.orgId),
      currentUserName: user.name ?? null,
    },
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
  if (gate.allowedSubsidiaryIds !== null && hasSubsidiaryField(lint.sections)) {
    const allowed = [...gate.allowedSubsidiaryIds]
    if (allowed.length !== 1) {
      return NextResponse.json({ error: 'A single subsidiary must be selected before creating this record' }, { status: 422 })
    }
    values.subsidiary_id = allowed[0]
  }
  const data = withComputedFormulas(lint.sections, values)
  // A draft may be incomplete, but it can't be wrongly typed: seeded
  // default-expression values reach storage here, so validate at 'draft'
  // stage (required checks relaxed, same as an inactive record update) and
  // refuse wrongly-typed values by name. The subsidiary fence token is not a
  // declared field, so validate the stripped bag — mirroring the update path,
  // which validates stripped data while persisting the retained token.
  const errors = validateRecordData(lint.sections, stripUnknownData(lint.sections, data), 'draft')
  if (errors.length > 0) {
    return NextResponse.json(
      {
        error: errors[0]!.message,
        errors,
        issues: errors.map((e) => ({ path: e.fieldId, message: e.message })),
      },
      { status: 422 },
    )
  }

  const recordNumber = await nextDocumentNumber(
    user.orgId,
    `custrec:${typeKey}`,
    recordNumberPrefix(typeKey),
  )
  const searchText = await buildSearchText(user.orgId, lint.sections, data, recordNumber)

  const r = (await db.execute<{ id: string; record_number: string }>(sql`
    insert into custom_records (org_id, type_id, type_key, record_number, data, search_text, created_by, updated_by)
    values (${user.orgId}, ${type.id}, ${typeKey}, ${recordNumber}, ${JSON.stringify(data)}::jsonb,
            ${searchText}, ${user.id}, ${user.id})
    returning id, record_number
  `))

  return NextResponse.json({ id: r.rows[0]!.id, recordNumber: r.rows[0]!.record_number })
}
