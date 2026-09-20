import 'server-only'
import { sql } from 'drizzle-orm'
import { db, schema, withOrgTransaction, type SqlExecutor } from '@openbooks/engine/src/platform/db.ts'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { computeBillTotals, nextDocumentNumber, persistLineTaxComponents, taxProfileMap } from "./bills.ts";
import { type BillLineInput } from "../../engine/src/ledger/document-input.ts";
import { assertNoExistingDocumentCorrection, buildReversalLinkEvidence, DocumentEditError, requireDocumentEditRevision, runDocumentVersionedTransaction, validateCorrectionReason } from "../../engine/src/records/document-edit-policy.ts";
import { documentRevisionCounterSql } from "../../engine/src/records/revision.ts";
import { validateEditableDocumentLines } from "./documents.ts";
import { findUnownedCustomReferences, loadFieldDefs, validateCustomValues } from './custom-fields'
import { canonicalDecimal } from './exact-decimal'
import { segmentRegistry, validateExtraDims } from './segments'
import { isUuid } from './list-params'

/**
 * Shared expense-report edit validation + persistence for the draft PATCH
 * and the posted-correction routes. Both accept the same body and produce
 * byte-identical writes; only their status gates, auditing, and lifecycle
 * differ. Extracted verbatim from the PATCH route — change behavior here
 * and both callers change together.
 */

export const EXPENSE_SETTLEMENT_TYPES = ['out_of_pocket', 'company_paid', 'personal'] as const
export type ExpenseSettlementType = (typeof EXPENSE_SETTLEMENT_TYPES)[number]

export interface ExpenseEditBody {
  expectedUpdatedAt?: string
  partyId?: string | null
  paymentCardId?: string | null
  documentDate?: string
  memo?: string | null
  extraDims?: Record<string, string | null>
  custom?: Record<string, unknown>
  lines?: (BillLineInput & {
    departmentId?: string | null
    projectId?: string | null
    extraDims?: Record<string, string | null>
    custom?: Record<string, unknown>
    /** Who fronted the money (0171). Required on every submitted line: history
     * may be honestly unclassified (NULL), but a newly written line states it. */
    settlementType?: string | null
  })[]
}

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

export interface PreparedExpenseLine {
  accountId: string
  description: string | null
  settlementType: ExpenseSettlementType
  amount: string
  taxCodeId: string | null
  taxGroupId: string | null
  taxInputAmount: string
  taxAmount: string
  taxOverridden: boolean
  taxComponents: ReturnType<typeof computeBillTotals>['lines'][number]['taxComponents']
  departmentId: string | null
  projectId: string | null
  extraDims: Record<string, string>
  custom: Record<string, unknown>
}

export interface PreparedExpenseEdit {
  /** Null = body left the header bag untouched. */
  headerCustom: Record<string, unknown> | null
  /** False = body omitted extra_dims (keep stored). */
  extraDimsProvided: boolean
  extraDimsCleaned: Record<string, string>
  totals: { subtotal: string; taxTotal: string; total: string } | null
  preparedLines: PreparedExpenseLine[] | null
}

/**
 * Read-only validation of an expense edit body: date shape, tenant
 * ownership of every referenced row, custom-field and segment contracts,
 * line shapes, and computed totals. Throws DocumentEditError (404 for
 * foreign references, 422 for domain refusals) — never writes.
 */
