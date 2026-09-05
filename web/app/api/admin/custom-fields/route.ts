import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { documentRevisionSql, isDocumentRevisionToken } from '@openbooks/engine/src/document-revision.ts'
import { isUuid } from '../../../../lib/list-params'
import { normalizeCustomFieldConfig } from '../../../../lib/custom-field-config'
import { validateCustomFieldDefinition as validateDef, type ExistingFieldDef } from '../../../../lib/custom-field-definition'
import { lockCustomFieldKeys } from '../../../../lib/custom-field-write-lock'
import { guardPermission } from '../../../../lib/authz'
import { isCustomFieldTargetEnabled } from '../../../../lib/customization/gates'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const gate = await guardPermission('admin.custom_fields.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>
  const err = validateDef(body)
  if (err) return NextResponse.json({ error: err }, { status: 400 })
  if (!(await isCustomFieldTargetEnabled(user.orgId, String(body.targetTable), body.targetKind ? String(body.targetKind) : null))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  return db.transaction(async (tx) => {
    await lockCustomFieldKeys(tx, user.orgId, [{ targetTable: String(body.targetTable), key: String(body.key) }])
    const dup = await tx.execute(sql`
      select 1 from custom_field_defs
       where org_id = ${user.orgId} and target_table = ${body.targetTable}
         and coalesce(target_kind, '') = coalesce(${body.targetKind ?? null}, '')
         and key = ${body.key}
    `)
    if (dup.rows.length > 0) return NextResponse.json({ error: 'a field with that key already exists on that target' }, { status: 409 })

    const created = (await tx.execute<ExistingFieldDef>(sql`
      insert into custom_field_defs (org_id, target_table, target_kind, key, label, field_type, config, is_required, sort_order, created_by, updated_by)
      values (${user.orgId}, ${body.targetTable}, ${body.targetKind ?? null}, ${body.key}, ${body.label},
              ${body.fieldType}, ${JSON.stringify(normalizeCustomFieldConfig(body.config))}::jsonb, ${body.isRequired === true}, ${Number(body.sortOrder ?? 0)}, ${user.id}, ${user.id})
      on conflict do nothing
      returning custom_field_defs.*, ${documentRevisionSql(sql`created_at`)} as created_at,
                ${documentRevisionSql(sql`updated_at`)} as updated_at
    `)).rows[0]
    if (!created) return NextResponse.json({ error: 'a field with that key already exists on that target' }, { status: 409 })
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (${user.orgId}, 'custom_field_defs', ${created.id}, 'insert',
              ${JSON.stringify({ after: created })}::jsonb, ${user.id}, ${req.headers.get('X-Request-Id')})
    `)
    return NextResponse.json({ id: created.id, updatedAt: created.updated_at })
  })
}

export async function PATCH(req: Request) {
  const gate = await guardPermission('admin.custom_fields.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const parsedBody2 = await parseJsonBody(req, jsonObject);
  if (!parsedBody2.ok) return parsedBody2.response;
  const body = (parsedBody2.data) as Record<string, unknown>
  if (typeof body.id !== 'string' || !isUuid(body.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (!isDocumentRevisionToken(body.expectedUpdatedAt)) return revisionConflict()

  return db.transaction(async (tx) => {
    const existing = (await tx.execute<ExistingFieldDef>(sql`
      select custom_field_defs.*, ${documentRevisionSql(sql`created_at`)} as created_at,
             ${documentRevisionSql(sql`updated_at`)} as updated_at
        from custom_field_defs
       where id = ${body.id} and org_id = ${user.orgId} for update
    `)).rows[0]
    if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })
    if (!(await isCustomFieldTargetEnabled(user.orgId, existing.target_table, existing.target_kind))) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    if (existing.updated_at !== body.expectedUpdatedAt) return revisionConflict()

    const err = validateDef(body, existing)
    if (err) return NextResponse.json({ error: err }, { status: 400 })

    const label = body.label === undefined ? existing.label : body.label
    const fieldType = body.fieldType === undefined ? existing.field_type : body.fieldType
    const config = normalizeCustomFieldConfig(body.config === undefined ? existing.config : body.config)
    const isRequired = body.isRequired === undefined ? existing.is_required : body.isRequired === true
    const sortOrder = body.sortOrder === undefined ? existing.sort_order : Number(body.sortOrder ?? 0)
    const isActive = body.isActive === undefined ? existing.is_active : body.isActive !== false
    const updated = (await tx.execute<ExistingFieldDef>(sql`
      update custom_field_defs set
        label = ${label}, field_type = ${fieldType}, config = ${JSON.stringify(config)}::jsonb,
        is_required = ${isRequired}, sort_order = ${sortOrder}, is_active = ${isActive},
        updated_by = ${user.id},
        updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
      where id = ${body.id} and org_id = ${user.orgId}
      returning custom_field_defs.*, ${documentRevisionSql(sql`created_at`)} as created_at,
                ${documentRevisionSql(sql`updated_at`)} as updated_at
    `)).rows[0]!
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (${user.orgId}, 'custom_field_defs', ${body.id}, 'update',
              ${JSON.stringify({ before: existing, after: updated })}::jsonb, ${user.id}, ${req.headers.get('X-Request-Id')})
    `)
    return NextResponse.json({ ok: true, updatedAt: updated.updated_at })
  })
}

function revisionConflict() {
  return NextResponse.json({ error: 'The field definition has changed. Reload it before saving.' }, { status: 409 })
}
