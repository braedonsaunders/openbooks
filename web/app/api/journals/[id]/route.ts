import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { sum } from '@openbooks/engine/src/money.ts'
import { guardPermission } from '../../../../lib/authz'
import { loadJournalDoc } from '../../../../lib/journals'
import { loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('gl.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const journal = await loadJournalDoc(id)
  if (!journal) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(journal)
}

interface JournalLineInput {
  accountId: string
  description?: string | null
  /** Signed base amount: + debit / − credit. */
  amount: string
  departmentId?: string | null
  projectId?: string | null
  custom?: Record<string, unknown>
}

/** Autosave for draft manual journals: header fields and/or full line replacement. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('gl.post')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params

  const existing = (await db.execute(
    sql`select status from documents where id = ${id} and kind = 'journal' and org_id = ${user.orgId}`,
  )) as unknown as { rows: { status: string }[] }
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (existing.rows[0].status !== 'draft') {
    return NextResponse.json({ error: 'only draft journals can be edited' }, { status: 422 })
  }

  const body = (await req.json()) as {
    partyId?: string | null
    documentDate?: string
    referenceNumber?: string | null
    memo?: string | null
    custom?: Record<string, unknown>
    lines?: JournalLineInput[]
  }

  // custom-field validation (header + line) against the live definitions
  const [headerDefs, lineDefs] = await Promise.all([
    loadFieldDefs('documents', 'journal'),
    loadFieldDefs('document_lines', 'journal'),
  ])
  let headerCustom: Record<string, unknown> | null = null
  if (body.custom !== undefined) {
    const v = validateCustomValues(headerDefs, body.custom)
    if (!v.ok) return NextResponse.json({ error: Object.values(v.errors)[0], fieldErrors: v.errors }, { status: 422 })
    headerCustom = v.cleaned
  }

  // journal totals = sum of debits (positive line amounts); tax never applies
  let totalDebits: string | null = null
  if (body.lines) {
    const valid = body.lines.filter(
      (l) => l.accountId && !Number.isNaN(Number(l.amount)) && Number(l.amount) !== 0,
    )
    totalDebits = sum(valid.map((l) => (Number(l.amount) > 0 ? l.amount : '0')))

    await db.execute(sql`delete from document_lines where document_id = ${id}`)
    for (let i = 0; i < valid.length; i++) {
      const l = valid[i]!
      const lv = validateCustomValues(lineDefs, l.custom)
      if (!lv.ok) {
        return NextResponse.json(
          { error: `Line ${i + 1}: ${Object.values(lv.errors)[0]}`, fieldErrors: lv.errors },
          { status: 422 },
        )
      }
      await db.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    quantity, unit_price, amount, department_id, project_id, custom)
        values (${user.orgId}, ${id}, ${i + 1}, ${l.accountId}, ${l.description ?? null},
                '1', ${l.amount}, ${l.amount}, ${l.departmentId ?? null}, ${l.projectId ?? null},
                ${JSON.stringify(lv.cleaned)})
      `)
    }
  }

  await db.execute(sql`
    update documents set
      party_id = ${body.partyId !== undefined ? body.partyId : sql`party_id`},
      document_date = coalesce(${body.documentDate ?? null}, document_date),
      reference_number = ${body.referenceNumber !== undefined ? body.referenceNumber : sql`reference_number`},
      memo = ${body.memo !== undefined ? body.memo : sql`memo`},
      custom = coalesce(${headerCustom ? JSON.stringify(headerCustom) : null}::jsonb, custom),
      subtotal = coalesce(${totalDebits}, subtotal),
      total = coalesce(${totalDebits}, total),
      updated_at = now(), updated_by = ${user.id}
    where id = ${id}
  `)

  const journal = await loadJournalDoc(id)
  return NextResponse.json(journal)
}