export async function prepareExpenseEdit(
  body: ExpenseEditBody,
  ctx: { orgId: string; existingCustom: unknown; existingDocumentDate: string },
): Promise<PreparedExpenseEdit> {
  const { orgId } = ctx
  // The document date reaches coalesce(document_date) uncast: a malformed
  // value dies at the storage layer as a raw 500 instead of a domain 422
  // (sibling PATCH routes validate with isoDate). Fail closed here, covering
  // both shape-invalid strings and impossible calendar days.
  if (body.documentDate !== undefined && !isIsoCalendarDate(body.documentDate)) {
    throw new DocumentEditError(422, 'invalid documentDate — expected YYYY-MM-DD')
  }
  // The party is the employee being reimbursed. The documents FK is global,
  // so without an org-scoped check this save would persist another tenant's
  // party on the draft (submit and post refuse it later, but the reference
  // itself must never be stored). A null body value keeps the current party.
  if (body.partyId !== undefined && body.partyId !== null) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.partyId)) {
      throw new DocumentEditError(404, 'party not found in this organization')
    }
    const owner = (await db.execute<{ id: string }>(
      sql`select id from parties where id = ${body.partyId} and org_id = ${orgId}`,
    ))
    if (!owner.rows[0]) throw new DocumentEditError(404, 'party not found in this organization')
  }
  // The funding card backs every company-paid and personal line (0171). The
  // documents FK is global, so prove org ownership here like the party above;
  // submit and post re-check before money moves. The picker offers active
  // cards only, and so does this gate — posting stays booking-agnostic so a
  // later deactivation cannot brick an in-flight report. A null body value
  // keeps the current card, mirroring the party contract.
  if (body.paymentCardId !== undefined && body.paymentCardId !== null) {
    if (!isUuid(body.paymentCardId)) {
      throw new DocumentEditError(404, 'corporate card not found in this organization')
    }
    const card = (await db.execute<{ id: string }>(
      sql`select id from payment_cards where id = ${body.paymentCardId} and org_id = ${orgId} and is_active`,
    ))
    if (!card.rows[0]) throw new DocumentEditError(404, 'corporate card not found in this organization')
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
           where org_id = ${orgId} and is_active and not is_summary
             and id = any(${`{${accountIds.join(',')}}`}::uuid[])
        `)).rows
      : []
    if (malformed.length > 0 || usable.length !== accountIds.length) {
      throw new DocumentEditError(404, 'account not found in this organization')
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
          throw new DocumentEditError(422, `Line ${i + 1}: invalid ${key}`)
        }
      }
    }
    for (const [key, label, table] of [['departmentId', 'department', 'departments'], ['projectId', 'project', 'projects']] as const) {
      const ids = [...new Set(body.lines.map((l) => l[key]).filter((v): v is string => typeof v === 'string' && v.length > 0))]
      if (ids.length === 0) continue
      const owned = new Set((await db.execute<{ id: string }>(sql`
        select id from ${sql.raw(`"${table}"`)} where org_id = ${orgId} and id = any(${`{${ids.join(',')}}`}::uuid[])`)).rows.map((r) => r.id))
      const foreign = ids.find((v) => !owned.has(v))
      if (foreign !== undefined) {
        const lineNumber = body.lines.findIndex((l) => l[key] === foreign) + 1
        throw new DocumentEditError(404, `Line ${lineNumber}: ${label} not found in this organization`)
      }
    }
  }

  // custom-field validation (header + line) against the live definitions
  const [headerDefs, lineDefs, segments] = await Promise.all([
    loadFieldDefs('documents', 'expense_report'),
    loadFieldDefs('document_lines', 'expense_report'),
    segmentRegistry(orgId),
  ])
  const headerDims = body.extraDims === undefined ? null : validateExtraDims(body.extraDims, segments)
  if (headerDims && !headerDims.ok) throw new DocumentEditError(422, headerDims.error)
  let headerCustom: Record<string, unknown> | null = null
  if (body.custom !== undefined) {
    // PATCH custom values are partial: validate the effective bag so an
    // omitted required field can be satisfied by its stored value, then
    // merge the cleaned submitted values over the stored bag so omitted
    // keys survive. The revision guard below rejects the write if a
    // concurrent edit moved the stored bag after this read.
    const existingCustom =
      ctx.existingCustom && typeof ctx.existingCustom === 'object'
        ? (ctx.existingCustom as Record<string, unknown>)
        : {}
    const v = validateCustomValues(headerDefs, { ...existingCustom, ...body.custom })
    if (!v.ok) throw new DocumentEditError(422, Object.values(v.errors)[0]!, v.errors)
    // Reference custom values are uuid-SHAPED at this point but nothing
    // proves the referenced row belongs to the caller: refuse foreign or
    // dangling ids with a tenant-opaque 404 instead of persisting a
    // cross-tenant pointer. Supplied values only, so legacy bags written
    // before this fence cannot lock unrelated edits.
    const suppliedHeaderCustom: Record<string, unknown> = {}
    for (const key of Object.keys(body.custom)) {
      if (v.cleaned[key] !== undefined) suppliedHeaderCustom[key] = v.cleaned[key]
    }
    const unownedHeaderRefs = await findUnownedCustomReferences(orgId, headerDefs, suppliedHeaderCustom)
    if (unownedHeaderRefs.length > 0) {
      const def = unownedHeaderRefs[0]!
      throw new DocumentEditError(404, `${def.label} not found in this organization`)
    }
    headerCustom = { ...existingCustom, ...v.cleaned }
  }

  // Pre-validate + prepare lines (read-only) before touching the DB, so a bad
  // line returns 422 without a partial write.
  let totals: PreparedExpenseEdit['totals'] = null
  let preparedLines: PreparedExpenseLine[] | null = null
  if (body.lines) {
    const valid = validateEditableDocumentLines(body.lines)
    const exactLines: typeof valid = []
    for (let i = 0; i < valid.length; i++) {
      const line = valid[i]!
      const amount = exactMoney(line.amount)
      if (amount === 'invalid') {
        throw new DocumentEditError(
          422,
          `Line ${i + 1}: "${line.amount}" is not a valid amount — enter an exact decimal of at most 4 decimal places`,
        )
      }
      let taxAmount = line.taxAmount ?? null
      if (taxAmount != null && String(taxAmount).trim() !== '') {
        const exactTax = exactMoney(taxAmount)
        if (exactTax === 'invalid') {
          throw new DocumentEditError(422, `Line ${i + 1}: tax amount is not a valid amount`)
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
        await taxProfileMap(orgId, body.documentDate ?? ctx.existingDocumentDate),
      )
    } catch (error) {
      throw new DocumentEditError(422, error instanceof Error ? error.message : String(error))
    }
    const subtotal = exactMoney(computed.subtotal)
    if (subtotal === 'invalid') {
      throw new DocumentEditError(422, 'Expense subtotal is not a valid amount')
    }
    const taxTotal = exactMoney(computed.taxTotal)
    if (taxTotal === 'invalid') {
      throw new DocumentEditError(422, 'Expense tax total is not a valid amount')
    }
    const total = exactMoney(computed.total)
    if (total === 'invalid') {
      throw new DocumentEditError(422, 'Expense total is not a valid amount')
    }
    totals = { subtotal, taxTotal, total }
    preparedLines = []
    for (let i = 0; i < computed.lines.length; i++) {
      const l = computed.lines[i]! as (typeof computed.lines)[number] & {
        departmentId?: string | null
        projectId?: string | null
        extraDims?: Record<string, string | null>
        custom?: Record<string, unknown>
        settlementType?: string | null
      }
      // Settlement is required on every newly written line (0171): NULL is an
      // honest state for pre-migration history, never for a line this API
      // writes. Fail closed with the line number, like every other line gate.
      if (!EXPENSE_SETTLEMENT_TYPES.includes(l.settlementType as ExpenseSettlementType)) {
        throw new DocumentEditError(
          422,
          `Line ${i + 1}: settlement is required — out_of_pocket, company_paid, or personal`,
        )
      }
      const lv = validateCustomValues(lineDefs, l.custom)
      if (!lv.ok) {
        throw new DocumentEditError(422, `Line ${i + 1}: ${Object.values(lv.errors)[0]}`, lv.errors)
      }
      // Lines are replaced wholesale, so the whole submitted line bag is
      // newly supplied: refuse foreign or dangling reference ids with a
      // tenant-opaque 404 instead of persisting a cross-tenant pointer.
      const unownedLineRefs = await findUnownedCustomReferences(orgId, lineDefs, lv.cleaned)
      if (unownedLineRefs.length > 0) {
        const def = unownedLineRefs[0]!
        throw new DocumentEditError(404, `Line ${i + 1}: ${def.label} not found in this organization`)
      }
      const lineDims = validateExtraDims(l.extraDims, segments)
      if (!lineDims.ok) throw new DocumentEditError(422, `Line ${i + 1}: ${lineDims.error}`)
      const amount = exactMoney(l.amount)
      if (amount === 'invalid') {
        throw new DocumentEditError(422, 'Expense line amount is not a valid amount')
      }
      const taxInputAmount = exactMoney(l.taxInputAmount)
      if (taxInputAmount === 'invalid') {
        throw new DocumentEditError(422, 'Expense line tax input amount is not a valid amount')
      }
      const taxAmount = exactMoney(l.taxAmount)
      if (taxAmount === 'invalid') {
        throw new DocumentEditError(422, 'Expense line tax amount is not a valid amount')
      }
      preparedLines.push({
        accountId: l.accountId!,
        description: l.description ?? null,
        settlementType: l.settlementType as ExpenseSettlementType,
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

  return {
    headerCustom,
    extraDimsProvided: headerDims !== null,
    extraDimsCleaned: headerDims?.cleaned ?? {},
    totals,
    preparedLines,
  }
}

/**
 * Persist a prepared edit onto a document row: wholesale line replacement
 * plus the coalescing header update. No auditing, no status checks — the
 * caller owns those (the draft PATCH records an 'update' audit; the posted
 * correction records correction lineage instead).
 */
export async function persistExpenseEdit(
  tx: SqlExecutor,
  args: {
    docId: string
    orgId: string
    userId: string
    body: Pick<ExpenseEditBody, 'partyId' | 'paymentCardId' | 'documentDate' | 'memo'>
    prepared: PreparedExpenseEdit
  },
): Promise<void> {
  const { docId, orgId, prepared } = args
  if (prepared.preparedLines) {
    await tx.execute(sql`delete from document_lines where document_id = ${docId} and org_id = ${orgId}`)
    for (let i = 0; i < prepared.preparedLines.length; i++) {
      const l = prepared.preparedLines[i]!
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    quantity, unit_price, amount, tax_code_id, tax_group_id, tax_input_amount,
                                    tax_amount, tax_overridden, settlement_type,
                                    department_id, project_id, extra_dims, custom)
        values (${orgId}, ${docId}, ${i + 1}, ${l.accountId}, ${l.description},
                '1', ${l.amount}, ${l.amount}, ${l.taxCodeId}, ${l.taxGroupId}, ${l.taxInputAmount},
                ${l.taxAmount}, ${l.taxOverridden}, ${l.settlementType},
                ${l.departmentId}, ${l.projectId}, ${JSON.stringify(l.extraDims)}::jsonb, ${JSON.stringify(l.custom)})
        returning id
      `))
      await persistLineTaxComponents(tx, {
        orgId,
        documentLineId: inserted.rows[0]!.id,
        components: l.taxComponents,
        actorId: args.userId,
      })
    }
  }

  await tx.execute(sql`
    update documents set
      party_id = coalesce(${args.body.partyId ?? null}, party_id),
      payment_card_id = coalesce(${args.body.paymentCardId ?? null}, payment_card_id),
      document_date = coalesce(${args.body.documentDate ?? null}, document_date),
      memo = ${args.body.memo !== undefined ? args.body.memo : sql`memo`},
      extra_dims = ${prepared.extraDimsProvided ? JSON.stringify(prepared.extraDimsCleaned) : sql`extra_dims`}::jsonb,
      custom = coalesce(${prepared.headerCustom ? JSON.stringify(prepared.headerCustom) : null}::jsonb, custom),
      subtotal = coalesce(${prepared.totals?.subtotal ?? null}, subtotal),
      tax_total = coalesce(${prepared.totals?.taxTotal ?? null}, tax_total),
      total = coalesce(${prepared.totals?.total ?? null}, total),
      updated_at = greatest(
        clock_timestamp(),
        updated_at + interval '1 microsecond'
      ),
      updated_by = ${args.userId}
    where id = ${docId} and org_id = ${orgId}
  `)
}

