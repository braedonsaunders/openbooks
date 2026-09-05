import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { documentRevisionSql, isDocumentRevisionToken } from '@openbooks/engine/src/document-revision.ts'
import { isUuid } from '../../../../lib/list-params'
// Server-only route: importing the engine adapter is fine, and the reserved
// set must come from there so validation cannot drift from what headerValues
// actually exposes at flow runtime.
import { RESERVED_DOCUMENT_FIELD_KEYS } from '@openbooks/engine/src/flows/documents-adapter.ts'
import { guardPermission } from '../../../../lib/authz'
import { isCustomFieldTargetEnabled } from '../../../../lib/customization/gates'

export const runtime = 'nodejs'

/** Targets a custom field can extend, with the kinds that narrow them. The
 *  transaction document kinds mirror the customization registry's RECORD_TYPES
 *  so the Forms designer can create header/line fields for any transaction
 *  form (bills, credits, card charges/refunds, checks) inline. */
const FIELD_TARGETS = [
  {
    table: 'documents',
    kinds: [
      'vendor_bill', 'vendor_credit', 'customer_invoice', 'customer_credit',
      'card_charge', 'card_refund', 'check',
      'vendor_payment', 'customer_payment', 'expense_report', 'journal',
    ],
  },
  {
    table: 'document_lines',
    kinds: [
      'vendor_bill', 'vendor_credit', 'customer_invoice', 'customer_credit',
      'card_charge', 'card_refund', 'check',
      'expense_report', 'journal',
    ],
  },
  { table: 'parties', kinds: [] },
  { table: 'projects', kinds: [] },
  { table: 'managed_properties', kinds: [] },
  { table: 'item_rate_versions', kinds: [] },
  { table: 'accounts', kinds: [] },
  { table: 'items', kinds: [] },
  { table: 'crm_account_profiles', kinds: [] },
  { table: 'crm_activities', kinds: [] },
  { table: 'crm_opportunities', kinds: [] },
] as const

const FIELD_TYPES = ['text', 'long_text', 'number', 'currency', 'date', 'boolean', 'select', 'multi_select', 'reference']

const REFERENCE_TABLES = ['parties', 'projects', 'accounts', 'items']

type ExistingFieldDef = {
  id: string
  updated_at: string
  target_table: string
  target_kind: string | null
  key: string
  label: string
  field_type: string
  config: unknown
  is_required: boolean
  sort_order: number
  is_active: boolean
}

function validateDef(body: Record<string, unknown>, existing?: ExistingFieldDef): string | null {
  const targetTable = body.targetTable === undefined ? existing?.target_table : body.targetTable
  const targetKind = body.targetKind === undefined ? existing?.target_kind : body.targetKind
  const key = body.key === undefined ? existing?.key : body.key
  const label = body.label === undefined ? existing?.label : body.label
  const fieldType = body.fieldType === undefined ? existing?.field_type : body.fieldType
  const config = body.config === undefined ? existing?.config : body.config

  if (existing) {
    if (body.targetTable !== undefined && body.targetTable !== existing.target_table) {
      return 'target table cannot be changed'
    }
    if (body.targetKind !== undefined && (body.targetKind ?? null) !== existing.target_kind) {
      return 'target kind cannot be changed'
    }
    if (body.key !== undefined && body.key !== existing.key) {
      return 'key cannot be changed'
    }
  }

  const target = FIELD_TARGETS.find((t) => t.table === targetTable)
  if (!target) return 'invalid target table'
  if (targetKind && !(target.kinds as readonly string[]).includes(String(targetKind))) {
    return 'invalid target kind for that table'
  }
  if (!/^[a-z][a-z0-9_]{1,60}$/.test(String(key ?? ''))) {
    return 'key must be snake_case (a-z, 0-9, _)'
  }
  // A documents key that collides with a real header field would shadow it in
  // flow condition evaluation and {{token}} interpolation (e.g. a custom
  // `total` feeding an approval threshold). Fail closed at registration.
  if (targetTable === 'documents' && RESERVED_DOCUMENT_FIELD_KEYS.has(String(key))) {
    return 'key conflicts with a built-in document field'
  }
  if (!label || String(label).length > 120) return 'label required'
  if (!FIELD_TYPES.includes(String(fieldType))) return 'invalid field type'
  if (['select', 'multi_select'].includes(String(fieldType))) {
    const opts = (config as { options?: unknown })?.options
    if (!Array.isArray(opts) || opts.length === 0 || opts.some((o) => typeof o !== 'string' || !o)) {
      return 'select fields need at least one option'
    }
  }
  if (String(fieldType) === 'reference') {
    const cfg = config as { referenceTable?: unknown } | undefined
    if (!cfg?.referenceTable || !REFERENCE_TABLES.includes(String(cfg.referenceTable))) {
      return 'reference fields need a valid referenceTable (parties, projects, accounts, items)'
    }
  }
  return null
}

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
              ${body.fieldType}, ${JSON.stringify(body.config ?? {})}::jsonb, ${body.isRequired === true}, ${Number(body.sortOrder ?? 0)}, ${user.id}, ${user.id})
      returning custom_field_defs.*, ${documentRevisionSql(sql`created_at`)} as created_at,
                ${documentRevisionSql(sql`updated_at`)} as updated_at
    `)).rows[0]!
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
    const config = body.config === undefined ? existing.config : (body.config ?? {})
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
