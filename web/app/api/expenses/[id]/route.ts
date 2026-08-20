import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { cmp } from '@openbooks/engine/src/money.ts'
import { deleteDocument, DeleteError } from '@openbooks/engine/src/document-delete.ts'
import { captureTransactionAuditSnapshot, recordTransactionAudit } from '@openbooks/engine/src/transaction-audit.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { computeBillTotals, persistLineTaxComponents, taxProfileMap, type BillLineInput } from '../../../../lib/bills'
import { loadExpenseReport } from '../../../../lib/expenses'
import { loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'
import { segmentRegistry, validateExtraDims } from '../../../../lib/segments'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('expenses.read', 'expenses')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const report = await loadExpenseReport(id, gate.user.orgId)
  if (!report) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(report)
}

/**
 * Autosave an expense-report draft. Approval and posted states preserve the
 * submitted evidence; corrections are represented by a separate report.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('expenses.create', 'expenses')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params

  const existing = (await db.execute<{ status: string; document_date: string }>(
    sql`select status, document_date from documents where id = ${id} and kind = 'expense_report' and org_id = ${user.orgId}`,
  ))
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (existing.rows[0].status !== 'draft') {
    return NextResponse.json(
      { error: `a ${existing.rows[0].status} expense report cannot be edited — create a correcting report instead` },
      { status: 422 },
    )
  }
  const body = (await req.json()) as {
    partyId?: string | null
    documentDate?: string
    memo?: string | null
    extraDims?: Record<string, string | null>
    custom?: Record<string, unknown>
    lines?: (BillLineInput & {
      departmentId?: string | null
      projectId?: string | null
      extraDims?: Record<string, string | null>
      custom?: Record<string, unknown>
    })[]
  }

  // custom-field validation (header + line) against the live definitions
  const [headerDefs, lineDefs, segments] = await Promise.all([
    loadFieldDefs('documents', 'expense_report'),
    loadFieldDefs('document_lines', 'expense_report'),
    segmentRegistry(user.orgId),
  ])
  const headerDims = body.extraDims === undefined ? null : validateExtraDims(body.extraDims, segments)
  if (headerDims && !headerDims.ok) return NextResponse.json({ error: headerDims.error }, { status: 422 })
  let headerCustom: Record<string, unknown> | null = null
  if (body.custom !== undefined) {
    const v = validateCustomValues(headerDefs, body.custom)
    if (!v.ok) return NextResponse.json({ error: Object.values(v.errors)[0], fieldErrors: v.errors }, { status: 422 })
    headerCustom = v.cleaned
  }

  // Pre-validate + prepare lines (read-only) before touching the DB, so a bad
  // line returns 422 without a partial write.
  let totals: { subtotal: string; taxTotal: string; total: string } | null = null
  let preparedLines: { accountId: string; description: string | null; amount: string; taxCodeId: string | null; taxGroupId: string | null; taxInputAmount: string; taxAmount: string; taxOverridden: boolean; taxComponents: ReturnType<typeof computeBillTotals>['lines'][number]['taxComponents']; departmentId: string | null; projectId: string | null; extraDims: Record<string, string>; custom: Record<string, unknown> }[] | null = null
  if (body.lines) {
    const valid = body.lines.filter((l) => l.accountId && cmp(l.amount, '0') > 0)
    const computed = computeBillTotals(
      valid,
      await taxProfileMap(user.orgId, body.documentDate ?? existing.rows[0].document_date),
    )
    totals = computed
    preparedLines = []
    for (let i = 0; i < computed.lines.length; i++) {
      const l = computed.lines[i]! as (typeof computed.lines)[number] & {
        departmentId?: string | null
        projectId?: string | null
        extraDims?: Record<string, string | null>
        custom?: Record<string, unknown>
      }
      const lv = validateCustomValues(lineDefs, l.custom)
      if (!lv.ok) {
        return NextResponse.json(
          { error: `Line ${i + 1}: ${Object.values(lv.errors)[0]}`, fieldErrors: lv.errors },
          { status: 422 },
        )
      }
      const lineDims = validateExtraDims(l.extraDims, segments)
      if (!lineDims.ok) return NextResponse.json({ error: `Line ${i + 1}: ${lineDims.error}` }, { status: 422 })
      preparedLines.push({
        accountId: l.accountId!,
        description: l.description ?? null,
        amount: l.amount,
        taxCodeId: l.taxCodeId ?? null,
        taxGroupId: l.taxGroupId ?? null,
        taxInputAmount: l.taxInputAmount,
        taxAmount: l.taxAmount,
        taxOverridden: l.taxOverridden === true,
        taxComponents: l.taxComponents,
        departmentId: l.departmentId ?? null,
        projectId: l.projectId ?? null,
        extraDims: lineDims.cleaned,
        custom: lv.cleaned,
      })
    }
  }

  await db.transaction(async (tx) => {
      const auditBefore = await captureTransactionAuditSnapshot(tx, id)
      if (!auditBefore) throw new Error(`expense report ${id} disappeared before update`)

      if (preparedLines) {
        await tx.execute(sql`delete from document_lines where document_id = ${id} and org_id = ${user.orgId}`)
        for (let i = 0; i < preparedLines.length; i++) {
          const l = preparedLines[i]!
          const inserted = (await tx.execute<{ id: string }>(sql`
            insert into document_lines (org_id, document_id, line_number, account_id, description,
                                        quantity, unit_price, amount, tax_code_id, tax_group_id, tax_input_amount,
                                        tax_amount, tax_overridden,
                                        department_id, project_id, extra_dims, custom)
            values (${user.orgId}, ${id}, ${i + 1}, ${l.accountId}, ${l.description},
                    '1', ${l.amount}, ${l.amount}, ${l.taxCodeId}, ${l.taxGroupId}, ${l.taxInputAmount},
                    ${l.taxAmount}, ${l.taxOverridden},
                    ${l.departmentId}, ${l.projectId}, ${JSON.stringify(l.extraDims)}::jsonb, ${JSON.stringify(l.custom)})
            returning id
          `))
          await persistLineTaxComponents(tx, {
            orgId: user.orgId,
            documentLineId: inserted.rows[0]!.id,
            components: l.taxComponents,
            actorId: user.id,
          })
        }
      }

      await tx.execute(sql`
        update documents set
          party_id = coalesce(${body.partyId ?? null}, party_id),
          document_date = coalesce(${body.documentDate ?? null}, document_date),
          memo = ${body.memo !== undefined ? body.memo : sql`memo`},
          extra_dims = ${headerDims ? JSON.stringify(headerDims.cleaned) : sql`extra_dims`}::jsonb,
          custom = coalesce(${headerCustom ? JSON.stringify(headerCustom) : null}::jsonb, custom),
          subtotal = coalesce(${totals?.subtotal ?? null}, subtotal),
          tax_total = coalesce(${totals?.taxTotal ?? null}, tax_total),
          total = coalesce(${totals?.total ?? null}, total),
          updated_at = now(), updated_by = ${user.id}
        where id = ${id} and org_id = ${user.orgId}
      `)

      const auditAfter = await captureTransactionAuditSnapshot(tx, id)
      if (!auditAfter) throw new Error(`expense report ${id} disappeared during update`)
      await recordTransactionAudit(tx, {
        orgId: user.orgId,
        documentId: id,
        action: 'update',
        actorId: user.id,
        source: 'ui',
        before: auditBefore,
        after: auditAfter,
      })
  })

  const report = await loadExpenseReport(id, user.orgId)
  return NextResponse.json(report)
}

/** Delete an expense report (guarded: open period, no applied payments, no downstream conversion). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('expenses.create', 'expenses')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const owned = (await db.execute(
    sql`select 1 from documents where id = ${id} and kind = 'expense_report' and org_id = ${gate.user.orgId}`,
  ))
  if (!owned.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  try {
    await deleteDocument(id, gate.user.id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof DeleteError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}
