import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { isIsoCalendarDate } from '@openbooks/engine/src/business-date.ts'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { deleteDocument, DeleteError } from '@openbooks/engine/src/document-delete.ts'
import { captureTransactionAuditSnapshot, recordTransactionAudit } from '@openbooks/engine/src/transaction-audit.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { guardSubsidiaryScope } from '../../../../lib/authz'
import { computeBillTotals, persistLineTaxComponents, taxProfileMap, type BillLineInput } from '../../../../lib/bills'
import {
  DocumentEditError,
  documentRevisionCounterSql,
  requireDocumentEditRevision,
  runDocumentVersionedTransaction,
  validateEditableDocumentLines,
} from '../../../../lib/documents'
import { loadExpenseReport } from '../../../../lib/expenses'
import { isUuid } from '../../../../lib/list-params'
import { findUnownedCustomReferences, loadFieldDefs, validateCustomValues } from '../../../../lib/custom-fields'
import { canonicalDecimal } from '../../../../lib/exact-decimal'
import { segmentRegistry, validateExtraDims } from '../../../../lib/segments'

/** Exact numeric(19,4) money string, or 'invalid'. */
function exactMoney(v: unknown): string | 'invalid' {
  const exact = canonicalDecimal(v, 4)
  if (exact === null) return 'invalid'
  try {
    return normalizeMoney(exact)
  } catch {
    return 'invalid'
  }
}

type RouteTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('expenses.read', 'expenses')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const report = await loadExpenseReport(id, gate.user.orgId)
  if (!report) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Authorize the subsidiary from the same snapshot as the returned content.
  const denied = guardSubsidiaryScope(gate, report.doc.subsidiary_id as string | null)
  if (denied) return denied
  return NextResponse.json(report)
}

