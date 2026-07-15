import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

/** Targets a custom field can extend, with the kinds that narrow them. The
 *  transaction document kinds mirror the customization registry's RECORD_TYPES
 *  so the Forms designer can create header/line fields for any transaction
 *  form (bills, credits, card charges/refunds, checks) inline. */
export const FIELD_TARGETS = [
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
  { table: 'accounts', kinds: [] },
  { table: 'items', kinds: [] },
] as const

const FIELD_TYPES = ['text', 'long_text', 'number', 'currency', 'date', 'boolean', 'select', 'multi_select', 'reference']

const REFERENCE_TABLES = ['parties', 'projects', 'accounts', 'items']

function validateDef(body: Record<string, unknown>): string | null {
  const target = FIELD_TARGETS.find((t) => t.table === body.targetTable)
  if (!target) return 'invalid target table'
  if (body.targetKind && !(target.kinds as readonly string[]).includes(String(body.targetKind))) {
    return 'invalid target kind for that table'
  }
  if (!/^[a-z][a-z0-9_]{1,60}$/.test(String(body.key ?? ''))) {
    return 'key must be snake_case (a-z, 0-9, _)'
  }
  if (!body.label || String(body.label).length > 120) return 'label required'
  if (!FIELD_TYPES.includes(String(body.fieldType))) return 'invalid field type'
  if (['select', 'multi_select'].includes(String(body.fieldType))) {
    const opts = (body.config as { options?: unknown })?.options
    if (!Array.isArray(opts) || opts.length === 0 || opts.some((o) => typeof o !== 'string' || !o)) {
      return 'select fields need at least one option'
    }
  }
  if (String(body.fieldType) === 'reference') {
    const cfg = body.config as { referenceTable?: unknown } | undefined
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
  const body = (await req.json()) as Record<string, unknown>
  const err = validateDef(body)
  if (err) return NextResponse.json({ error: err }, { status: 400 })

  const dup = (await db.execute(sql`
    select 1 from custom_field_defs
     where org_id = ${user.orgId} and target_table = ${body.targetTable}
       and coalesce(target_kind, '') = coalesce(${body.targetKind ?? null}, '')
       and key = ${body.key}
  `)) as unknown as { rows: unknown[] }
  if (dup.rows.length > 0) return NextResponse.json({ error: 'a field with that key already exists on that target' }, { status: 409 })

  const r = (await db.execute(sql`
    insert into custom_field_defs (org_id, target_table, target_kind, key, label, field_type, config, is_required, sort_order)
    values (${user.orgId}, ${body.targetTable}, ${body.targetKind ?? null}, ${body.key}, ${body.label},
            ${body.fieldType}, ${JSON.stringify(body.config ?? {})}, ${body.isRequired === true}, ${Number(body.sortOrder ?? 0)})
    returning id
  `)) as unknown as { rows: { id: string }[] }
  return NextResponse.json({ id: r.rows[0]!.id })
}

export async function PATCH(req: Request) {
  const gate = await guardPermission('admin.custom_fields.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const body = (await req.json()) as Record<string, unknown>
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  if (!body.label || !FIELD_TYPES.includes(String(body.fieldType))) {
    return NextResponse.json({ error: 'label and valid field type required' }, { status: 400 })
  }
  if (String(body.fieldType) === 'reference') {
    const cfg = body.config as { referenceTable?: unknown } | undefined
    if (!cfg?.referenceTable || !REFERENCE_TABLES.includes(String(cfg.referenceTable))) {
      return NextResponse.json({ error: 'reference fields need a valid referenceTable' }, { status: 400 })
    }
  }
  await db.execute(sql`
    update custom_field_defs set
      label = ${body.label},
      field_type = ${body.fieldType},
      config = ${JSON.stringify(body.config ?? {})},
      is_required = ${body.isRequired === true},
      sort_order = ${Number(body.sortOrder ?? 0)},
      is_active = ${body.isActive !== false},
      updated_at = now()
    where id = ${body.id} and org_id = ${user.orgId}
  `)
  return NextResponse.json({ ok: true })
}
