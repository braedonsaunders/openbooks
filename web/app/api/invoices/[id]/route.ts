import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { computeBillTotals, taxRateMap, type BillLineInput } from '../../../../lib/bills'
import { loadInvoice } from '../../../../lib/invoices'
import { loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ar.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const invoice = await loadInvoice(id)
  if (!invoice) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(invoice)
}

/** Autosave for draft invoices: header fields and/or full line replacement. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ar.create')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params

  const existing = (await db.execute(
    sql`select status from documents where id = ${id} and kind = 'customer_invoice' and org_id = ${user.orgId}`,
  )) as unknown as { rows: { status: string }[] }
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (existing.rows[0].status !== 'draft') {
    return NextResponse.json({ error: 'only draft invoices can be edited' }, { status: 422 })
  }

  const body = (await req.json()) as {
    partyId?: string | null
    documentDate?: string
    dueDate?: string | null
    referenceNumber?: string | null
    memo?: string | null
    custom?: Record<string, unknown>
    lines?: (BillLineInput & {
      departmentId?: string | null
      projectId?: string | null
      custom?: Record<string, unknown>
    })[]
  }

  // custom-field validation (header + line) against the live definitions
  const [headerDefs, lineDefs] = await Promise.all([
    loadFieldDefs('documents', 'customer_invoice'),
    loadFieldDefs('document_lines', 'customer_invoice'),
  ])
  let headerCustom: Record<string, unknown> | null = null
  if (body.custom !== undefined) {
    const v = validateCustomValues(headerDefs, body.custom)
    if (!v.ok) return NextResponse.json({ error: Object.values(v.errors)[0], fieldErrors: v.errors }, { status: 422 })
    headerCustom = v.cleaned
  }

  let totals: { subtotal: string; taxTotal: string; total: string } | null = null
  if (body.lines) {
    const valid = body.lines.filter((l) => l.accountId && Number(l.amount) > 0)
    const computed = computeBillTotals(valid, await taxRateMap())
    totals = computed

    await db.execute(sql`delete from document_lines where document_id = ${id}`)
    for (let i = 0; i < computed.lines.length; i++) {
      const l = computed.lines[i]! as (typeof computed.lines)[number] & {
        departmentId?: string | null
        projectId?: string | null
        custom?: Record<string, unknown>
      }
      const lv = validateCustomValues(lineDefs, l.custom)
      if (!lv.ok) {
        return NextResponse.json(
          { error: `Line ${i + 1}: ${Object.values(lv.errors)[0]}`, fieldErrors: lv.errors },
          { status: 422 },
        )
      }
      await db.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    quantity, unit_price, amount, tax_code_id, tax_amount,
                                    department_id, project_id, custom)
        values (${user.orgId}, ${id}, ${i + 1}, ${l.accountId}, ${l.description ?? null},
                '1', ${l.amount}, ${l.amount}, ${l.taxCodeId ?? null}, ${l.taxAmount},
                ${l.departmentId ?? null}, ${l.projectId ?? null}, ${JSON.stringify(lv.cleaned)})
      `)
    }
  }

  await db.execute(sql`
    update documents set
      party_id = coalesce(${body.partyId ?? null}, party_id),
      document_date = coalesce(${body.documentDate ?? null}, document_date),
      due_date = ${body.dueDate !== undefined ? body.dueDate : sql`due_date`},
      reference_number = ${body.referenceNumber !== undefined ? body.referenceNumber : sql`reference_number`},
      memo = ${body.memo !== undefined ? body.memo : sql`memo`},
      custom = coalesce(${headerCustom ? JSON.stringify(headerCustom) : null}::jsonb, custom),
      subtotal = coalesce(${totals?.subtotal ?? null}, subtotal),
      tax_total = coalesce(${totals?.taxTotal ?? null}, tax_total),
      total = coalesce(${totals?.total ?? null}, total),
      updated_at = now(), updated_by = ${user.id}
    where id = ${id}
  `)

  const invoice = await loadInvoice(id)
  return NextResponse.json(invoice)
}