/**
 * Autosave an expense-report draft. Approval and posted states preserve the
 * submitted evidence; corrections are represented by a separate report.
 *
 * Saves are fenced by the document's exact revision: the caller echoes the
 * `updated_at` token it loaded, and the write happens only when that token
 * still matches the row locked FOR UPDATE inside the same transaction — so
 * two concurrent saves can never silently overwrite one another.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('expenses.create', 'expenses')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params

  const existing = (await db.execute<{ status: string; document_date: string; subsidiaryId: string | null; custom: Record<string, unknown> | null }>(
    sql`select status, document_date, subsidiary_id as "subsidiaryId", custom from documents where id = ${id} and kind = 'expense_report' and org_id = ${user.orgId}`,
  ))
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(gate, existing.rows[0].subsidiaryId)
  if (denied) return denied
  if (existing.rows[0].status !== 'draft') {
    return NextResponse.json(
      { error: `a ${existing.rows[0].status} expense report cannot be edited — create a correcting report instead` },
      { status: 422 },
    )
  }
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    expectedUpdatedAt?: string
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
  // The document date reaches coalesce(document_date) uncast: a malformed
  // value dies at the storage layer as a raw 500 instead of a domain 422
  // (sibling PATCH routes validate with isoDate). Fail closed here, covering
  // both shape-invalid strings and impossible calendar days.
  if (body.documentDate !== undefined && !isIsoCalendarDate(body.documentDate)) {
    return NextResponse.json({ error: 'invalid documentDate — expected YYYY-MM-DD' }, { status: 422 })
  }
  // The party is the employee being reimbursed. The documents FK is global,
  // so without an org-scoped check this save would persist another tenant's
  // party on the draft (submit and post refuse it later, but the reference
  // itself must never be stored). A null body value keeps the current party.
  if (body.partyId !== undefined && body.partyId !== null) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.partyId)) {
      return NextResponse.json({ error: 'party not found in this organization' }, { status: 404 })
    }
    const owner = (await db.execute<{ id: string }>(
      sql`select id from parties where id = ${body.partyId} and org_id = ${user.orgId}`,
    ))
    if (!owner.rows[0]) return NextResponse.json({ error: 'party not found in this organization' }, { status: 404 })
  }
  // Line accounts are the tenant's chart of accounts. The lines FK is
  // tenant-coherent, so a foreign account dies at the insert as a 500;
  // refuse it here with the same domain 404 as a foreign party, and refuse
  // inactive/summary accounts the posting kernel could never book. A uniform
  // 404 reveals nothing about another tenant's chart.
  if (body.lines !== undefined) {
    const accountIds = [...new Set(body.lines.map((l) => l.accountId).filter((v): v is string => typeof v === 'string' && v.length > 0))]
    const malformed = accountIds.filter((v) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))
    const usable = malformed.length === 0 && accountIds.length > 0
      ? (await db.execute<{ id: string }>(sql`
          select id from accounts
           where org_id = ${user.orgId} and is_active and not is_summary
             and id = any(${`{${accountIds.join(',')}}`}::uuid[])
        `)).rows
      : []
    if (malformed.length > 0 || usable.length !== accountIds.length) {
      return NextResponse.json({ error: 'account not found in this organization' }, { status: 404 })
    }
  }
  // Line departments/projects ride the same uncast path into the re-insert:
  // a malformed id dies as 22P02 and a foreign id as 23503, both unhandled
  // storage errors. Shape-check every submitted reference, then prove tenant
  // ownership batched per table (same contract as the account precheck above
  // and the shared document editor).
  if (body.lines !== undefined) {
    for (let i = 0; i < body.lines.length; i++) {
      const line = body.lines[i]!
      for (const key of ['departmentId', 'projectId'] as const) {
        const value = line[key]
        if (value !== undefined && value !== null && !isUuid(value)) {
          return NextResponse.json({ error: `Line ${i + 1}: invalid ${key}` }, { status: 422 })
        }
      }
    }
    for (const [key, label, table] of [['departmentId', 'department', 'departments'], ['projectId', 'project', 'projects']] as const) {
      const ids = [...new Set(body.lines.map((l) => l[key]).filter((v): v is string => typeof v === 'string' && v.length > 0))]
      if (ids.length === 0) continue
      const owned = new Set((await db.execute<{ id: string }>(sql`
        select id from ${sql.raw(`"${table}"`)} where org_id = ${user.orgId} and id = any(${`{${ids.join(',')}}`}::uuid[])`)).rows.map((r) => r.id))
      const foreign = ids.find((v) => !owned.has(v))
      if (foreign !== undefined) {
        const lineNumber = body.lines.findIndex((l) => l[key] === foreign) + 1
        return NextResponse.json({ error: `Line ${lineNumber}: ${label} not found in this organization` }, { status: 404 })
      }
    }
  }
  // Mandatory optimistic-concurrency evidence — same contract as /api/documents/[id].
  let expectedRevision: string
  try {
    expectedRevision = requireDocumentEditRevision(body.expectedUpdatedAt)
  } catch (e) {
    if (e instanceof DocumentEditError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    throw e
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
    // PATCH custom values are partial: validate the effective bag so an
    // omitted required field can be satisfied by its stored value, then
    // merge the cleaned submitted values over the stored bag so omitted
    // keys survive. The revision guard below rejects the write if a
    // concurrent edit moved the stored bag after this read.
    const existingCustom =
      existing.rows[0].custom && typeof existing.rows[0].custom === 'object'
        ? (existing.rows[0].custom as Record<string, unknown>)
        : {}
    const v = validateCustomValues(headerDefs, { ...existingCustom, ...body.custom })
    if (!v.ok) return NextResponse.json({ error: Object.values(v.errors)[0], fieldErrors: v.errors }, { status: 422 })
    // Reference custom values are uuid-SHAPED at this point but nothing
    // proves the referenced row belongs to the caller: refuse foreign or
    // dangling ids with a tenant-opaque 404 instead of persisting a
    // cross-tenant pointer. Supplied values only, so legacy bags written
    // before this fence cannot lock unrelated edits.
    const suppliedHeaderCustom: Record<string, unknown> = {}
    for (const key of Object.keys(body.custom)) {
      if (v.cleaned[key] !== undefined) suppliedHeaderCustom[key] = v.cleaned[key]
    }
    const unownedHeaderRefs = await findUnownedCustomReferences(user.orgId, headerDefs, suppliedHeaderCustom)
    if (unownedHeaderRefs.length > 0) {
      const def = unownedHeaderRefs[0]!
      return NextResponse.json({ error: `${def.label} not found in this organization` }, { status: 404 })
    }
    headerCustom = { ...existingCustom, ...v.cleaned }
  }

  // Pre-validate + prepare lines (read-only) before touching the DB, so a bad
  // line returns 422 without a partial write.
  let totals: { subtotal: string; taxTotal: string; total: string } | null = null
  let preparedLines: { accountId: string; description: string | null; amount: string; taxCodeId: string | null; taxGroupId: string | null; taxInputAmount: string; taxAmount: string; taxOverridden: boolean; taxComponents: ReturnType<typeof computeBillTotals>['lines'][number]['taxComponents']; departmentId: string | null; projectId: string | null; extraDims: Record<string, string>; custom: Record<string, unknown> }[] | null = null
  if (body.lines) {
    let valid
    try {
      valid = validateEditableDocumentLines(body.lines)
    } catch (e) {
      if (e instanceof DocumentEditError) return NextResponse.json({ error: e.message }, { status: e.status })
      throw e
    }
    const exactLines: typeof valid = []
    for (let i = 0; i < valid.length; i++) {
      const line = valid[i]!
      const amount = exactMoney(line.amount)
      if (amount === 'invalid') {
        return NextResponse.json(
          { error: `Line ${i + 1}: "${line.amount}" is not a valid amount — enter an exact decimal of at most 4 decimal places` },
          { status: 422 },
        )
      }
      let taxAmount = line.taxAmount ?? null
      if (taxAmount != null && String(taxAmount).trim() !== '') {
        const exactTax = exactMoney(taxAmount)
        if (exactTax === 'invalid') {
          return NextResponse.json({ error: `Line ${i + 1}: tax amount is not a valid amount` }, { status: 422 })
        }
        taxAmount = exactTax
      } else {
        taxAmount = null
      }
      exactLines.push({ ...line, amount, taxAmount })
    }
    // An unknown/inactive tax code throws out of the totals engine as a raw
    // Error; translate it into the domain 422 the shared document editor
    // returns for the same failure instead of letting it escape as a 500.
    let computed: ReturnType<typeof computeBillTotals>
    try {
      computed = computeBillTotals(
        exactLines,
        await taxProfileMap(user.orgId, body.documentDate ?? existing.rows[0].document_date),
      )
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 })
    }
    const subtotal = exactMoney(computed.subtotal)
    if (subtotal === 'invalid') {
      return NextResponse.json({ error: 'Expense subtotal is not a valid amount' }, { status: 422 })
    }
    const taxTotal = exactMoney(computed.taxTotal)
    if (taxTotal === 'invalid') {
      return NextResponse.json({ error: 'Expense tax total is not a valid amount' }, { status: 422 })
    }
    const total = exactMoney(computed.total)
    if (total === 'invalid') {
      return NextResponse.json({ error: 'Expense total is not a valid amount' }, { status: 422 })
    }
    totals = {
      subtotal,
      taxTotal,
      total,
    }
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
      // Lines are replaced wholesale, so the whole submitted line bag is
      // newly supplied: refuse foreign or dangling reference ids with a
      // tenant-opaque 404 instead of persisting a cross-tenant pointer.
      const unownedLineRefs = await findUnownedCustomReferences(user.orgId, lineDefs, lv.cleaned)
      if (unownedLineRefs.length > 0) {
        const def = unownedLineRefs[0]!
        return NextResponse.json(
          { error: `Line ${i + 1}: ${def.label} not found in this organization` },
          { status: 404 },
        )
      }
      const lineDims = validateExtraDims(l.extraDims, segments)
      if (!lineDims.ok) return NextResponse.json({ error: `Line ${i + 1}: ${lineDims.error}` }, { status: 422 })
      const amount = exactMoney(l.amount)
      if (amount === 'invalid') {
        return NextResponse.json({ error: 'Expense line amount is not a valid amount' }, { status: 422 })
      }
      const taxInputAmount = exactMoney(l.taxInputAmount)
      if (taxInputAmount === 'invalid') {
        return NextResponse.json({ error: 'Expense line tax input amount is not a valid amount' }, { status: 422 })
      }
      const taxAmount = exactMoney(l.taxAmount)
      if (taxAmount === 'invalid') {
        return NextResponse.json({ error: 'Expense line tax amount is not a valid amount' }, { status: 422 })
      }
      preparedLines.push({
        accountId: l.accountId!,
        description: l.description ?? null,
        amount,
        taxCodeId: l.taxCodeId ?? null,
        taxGroupId: l.taxGroupId ?? null,
        taxInputAmount,
        taxAmount,
        taxOverridden: l.taxOverridden === true,
        taxComponents: l.taxComponents,
        departmentId: l.departmentId ?? null,
        projectId: l.projectId ?? null,
        extraDims: lineDims.cleaned,
        custom: lv.cleaned,
      })
    }
  }

  try {
    await runDocumentVersionedTransaction<
      RouteTransaction,
      { status: string; updatedAt: string; subsidiaryId: string | null },
      void
    >({
      expectedRevision,
      transaction: (work) => db.transaction(work),
      // The row lock and exact revision comparison are the first operations in
      // the write transaction: a concurrent writer cannot slip between the
      // check and the header/line replacement.
      lock: async (tx) => {
        const row = (await tx.execute<{ status: string; updatedAt: string; subsidiaryId: string | null }>(sql`
          select status, subsidiary_id as "subsidiaryId",
                 ${documentRevisionCounterSql(sql.raw('revision_seq'))} as "updatedAt"
            from documents
           where id = ${id} and kind = 'expense_report' and org_id = ${user.orgId}
           for update
        `)).rows[0]
        // Scope precedes revision comparison so a rehomed document remains
        // indistinguishable from a missing row, even with a stale token.
        return row && !guardSubsidiaryScope(gate, row.subsidiaryId) ? row : null
      },
      mutate: async (tx, locked) => {
        if (locked.status !== 'draft') {
          throw new DocumentEditError(
            422,
            `a ${locked.status} expense report cannot be edited — create a correcting report instead`,
          )
        }

        const auditBefore = await captureTransactionAuditSnapshot(tx, id, user.orgId)
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
            updated_at = greatest(
              clock_timestamp(),
              updated_at + interval '1 microsecond'
            ),
            updated_by = ${user.id}
          where id = ${id} and org_id = ${user.orgId}
        `)

        const auditAfter = await captureTransactionAuditSnapshot(tx, id, user.orgId)
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
      },
    })
  } catch (e) {
    if (e instanceof DocumentEditError) {
      return NextResponse.json(
        { error: e.message, ...(e.fieldErrors ? { fieldErrors: e.fieldErrors } : {}) },
        { status: e.status },
      )
    }
    throw e
  }

  const report = await loadExpenseReport(id, user.orgId)
  if (!report) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const responseDenied = guardSubsidiaryScope(gate, report.doc.subsidiary_id as string | null)
  if (responseDenied) return responseDenied
  return NextResponse.json(report)
}

/** Delete an expense report (guarded: open period, no applied payments, no downstream conversion). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('expenses.create', 'expenses')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const owned = (await db.execute<{ subsidiaryId: string | null }>(
    sql`select subsidiary_id as "subsidiaryId" from documents where id = ${id} and kind = 'expense_report' and org_id = ${gate.user.orgId}`,
  ))
  if (!owned.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(gate, owned.rows[0].subsidiaryId)
  if (denied) return denied
  // Mandatory optimistic-concurrency evidence — same contract as the PATCH
  // verb in this file and DELETE /api/documents/[id]: a delete that lands
  // on a stale read must 409 instead of discarding another writer's draft.
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { expectedUpdatedAt?: string }
  let expectedRevision: string
  try {
    expectedRevision = requireDocumentEditRevision(body.expectedUpdatedAt)
  } catch (e) {
    if (e instanceof DocumentEditError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    throw e
  }
  try {
    await deleteDocument(id, gate.user.id, gate.user.orgId, { source: 'ui', expectedUpdatedAt: expectedRevision })
    return NextResponse.json({ ok: true })
  } catch (e) {
    // The engine fence carries its own 409; every other refusal stays 422.
    if (e instanceof DeleteError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
