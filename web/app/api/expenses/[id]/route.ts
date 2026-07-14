import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { regenerateGlImpactTx, ClosedPeriodError } from '@openbooks/engine/src/posting.ts'
import { guardPermission } from '../../../../lib/authz'
import { computeBillTotals, taxRateMap, type BillLineInput } from '../../../../lib/bills'
import { loadExpenseReport } from '../../../../lib/expenses'
import { loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'

export const runtime = 'nodejs'

async function controlDeps(orgId: string) {
  const r = (await db.execute(sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`)) as any
  const c = r.rows[0]?.c ?? {}
  return {
    control: {
      ar: c.ar,
      ap: c.ap,
      bank: c.bank,
      taxCollected: c.taxCollected,
      taxPaid: c.taxPaid,
      employeePayable: c.employeePayable,
    },
  }
}

/**
 * A document-layer signature of everything that shapes an expense report's GL
 * impact (party, posting/document date, currency, and each line's account/item/
 * amount/tax/dimensions). Comparing this before vs after a save tells us whether
 * the edit was GL-affecting — WITHOUT assuming the stored entry was produced by
 * our own posting rules. Non-GL edits (memo) leave this unchanged and never
 * touch the ledger.
 */
async function glSignature(tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }, id: string): Promise<string> {
  const r = (await tx.execute(sql`
    select md5(
      coalesce(d.party_id::text,'') || '~' || coalesce(d.document_date::text,'') || '~' ||
      coalesce(d.posting_date::text,'') || '~' || coalesce(d.currency,'') || '~' || coalesce(d.fx_rate::text,'') || '~' ||
      coalesce((select string_agg(
        coalesce(account_id::text,'') || ':' || coalesce(item_id::text,'') || ':' || amount::text || ':' ||
        coalesce(tax_code_id::text,'') || ':' || tax_amount::text || ':' ||
        coalesce(department_id::text,'') || ':' || coalesce(project_id::text,'') || ':' ||
        coalesce(location_id::text,'') || ':' || coalesce(class_id::text,''),
        '|' order by line_number)
        from document_lines where document_id = d.id), '')
    ) as sig
    from documents d where d.id = ${id}`)) as { rows: { sig: string }[] }
  return r.rows[0]?.sig ?? ''
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('expenses.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const report = await loadExpenseReport(id)
  if (!report) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(report)
}

/**
 * Autosave an expense report. Draft/approved reports edit freely (no GL yet). A
 * POSTED report is editable in place, NetSuite-style: its journal entry is a
 * derived projection re-materialized on save (regenerateGlImpactTx) — a non-GL
 * change (memo) is a no-op on the ledger; a GL change regenerates the entry's
 * lines and is blocked only if the posting period is closed.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('expenses.create')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params

  const existing = (await db.execute(
    sql`select status from documents where id = ${id} and kind = 'expense_report' and org_id = ${user.orgId}`,
  )) as unknown as { rows: { status: string }[] }
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (existing.rows[0].status === 'voided') {
    return NextResponse.json({ error: 'a voided expense report cannot be edited' }, { status: 422 })
  }
  const deps = await controlDeps(user.orgId)

  const body = (await req.json()) as {
    partyId?: string | null
    documentDate?: string
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
    loadFieldDefs('documents', 'expense_report'),
    loadFieldDefs('document_lines', 'expense_report'),
  ])
  let headerCustom: Record<string, unknown> | null = null
  if (body.custom !== undefined) {
    const v = validateCustomValues(headerDefs, body.custom)
    if (!v.ok) return NextResponse.json({ error: Object.values(v.errors)[0], fieldErrors: v.errors }, { status: 422 })
    headerCustom = v.cleaned
  }

  // Pre-validate + prepare lines (read-only) before touching the DB, so a bad
  // line returns 422 without a partial write.
  let totals: { subtotal: string; taxTotal: string; total: string } | null = null
  let preparedLines: { accountId: string; description: string | null; amount: string; taxCodeId: string | null; taxAmount: string; departmentId: string | null; projectId: string | null; custom: Record<string, unknown> }[] | null = null
  if (body.lines) {
    const valid = body.lines.filter((l) => l.accountId && Number(l.amount) > 0)
    const computed = computeBillTotals(valid, await taxRateMap())
    totals = computed
    preparedLines = []
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
      preparedLines.push({
        accountId: l.accountId!,
        description: l.description ?? null,
        amount: l.amount,
        taxCodeId: l.taxCodeId ?? null,
        taxAmount: l.taxAmount,
        departmentId: l.departmentId ?? null,
        projectId: l.projectId ?? null,
        custom: lv.cleaned,
      })
    }
  }

  // All writes + the GL-Impact re-materialization happen in one transaction, so
  // a GL edit into a closed period rolls the whole edit back (nothing partial).
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('openbooks.amend', 'on', true)`)
      const sigBefore = await glSignature(tx, id)

      if (preparedLines) {
        await tx.execute(sql`delete from document_lines where document_id = ${id}`)
        for (let i = 0; i < preparedLines.length; i++) {
          const l = preparedLines[i]!
          await tx.execute(sql`
            insert into document_lines (org_id, document_id, line_number, account_id, description,
                                        quantity, unit_price, amount, tax_code_id, tax_amount,
                                        department_id, project_id, custom)
            values (${user.orgId}, ${id}, ${i + 1}, ${l.accountId}, ${l.description},
                    '1', ${l.amount}, ${l.amount}, ${l.taxCodeId}, ${l.taxAmount},
                    ${l.departmentId}, ${l.projectId}, ${JSON.stringify(l.custom)})
          `)
        }
      }

      await tx.execute(sql`
        update documents set
          party_id = coalesce(${body.partyId ?? null}, party_id),
          document_date = coalesce(${body.documentDate ?? null}, document_date),
          memo = ${body.memo !== undefined ? body.memo : sql`memo`},
          custom = coalesce(${headerCustom ? JSON.stringify(headerCustom) : null}::jsonb, custom),
          subtotal = coalesce(${totals?.subtotal ?? null}, subtotal),
          tax_total = coalesce(${totals?.taxTotal ?? null}, tax_total),
          total = coalesce(${totals?.total ?? null}, total),
          updated_at = now(), updated_by = ${user.id}
        where id = ${id}
      `)

      // Re-materialize the GL-Impact projection only when the edit actually
      // changed GL-relevant fields (no-op for draft/approved reports and for
      // non-GL edits like memo, which preserves migrated GL).
      if ((await glSignature(tx, id)) !== sigBefore) {
        await regenerateGlImpactTx(tx, id, deps, user.id)
      }
    })
  } catch (e) {
    if (e instanceof ClosedPeriodError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }

  const report = await loadExpenseReport(id)
  return NextResponse.json(report)
}
