import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { computeBillTotals, loadBill, taxRateMap, type BillLineInput } from '../../../../lib/bills'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ap.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const bill = await loadBill(id)
  if (!bill) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(bill)
}

/** Autosave for draft bills: header fields and/or full line replacement. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ap.create')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params

  const existing = (await db.execute(
    sql`select status from documents where id = ${id} and kind = 'vendor_bill' and org_id = ${user.orgId}`,
  )) as unknown as { rows: { status: string }[] }
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (existing.rows[0].status !== 'draft') {
    return NextResponse.json({ error: 'only draft bills can be edited' }, { status: 422 })
  }

  const body = (await req.json()) as {
    partyId?: string | null
    documentDate?: string
    dueDate?: string | null
    referenceNumber?: string | null
    memo?: string | null
    lines?: BillLineInput[]
  }

  let totals: { subtotal: string; taxTotal: string; total: string } | null = null
  if (body.lines) {
    const valid = body.lines.filter((l) => l.accountId && Number(l.amount) > 0)
    const computed = computeBillTotals(valid, await taxRateMap())
    totals = computed

    await db.execute(sql`delete from document_lines where document_id = ${id}`)
    for (let i = 0; i < computed.lines.length; i++) {
      const l = computed.lines[i]!
      await db.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    quantity, unit_price, amount, tax_code_id, tax_amount)
        values (${user.orgId}, ${id}, ${i + 1}, ${l.accountId}, ${l.description ?? null},
                '1', ${l.amount}, ${l.amount}, ${l.taxCodeId ?? null}, ${l.taxAmount})
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
      subtotal = coalesce(${totals?.subtotal ?? null}, subtotal),
      tax_total = coalesce(${totals?.taxTotal ?? null}, tax_total),
      total = coalesce(${totals?.total ?? null}, total),
      updated_at = now(), updated_by = ${user.id}
    where id = ${id}
  `)

  const bill = await loadBill(id)
  return NextResponse.json(bill)
}