export interface ExpenseCorrectionBody extends ExpenseEditBody {
  amendmentReason?: string
}

/**
 * Create the correcting replacement draft for a posted expense report —
 * the expense half of the documents correct contract (the route pairs this
 * with the source's controlled void in one atomic unit, exactly like
 * POST /api/documents/[id]/correct).
 *
 * The replacement starts as a faithful copy of the posted source (header,
 * lines, and tax-component snapshots) with a fresh EXP number, then the
 * submitted edit body applies over it through the same validation the
 * draft PATCH runs — so a full drawer payload and a reason-only call both
 * yield a postable draft. Correction lineage (correctionOf/correctionReason
 * plus the `reverses` edge with its mandatory evidence) mirrors
 * createPostedCorrectionDraft.
 */
export async function createExpenseCorrectionDraft(
  sourceId: string,
  body: ExpenseCorrectionBody,
  ctx: { orgId: string; userId: string },
): Promise<{ id: string; documentNumber: string }> {
  const expectedRevision = requireDocumentEditRevision(body.expectedUpdatedAt)
  const reason = validateCorrectionReason(body.amendmentReason)

  return withOrgTransaction(ctx.orgId, async () => runDocumentVersionedTransaction<
    SqlExecutor,
    {
      status: string
      updatedAt: string
      documentNumber: string
      documentDate: string
      subsidiaryId: string | null
      currency: string | null
      partyId: string | null
      paymentCardId: string | null
      memo: string | null
      extraDims: unknown
      custom: unknown
      subtotal: string
      taxTotal: string
      total: string
    },
    { id: string; documentNumber: string }
  >({
    expectedRevision,
    transaction: (work) => db.transaction(work),
    lock: async (tx) => (await tx.execute<{
      status: string
      updatedAt: string
      documentNumber: string
      documentDate: string
      subsidiaryId: string | null
      currency: string | null
      partyId: string | null
      paymentCardId: string | null
      memo: string | null
      extraDims: unknown
      custom: unknown
      subtotal: string
      taxTotal: string
      total: string
    }>(sql`
      select status, document_number as "documentNumber", document_date as "documentDate",
             subsidiary_id as "subsidiaryId", currency, party_id as "partyId",
             payment_card_id as "paymentCardId", memo,
             extra_dims as "extraDims", custom,
             subtotal::text as "subtotal", tax_total::text as "taxTotal", total::text as "total",
             ${documentRevisionCounterSql(sql.raw('revision_seq'))} as "updatedAt"
        from documents
       where id = ${sourceId} and kind = 'expense_report' and org_id = ${ctx.orgId}
       for update
    `)).rows[0] ?? null,
    mutate: async (tx, source) => {
      const existingCorrection = (await tx.execute<{ documentNumber: string }>(sql`
        select replacement.document_number as "documentNumber"
          from document_links link
          join documents replacement
            on replacement.id = link.from_document_id
           and replacement.org_id = link.org_id
         where link.org_id = ${ctx.orgId}
           and link.to_document_id = ${sourceId}
           and link.link_type = 'reverses'
         limit 1
      `)).rows[0]
      assertNoExistingDocumentCorrection(existingCorrection?.documentNumber ?? null)
      if (source.status !== 'posted') {
        throw new DocumentEditError(422, 'only a posted expense report can create a correcting replacement')
      }
      const prepared = await prepareExpenseEdit(body, {
        orgId: ctx.orgId,
        existingCustom: source.custom,
        existingDocumentDate: source.documentDate,
      })
      const documentNumber = await nextDocumentNumber(ctx.orgId, 'expense_report', 'EXP-')
      const created = (await tx.execute<{ id: string }>(sql`
        insert into documents
          (org_id, kind, status, document_number, document_date, subsidiary_id,
           currency, party_id, payment_card_id, memo, extra_dims, custom,
           subtotal, tax_total, total, created_by, updated_by)
        values (${ctx.orgId}, 'expense_report', 'draft', ${documentNumber},
                ${source.documentDate}, ${source.subsidiaryId}, ${source.currency},
                ${source.partyId}, ${source.paymentCardId}, ${source.memo},
                ${JSON.stringify(source.extraDims ?? {})}::jsonb,
                ${JSON.stringify(source.custom ?? {})}::jsonb,
                ${source.subtotal}, ${source.taxTotal}, ${source.total},
                ${ctx.userId}, ${ctx.userId})
        returning id
      `)).rows[0]
      if (!created) throw new Error(`correction draft for ${sourceId} disappeared during initialization`)
      // Faithful line copy (including the immutable tax-component
      // snapshots, mapped onto the new line ids by line number), then the
      // submitted body applies over it through the shared persist.
      const sourceLines = (await tx.execute<{
        lineNumber: number
        accountId: string
        description: string | null
        quantity: string
        unitPrice: string
        amount: string
        taxCodeId: string | null
        taxGroupId: string | null
        taxInputAmount: string
        taxAmount: string
        taxOverridden: boolean
        settlementType: string | null
        departmentId: string | null
        projectId: string | null
        extraDims: unknown
        custom: unknown
      }>(sql`
        select line_number as "lineNumber", account_id as "accountId", description,
               quantity::text as "quantity", unit_price::text as "unitPrice", amount::text as "amount",
               tax_code_id as "taxCodeId", tax_group_id as "taxGroupId",
               tax_input_amount::text as "taxInputAmount", tax_amount::text as "taxAmount", tax_overridden as "taxOverridden",
               settlement_type as "settlementType",
               department_id as "departmentId", project_id as "projectId", extra_dims as "extraDims", custom
          from document_lines
         where document_id = ${sourceId} and org_id = ${ctx.orgId}
         order by line_number
      `)).rows
      const lineIdByNumber = new Map<number, string>()
      for (const line of sourceLines) {
        const inserted = (await tx.execute<{ id: string }>(sql`
          insert into document_lines
            (org_id, document_id, line_number, account_id, description,
             quantity, unit_price, amount, tax_code_id, tax_group_id, tax_input_amount,
             tax_amount, tax_overridden, settlement_type, department_id, project_id, extra_dims, custom)
          values (${ctx.orgId}, ${created.id}, ${line.lineNumber}, ${line.accountId}, ${line.description},
                  ${line.quantity}, ${line.unitPrice}, ${line.amount}, ${line.taxCodeId}, ${line.taxGroupId},
                  ${line.taxInputAmount}, ${line.taxAmount}, ${line.taxOverridden}, ${line.settlementType},
                  ${line.departmentId}, ${line.projectId},
                  ${JSON.stringify(line.extraDims ?? {})}::jsonb, ${JSON.stringify(line.custom ?? {})}::jsonb)
          returning id
        `)).rows[0]
        if (!inserted) throw new Error(`correction line ${line.lineNumber} disappeared during initialization`)
        lineIdByNumber.set(line.lineNumber, inserted.id)
      }
      const sourceComponents = (await tx.execute<{
        lineNumber: number
        taxCodeId: string
        sequence: number
        ratePercent: string
        taxableAmount: string
        taxAmount: string
        recoverableAmount: string
        nonrecoverableAmount: string
        calculationType: string
        priceIncludesTax: boolean
        compoundOnPrevious: boolean
        roundingScale: number
        collectedAccountId: string | null
        paidAccountId: string | null
        withholdingAccountId: string | null
        overridden: boolean
        createdBy: string | null
        updatedBy: string | null
      }>(sql`
        select l.line_number as "lineNumber", c.tax_code_id as "taxCodeId", c.sequence,
               c.rate_percent as "ratePercent", c.taxable_amount as "taxableAmount", c.tax_amount as "taxAmount",
               c.recoverable_amount as "recoverableAmount", c.nonrecoverable_amount as "nonrecoverableAmount",
               c.calculation_type as "calculationType", c.price_includes_tax as "priceIncludesTax",
               c.compound_on_previous as "compoundOnPrevious", c.rounding_scale as "roundingScale",
               c.collected_account_id as "collectedAccountId", c.paid_account_id as "paidAccountId",
               c.withholding_account_id as "withholdingAccountId", c.overridden,
               c.created_by as "createdBy", c.updated_by as "updatedBy"
          from document_line_tax_components c
          join document_lines l on l.id = c.document_line_id and l.org_id = c.org_id
         where l.document_id = ${sourceId} and c.org_id = ${ctx.orgId}
      `)).rows
      for (const component of sourceComponents) {
        const documentLineId = lineIdByNumber.get(component.lineNumber)
        if (!documentLineId) continue
        await tx.execute(sql`
          insert into document_line_tax_components
            (org_id, document_line_id, tax_code_id, sequence, rate_percent,
             taxable_amount, tax_amount, recoverable_amount, nonrecoverable_amount,
             calculation_type, price_includes_tax, compound_on_previous, rounding_scale,
             collected_account_id, paid_account_id, withholding_account_id, overridden,
             created_by, updated_by)
          values (${ctx.orgId}, ${documentLineId}, ${component.taxCodeId}, ${component.sequence},
                  ${component.ratePercent}, ${component.taxableAmount}, ${component.taxAmount},
                  ${component.recoverableAmount}, ${component.nonrecoverableAmount},
                  ${component.calculationType}, ${component.priceIncludesTax},
                  ${component.compoundOnPrevious}, ${component.roundingScale},
                  ${component.collectedAccountId}, ${component.paidAccountId},
                  ${component.withholdingAccountId}, ${component.overridden},
                  ${component.createdBy}, ${component.updatedBy})
        `)
      }
      await persistExpenseEdit(tx, {
        docId: created.id,
        orgId: ctx.orgId,
        userId: ctx.userId,
        body: { partyId: body.partyId, paymentCardId: body.paymentCardId, documentDate: body.documentDate, memo: body.memo },
        prepared,
      })
      await tx.execute(sql`
        update documents
           set custom = coalesce(custom, '{}'::jsonb) ||
             ${JSON.stringify({ correctionOf: sourceId, correctionReason: reason })}::jsonb,
               updated_at = greatest(
                 clock_timestamp(),
                 updated_at + interval '1 microsecond'
               ),
               updated_by = ${ctx.userId}
         where id = ${created.id} and org_id = ${ctx.orgId}
      `)
      await db.insert(schema.documentLinks).values({
        orgId: ctx.orgId,
        ...buildReversalLinkEvidence({
          fromDocumentId: created.id,
          toDocumentId: sourceId,
          reason,
          requestedBy: ctx.userId,
        }),
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      })
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (
          ${ctx.orgId}, 'documents', ${created.id}, 'insert',
          ${JSON.stringify({
            mode: 'posted_correction_draft',
            sourceDocumentId: sourceId,
            reason,
          })}::jsonb,
          ${ctx.userId}, 'posted_correction'
        )
      `)
      return { id: created.id, documentNumber }
    },
  }))
}
