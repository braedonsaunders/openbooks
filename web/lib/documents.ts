import 'server-only'
import { resolveAccountGroups } from '@openbooks/engine/src/records/account-groups.ts'
import {
  EntryAllocationError,
  loadEntryRuleByKey,
  planEntryDistributions,
  type EntryDocumentContext,
  type EntryLineInput,
  type EntryPlan,
  type StoredEntryGroup,
} from '@openbooks/engine/src/allocations/entry.ts'
import { listEntryRulesInEffect } from '@openbooks/engine/src/allocations/match.ts'
import type { RuleInEffect } from '@openbooks/engine/src/allocations/types.ts'
import { assertGeneratedBillingEdit, BillingSourceIntegrityError } from '@openbooks/engine/src/projects/billing-source-integrity.ts'
import { documentRevisionCounterSql } from '@openbooks/engine/src/records/revision.ts'
import { sql } from 'drizzle-orm'
import { canonicalJson } from '@openbooks/engine/src/platform/canonical-json.ts'
import { allocateDocumentNumber } from '@openbooks/engine/src/records/numbering.ts'
import { db, schema, withOrgTransaction, type SqlExecutor } from '@openbooks/engine/src/platform/db.ts'
import { assertReturnSourceSelectable, type ReturnSide } from '@openbooks/engine/src/inventory/returnable-sources.ts'
import { InventoryError } from '@openbooks/engine/src/inventory/contracts.ts'
import { cmp, normalizeDecimal, normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { runRecordFlows } from '@openbooks/engine/src/flows/index.ts'
import { captureTransactionAuditSnapshot, recordTransactionAudit } from '@openbooks/engine/src/records/transaction-audit.ts'
import { promoteCrmAccount } from '@openbooks/engine/src/crm/crm.ts'
import { computeBillTotals, computeBillTotalsWithProvider, nextDocumentNumber, persistLineTaxComponents, taxProfileMap } from './bills'
import { canonicalDecimal } from './exact-decimal'
import { activeStockLocations, profiledItemIds } from './stock-locations'
import { DOC_KIND_FEATURE, docKindConfig, isDocumentCreateKind, type DocKindConfig } from './document-kinds'
import { checkProjectsWriteEnabled, featureEnabled, isFeatureEnabled, orgFeatureState } from './features'
import { findUnownedCustomReferences, loadFieldDefs, validateCustomValues } from './custom-fields'
import { segmentRegistry, validateExtraDims } from './segments'
import { resolveOrgId } from './org-scope'
import { businessToday, isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { isUuid } from './list-params'
import { persistTaxQuote } from '@openbooks/engine/src/tax/rate-providers.ts'

import {
  DOCUMENT_EDIT_REVISION_CONFLICT, DocumentEditError, requireDocumentEditRevision, assertNoExistingDocumentCorrection,
  runDocumentVersionedTransaction, buildReversalLinkEvidence,
} from '@openbooks/engine/src/records/document-edit-policy.ts'
import type { DocumentLineInput, DocumentEditInput, DocumentEditCurrent } from '@openbooks/engine/src/ledger/document-input.ts'
import { loadDocumentEditCurrent } from '@openbooks/engine/src/ledger/document-service.ts'

/** False when this kind belongs to a Features switch that is off. */
export async function isDocKindEnabled(orgId: string, kind: string): Promise<boolean> {
  const feature = DOC_KIND_FEATURE[kind]
  if (!feature) return true
  return isFeatureEnabled(orgId, feature)
}

/** Optional-module kinds whose Features switch is off. Historical rows stay. */
export async function disabledDocKinds(orgId: string): Promise<string[]> {
  const state = await orgFeatureState(orgId)
  return Object.entries(DOC_KIND_FEATURE).flatMap(([kind, feature]) =>
    feature && !featureEnabled(state, feature) ? [kind] : [],
  )
}

// ---------------------------------------------------------------------------
// Draft creation + loading
// ---------------------------------------------------------------------------

/** Resolve the org's base currency (used when minting a draft). */
async function orgBaseCurrency(orgId: string): Promise<string> {
  const r = (await db.execute<{ base_currency: string }>(
    sql`select base_currency from orgs where id = ${orgId}`,
  ))
  return r.rows[0]?.base_currency ?? 'CAD'
}

/**
 * Unsaved-create seed: the blank in-memory payload a list loader hands the
 * DocumentDrawer in createMode for `?doc=new&kind=`. Nothing is read or
 * written for an id — the document exists only after an explicit Save POSTs
 * /api/documents. Currency, date, and subsidiary mirror the draft factory's
 * defaults so the form opens exactly as a fresh draft would.
 */
export async function createDocumentSeed(
  orgId: string,
  kind: string,
): Promise<{ doc: Record<string, unknown>; lines: Record<string, unknown>[] }> {
  const cfg = docKindConfig(kind)
  if (!cfg) throw new Error(`unknown document kind "${kind}"`)
  const [currency, documentDate, root] = await Promise.all([
    orgBaseCurrency(orgId),
    businessToday(orgId),
    db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id = ${orgId} and parent_id is null`),
  ])
  return {
    doc: {
      id: '',
      org_id: orgId,
      kind,
      status: 'draft',
      document_number: null,
      subsidiary_id: root.rows[0]?.id ?? null,
      party_id: null,
      document_date: documentDate,
      due_date: null,
      reference_number: null,
      memo: null,
      currency,
      subtotal: '0',
      tax_total: '0',
      total: '0',
      updated_at: '',
      party_name: null,
    },
    lines: [],
  }
}

/** Instant-into-draft: mint an empty draft document for a kind, return id + number. */
export async function createDocumentDraft(
  orgId: string,
  userId: string,
  kind: string,
  options: { runFlows?: boolean; source?: 'ui' | 'api' | 'mcp' | 'assistant' | 'posted_correction' } = {},
) {
  const cfg = docKindConfig(kind)
  if (!cfg) throw new Error(`unknown document kind "${kind}"`)
  const currency = await orgBaseCurrency(orgId)
  const root = (await db.execute<{ id: string }>(sql`
    select id from subsidiaries where org_id = ${orgId} and parent_id is null`))
  const subsidiaryId = root.rows[0]?.id ?? null
  const documentNumber = await nextDocumentNumber(orgId, kind, cfg.numberPrefix, subsidiaryId)
  const [doc] = await db
    .insert(schema.documents)
    .values({
      orgId,
      kind,
      subsidiaryId,
      documentNumber,
      documentDate: await businessToday(orgId),
      currency,
      subtotal: '0',
      taxTotal: '0',
      total: '0',
      createdBy: userId,
    })
    .returning({ id: schema.documents.id, documentNumber: schema.documents.documentNumber })
  // Settle on_create flows before returning. Internal create writers reload
  // the resulting row (including its exact revision) before applying caller
  // input; a flow mutation can therefore never turn initialization into a
  // tokenless update or leave the writer holding the insert-time snapshot.
  if (options.runFlows !== false) {
    await runRecordFlows({ kind: 'on_create', source: options.source ?? 'ui' }, kind, doc!.id, { orgId, userId })
  }
  return doc!
}

/**
 * Materialize the user's edited replacement as a draft while preserving the
 * posted source. The `reverses` link carries the mandatory reversal-audit
 * evidence (reason + requester + timestamp — see buildReversalLinkEvidence)
 * and blocks submission until the source's controlled void completes.
 */
export async function createPostedCorrectionDraft(
  sourceId: string,
  body: DocumentEditInput,
  ctx: DocumentEditContext,
  options: { deferFlows?: boolean } = {},
): Promise<{ id: string; documentNumber: string }> {
  const expectedRevision = requireDocumentEditRevision(body.expectedUpdatedAt)
  const reason = body.amendmentReason?.trim() ?? ''
  if (reason.length < 8 || reason.length > 500) {
    throw new DocumentEditError(422, 'A correction reason between 8 and 500 characters is required')
  }

  const created = await withOrgTransaction(ctx.orgId, async () => runDocumentVersionedTransaction<
    DocumentTransaction,
    { kind: string; status: string; updatedAt: string },
    { id: string; documentNumber: string; kind: string }
  >({
    expectedRevision,
    transaction: (work) => db.transaction(work),
    // The source revision is authoritative only while this lock is held. The
    // caller's outer command transaction (when present) is reused, so the lock
    // spans every dependent replacement write.
    lock: async (tx) => (await tx.execute<{
      kind: string
      status: string
      updatedAt: string
    }>(sql`
      select kind, status,
             ${documentRevisionCounterSql(sql.raw('revision_seq'))} as "updatedAt"
       from documents
       where id = ${sourceId} and org_id = ${ctx.orgId}
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
        throw new DocumentEditError(422, 'only a posted document can create a correcting replacement')
      }
      const replacement = await createDocumentDraft(ctx.orgId, ctx.userId, source.kind, {
        runFlows: false,
        source: ctx.source,
      })
      const row = await loadDocumentEditCurrent(replacement.id, ctx.orgId)
      if (!row) throw new Error(`replacement document ${replacement.id} disappeared during initialization`)
      await applyDocumentEdit(
        replacement.id,
        row,
        {
          ...body,
          expectedUpdatedAt: row.updatedAt,
          // The drawer copies the SOURCE document's rows into the correction
          // body, identities included: on the fresh replacement those are
          // foreign, so the copy boundary treats every copied line as new.
          lines: body.lines?.map((line) => {
            if (line.lineId === undefined || line.lineId === null) return line
            const copy = { ...line }
            delete copy.lineId
            return copy
          }),
        },
        {
          ...ctx,
          source: 'posted_correction',
          runFlows: false,
        },
      )
      await db.execute(sql`
        update documents
           set custom = coalesce(custom, '{}'::jsonb) ||
             ${JSON.stringify({
               correctionOf: sourceId,
               correctionReason: reason,
             })}::jsonb,
               updated_at = greatest(
                 clock_timestamp(),
                 updated_at + interval '1 microsecond'
               ),
               updated_by = ${ctx.userId}
         where id = ${replacement.id} and org_id = ${ctx.orgId}
      `)
      await db.insert(schema.documentLinks).values({
        orgId: ctx.orgId,
        ...buildReversalLinkEvidence({
          fromDocumentId: replacement.id,
          toDocumentId: sourceId,
          reason,
          requestedBy: ctx.userId,
        }),
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      })
      await db.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (
          ${ctx.orgId}, 'documents', ${replacement.id}, 'insert',
          ${JSON.stringify({
            mode: 'posted_correction_draft',
            sourceDocumentId: sourceId,
            reason,
          })}::jsonb,
          ${ctx.userId}, 'posted_correction'
        )
      `)
      return { ...replacement, kind: source.kind }
    },
  }))
  // Flow plans may enqueue email or other externally visible work. Dispatch
  // only after the transaction that made the correction visible commits. A
  // caller that owns a wider transaction defers this until its own commit.
  if (!options.deferFlows) {
    await runPostedCorrectionDraftFlows(created.id, created.kind, ctx)
  }
  return { id: created.id, documentNumber: created.documentNumber }
}

export async function runPostedCorrectionDraftFlows(
  correctionId: string,
  kind: string,
  ctx: DocumentEditContext,
): Promise<void> {
  await runRecordFlows(
    { kind: 'on_create', source: ctx.source },
    kind,
    correctionId,
    { orgId: ctx.orgId, userId: ctx.userId },
  )
}

// ---------------------------------------------------------------------------
// Shared edit service — the single source of truth for writing a posting
// document's header + lines. Both the interactive drawer route
// (app/api/documents/[id]/route.ts) and the public REST writer
// (lib/api/writers.ts) call this, so an API edit gets the exact same custom-
// field validation, GL re-materialization, transaction audit, CRM promotion,
// and on_update flows the UI does — no duplicated, drifting write logic.
// ---------------------------------------------------------------------------

export type PreparedDocumentTotals = Awaited<ReturnType<typeof computeBillTotalsWithProvider>>

/**
 * Resolve provider tax before a create writer mints its draft row. The result
 * is an internal hand-off to applyDocumentEdit; callers must never accept it
 * from an HTTP payload. Provider failures become request-state errors while no
 * document or dependent rows exist yet.
 */
function documentTaxProviderAddresses(custom: Record<string, unknown> | undefined): {
  shipFrom?: Record<string, string | null>
  shipTo?: Record<string, string | null>
} | null {
  if (!custom) return null
  const raw = custom.taxProviderAddresses as Record<string, unknown> | undefined
  if (raw == null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DocumentEditError(422, 'document tax location override must be an object with shipFrom/shipTo addresses')
  }
  return {
    ...(raw.shipFrom == null ? {} : { shipFrom: raw.shipFrom as Record<string, string | null> }),
    ...(raw.shipTo == null ? {} : { shipTo: raw.shipTo as Record<string, string | null> }),
  }
}

export async function precomputeDocumentTotalsForCreate(
  orgId: string,
  kind: string,
  body: Pick<DocumentEditInput, 'lines' | 'currency' | 'documentDate' | 'partyId' | 'subsidiaryId' | 'custom'>,
): Promise<PreparedDocumentTotals | null> {
  if (!body.lines) return null
  let currency = body.currency
  if (currency !== undefined) {
    currency = String(currency).trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(currency)) throw new DocumentEditError(422, 'invalid currency')
    const found = await db.execute(sql`select 1 from currencies where code = ${currency}`)
    if (!found.rows[0]) throw new DocumentEditError(422, 'invalid currency')
  } else {
    currency = await orgBaseCurrency(orgId)
  }
  const documentDate = body.documentDate ?? await businessToday(orgId)
  try {
    return await computeBillTotalsWithProvider(
      validateEditableDocumentLines(body.lines),
      await taxProfileMap(orgId, documentDate),
      {
        orgId,
        kind,
        currency,
        documentDate,
        partyId: body.partyId,
        subsidiaryId: body.subsidiaryId,
        taxProviderAddresses: documentTaxProviderAddresses(body.custom),
      },
    )
  } catch (error) {
    if (error instanceof DocumentEditError) throw error
    throw new DocumentEditError(422, error instanceof Error ? error.message : String(error))
  }
}

export interface DocumentEditContext {
  orgId: string
  userId: string
  /** Provenance recorded on the transaction audit + flow events. */
  source: 'ui' | 'api' | 'mcp' | 'assistant' | 'posted_correction'
  /** Fire on_update record flows after the edit commits (default true). */
  runFlows?: boolean
  /**
   * Return the on_update flow event instead of firing it, for callers that
   * own a wider transaction: firing mid-transaction would run flows against
   * an uncommitted row over a separate connection. The caller fires the
   * returned event after its own commit. Only honored when runFlows is not
   * false; PATCH never sets it.
   */
  deferFlows?: boolean
  /** Internal create-path provider preflight; never supplied by API callers. */
  precomputedTotals?: PreparedDocumentTotals | null
}

/** The on_update flow event an edit would fire — returned, not fired, under ctx.deferFlows. */
export type DocumentUpdateFlowEvent = Parameters<typeof runRecordFlows>[0]

/** Exact numeric(19,4) money string, or null when the value is not canonical. */
function exactMoney(value: unknown): string | null {
  const exact = canonicalDecimal(value, 4)
  if (exact === null) return null
  try {
    return normalizeMoney(exact)
  } catch {
    return null
  }
}

/** unit_price columns are numeric(28,8): a saved line reads back at storage
 * scale, so validation must accept it — otherwise no saved document can ever
 * be re-saved. Line amounts and totals stay 4dp (exactMoney above). */
function exactUnitPrice(value: unknown): string | null {
  const exact = canonicalDecimal(value, 8)
  if (exact === null) return null
  // Twenty whole digits fit numeric(28,8); anything wider dies in Postgres.
  if (wholeDigits(exact) > 20) return null
  try {
    return normalizeDecimal(exact, 8)
  } catch {
    return null
  }
}

/** Whole-digit width of a canonical decimal, for column-range guards. */
function wholeDigits(canonical: string): number {
  return canonical.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length
}

/** A validation/period failure with the HTTP status the callers should return. */
type DocumentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Draft-line validation for the generic editor. The save path used to FILTER
 * OUT every line without a positive amount, so a credit-memo leg, a discount
 * line, or a zero memo line silently vanished on any edit and the totals were
 * recomputed without it — silent data loss on a financial document. The tax
 * engine computes signed bases (engine/src/tax/tax.ts), so negative and zero
 * lines are legitimate and pass through to computeBillTotals untouched; the
 * only rejections are what the calculator provably cannot use — a missing
 * account, or an amount that is not an exact decimal within ledger scale —
 * and each rejection names its line so the editor can point at the cell.
 *
 * Pure — unit-tested directly in documents.test.ts.
 */
export function validateEditableDocumentLines(lines: DocumentLineInput[]): DocumentLineInput[] {
  return lines.map((l, i) => {
    const n = i + 1
    if (!l.accountId) {
      throw new DocumentEditError(422, `Line ${n}: an account is required`)
    }
    if (l.amount === undefined || l.amount === null || String(l.amount).trim() === '') {
      throw new DocumentEditError(422, `Line ${n}: an amount is required`)
    }
    const exactAmount = exactMoney(l.amount)
    if (exactAmount === null) {
      throw new DocumentEditError(
        422,
        `Line ${n}: "${l.amount}" is not a valid amount — enter an exact decimal of at most 4 decimal places`,
      )
    }
    // document_lines.amount is numeric(19,4): fifteen whole digits. The
    // format check above admits any magnitude, so a pasted 16-digit figure
    // died in Postgres with a storage error (a 500). Refuse it here with
    // the line number.
    if (wholeDigits(exactAmount) > 15) {
      throw new DocumentEditError(
        422,
        `Line ${n}: amount is out of range — at most 15 whole digits fit the ledger`,
      )
    }
    // Quantity is informational beside the amount, but it persists into the
    // numeric(28,8) column verbatim: junk or blank text died in Postgres with
    // a storage error (a 500), and anything past 8dp was silently rounded to
    // the column scale. Validate at the column's own scale — the same 8dp
    // contract the billing invoice writer (lib/bills.ts
    // persistInvoiceQuantity) already enforces — and refuse magnitudes the
    // column cannot hold (twenty whole digits) with the line number.
    if (l.quantity !== undefined && l.quantity !== null) {
      const exact = canonicalDecimal(l.quantity, 8)
      if (exact === null) {
        throw new DocumentEditError(
          422,
          `Line ${n}: "${l.quantity}" is not a valid quantity — enter an exact decimal of at most 8 decimal places`,
        )
      }
      const wholeDigits = exact.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '')
      if (wholeDigits.length > 20) {
        throw new DocumentEditError(
          422,
          `Line ${n}: quantity is out of range — at most 20 whole digits fit the ledger`,
        )
      }
    }
    return l
  })
}

/**
 * Native line-provenance keys: conversion evidence (`purchaseOrderLineId`,
 * `convertedFrom`) and AP-capture evidence (`apCaptureEvidence`). Never
 * accepted from a caller (echoed or forged) and never colliding with tenant
 * definitions: stripped from input and validated output, then re-attached
 * from the locked rows onto identity-matched lines (see the mutate block).
 * Goods-receipt `receipt` evidence is never whitelisted here.
 */
const NATIVE_LINE_CUSTOM_KEYS = [
  'purchaseOrderLineId',
  'convertedFrom',
  'apCaptureEvidence',
  // Stock-return evidence on a credit memo. The operator CHOOSES the source
  // movement, but they choose it through the typed `inventoryReturnSource`
  // line field: the server validates that choice and writes this bag itself.
  // Listing it here keeps a caller from forging it directly, and keeps a
  // description-only save from stripping a return the credit already claims.
  'inventoryReturn',
] as const

/** Drop caller-supplied native provenance keys; tenant values pass through. */
function stripNativeLineCustom(
  values: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  if (!values || typeof values !== 'object') return {}
  const out = { ...values }
  for (const key of NATIVE_LINE_CUSTOM_KEYS) delete out[key]
  return out
}

/** Reference equality for source-bound line fields: null and '' are both blank. */
function normLineRef(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const text = String(value)
  return text === '' ? null : text
}

/** Quantity equality at the quantity column's own 8dp scale. */
function sameLineQuantity(a: unknown, b: unknown): boolean {
  const left = normLineRef(a)
  const right = normLineRef(b)
  if (left === null || right === null) return left === right
  const exactLeft = canonicalDecimal(left, 8)
  const exactRight = canonicalDecimal(right, 8)
  return exactLeft !== null && exactLeft === exactRight
}

/** True when a persisted custom bag carries conversion/capture evidence. */
function persistedLineProvenance(custom: unknown): Record<string, unknown> | null {
  if (!custom || typeof custom !== 'object') return null
  const bag = custom as Record<string, unknown>
  const out: Record<string, unknown> = {}
  let found = false
  for (const key of NATIVE_LINE_CUSTOM_KEYS) {
    if (bag[key] !== undefined) {
      out[key] = bag[key]
      found = true
    }
  }
  return found ? out : null
}

/**
 * Classify persisted native evidence. 'source-bound' lines advance a
 * billed-quantity cover on a source order line and take the identity and
 * source-bound guards; 'audit-only' lines (capture evidence with no PO
 * reference — materializeCapture writes it on every line) are preserved by
 * identity but otherwise edit like ordinary lines; 'malformed' reservation
 * evidence fails closed with a reconcile remedy.
 */
function nativeReservationKind(custom: unknown): 'source-bound' | 'audit-only' | 'malformed' | null {
  const evidence = persistedLineProvenance(custom)
  if (!evidence) return null
  let bound = false
  let audit = false
  const conv = evidence.convertedFrom
  if (conv !== undefined) {
    if (!conv || typeof conv !== 'object') return 'malformed'
    const parts = conv as Record<string, unknown>
    if (
      typeof parts.lineId !== 'string' || !isUuid(parts.lineId) ||
      typeof parts.quantity !== 'string' || canonicalDecimal(parts.quantity, 8) === null
    ) {
      return 'malformed'
    }
    bound = true
  }
  const direct = evidence.purchaseOrderLineId
  if (direct !== undefined) {
    if (typeof direct !== 'string' || !isUuid(direct)) return 'malformed'
    bound = true
  }
  const capture = evidence.apCaptureEvidence
  if (capture !== undefined) {
    if (!capture || typeof capture !== 'object') return 'malformed'
    const poLine = (capture as Record<string, unknown>).purchaseOrderLineId
    if (poLine === null || poLine === undefined) {
      audit = true
    } else if (typeof poLine === 'string' && isUuid(poLine)) {
      bound = true
    } else {
      return 'malformed'
    }
  }
  // Stock-return evidence is audit-only: it binds the credit to a movement,
  // not to a source order line's billed-quantity cover, so it takes no
  // source-bound guard — but it MUST be classified, or a description-only save
  // would find no evidence on the document, skip reattachment entirely, and
  // silently drop the return the credit claims. Its shape is checked here
  // because a bag nothing can interpret must fail closed rather than reach
  // posting as an unreadable return.
  const inventoryReturn = evidence.inventoryReturn
  if (inventoryReturn !== undefined) {
    if (!inventoryReturn || typeof inventoryReturn !== 'object') return 'malformed'
    const parts = inventoryReturn as Record<string, unknown>
    const receipt = parts.sourceReceiptMovementId
    const issue = parts.sourceIssueMovementId
    const named = [receipt, issue].filter((value) => value !== undefined)
    // Exactly one leg: a bag naming both would let the two return engines
    // disagree about which movement this credit consumed.
    if (named.length !== 1) return 'malformed'
    if (typeof named[0] !== 'string' || !isUuid(named[0])) return 'malformed'
    for (const optional of [parts.lotId, parts.serialId]) {
      if (optional === undefined || optional === null) continue
      if (typeof optional !== 'string' || !isUuid(optional)) return 'malformed'
    }
    audit = true
  }
  if (bound) return 'source-bound'
  return audit ? 'audit-only' : null
}

/** Credit kinds that may return stock, and which leg each one returns. */
const RETURN_SIDE_BY_KIND: Record<string, ReturnSide> = {
  vendor_credit: 'purchase',
  customer_credit: 'sales',
}

/**
 * Turn the operator's chosen return source into trusted `custom.inventoryReturn`
 * evidence, inside the write transaction that already holds the document lock.
 *
 * The caller names a movement; the server decides whether that movement is
 * returnable and writes the bag. `assertReturnSourceSelectable` reads the same
 * query the picker lists from, so the editor cannot offer a source the save
 * refuses, and cannot save one the picker never offered.
 *
 * Tri-state per line: absent preserves what reattachment restored, null clears
 * the return, an object replaces it.
 */
async function applyInventoryReturnSelections(
  tx: SqlExecutor,
  orgId: string,
  documentId: string,
  kind: string,
  submitted: DocumentLineInput[],
  preparedLines: { itemId: string | null; stockLocationId: string | null; custom: Record<string, unknown> }[],
): Promise<void> {
  if (submitted.length !== preparedLines.length) return
  const touched = submitted.some((line) => line.inventoryReturnSource !== undefined)
  if (!touched) return
  const side = RETURN_SIDE_BY_KIND[kind]
  if (!side) {
    const at = submitted.findIndex((line) => line.inventoryReturnSource !== undefined) + 1
    throw new DocumentEditError(
      422,
      `Line ${at}: only a vendor credit or a customer credit can return stock — ` +
        `a ${kind} has no shipment or receipt to return against; nothing was changed`,
    )
  }
  const party = (await tx.execute<{ partyId: string | null; subsidiaryId: string | null }>(sql`
    select party_id as "partyId", subsidiary_id as "subsidiaryId"
      from documents where id = ${documentId} and org_id = ${orgId}
  `)).rows[0]
  for (let i = 0; i < submitted.length; i++) {
    const selection = submitted[i]!.inventoryReturnSource
    if (selection === undefined) continue
    const prepared = preparedLines[i]!
    if (selection === null) {
      // Clearing is explicit: drop the bag rather than leaving a return the
      // operator removed from the line they are looking at.
      const { inventoryReturn: _cleared, ...rest } = prepared.custom
      prepared.custom = rest
      continue
    }
    if (!party?.partyId) {
      throw new DocumentEditError(
        422,
        `Line ${i + 1}: select the ${side === 'purchase' ? 'vendor' : 'customer'} before choosing what this credit returns; nothing was changed`,
      )
    }
    if (!prepared.itemId || !prepared.stockLocationId) {
      throw new DocumentEditError(
        422,
        `Line ${i + 1}: a returned line needs both an item and a warehouse before its ` +
          `${side === 'purchase' ? 'receipt' : 'shipment'} can be selected; nothing was changed`,
      )
    }
    // The validator scopes to the credit's own legal entity — the same scope
    // the picker lists and the posting guard enforces — so a source saved
    // from another entity is refused here, at save, instead of at posting.
    // The party guard above already threw when the credit names no party,
    // so a missing subsidiary here names the subsidiary remedy, not the party.
    const creditSubsidiaryId = party?.subsidiaryId ?? null
    if (!creditSubsidiaryId) {
      throw new DocumentEditError(
        422,
        `Line ${i + 1}: choose the credit's subsidiary before choosing what this credit returns; nothing was changed`,
      )
    }
    try {
      await assertReturnSourceSelectable(
        tx,
        orgId,
        {
          side,
          partyId: party.partyId,
          itemId: prepared.itemId,
          stockLocationId: prepared.stockLocationId,
          movementId: selection.movementId,
          subsidiaryIds: [creditSubsidiaryId],
          lotId: selection.lotId ?? null,
          serialId: selection.serialId ?? null,
        },
        `Line ${i + 1}`,
      )
    } catch (error) {
      if (error instanceof InventoryError) throw new DocumentEditError(422, `${error.message}; nothing was changed`)
      throw error
    }
    prepared.custom = {
      ...prepared.custom,
      inventoryReturn: {
        [side === 'purchase' ? 'sourceReceiptMovementId' : 'sourceIssueMovementId']: selection.movementId,
        ...(selection.lotId ? { lotId: selection.lotId } : {}),
        ...(selection.serialId ? { serialId: selection.serialId } : {}),
      },
    }
  }
}

/**
 * Human label for a conversion child's source order(s), for refusal messages
 * (same 'bills'/'created_from' order edges the currency guard reads).
 * Capture-only bills carry no edge and read as "its purchase order".
 */
async function conversionSourceLabel(
  tx: DocumentTransaction,
  orgId: string,
  documentId: string,
): Promise<string> {
  const sources = (await tx.execute<{ kind: string; documentNumber: string }>(sql`
    select source.kind, source.document_number as "documentNumber"
      from document_links link
      join documents source
        on source.id = link.from_document_id
       and source.org_id = link.org_id
     where link.org_id = ${orgId}
       and link.to_document_id = ${documentId}
       and link.link_type in ('bills', 'created_from')
       and source.kind in ('quote', 'sales_order', 'purchase_order')
     order by source.document_number
  `)).rows
  if (sources.length === 0) return 'its purchase order'
  return sources.map((source) => `${source.kind.replaceAll('_', ' ')} ${source.documentNumber}`).join(', ')
}

/**
 * Entry-mode allocation gate. The `allocationsAtEntry` key is owned by the
 * platform slice (A10) and registered on main; gate failures propagate
 * instead of silently disabling the path. Exported for the data-io import
 * writer, which shares the gate. Feature off saves lines untouched.
 */
export async function entryAllocationsEnabled(orgId: string): Promise<boolean> {
  return isFeatureEnabled(orgId, 'allocationsAtEntry')
}

/**
 * Plan entry-mode distributions for a document save: resolve explicit
 * distributionKeys (unknown/inactive/wrong-mode keys are clear 422s),
 * load the entry rules in effect on the document date, preload the account
 * groups referenced by their scopes, snapshot the stored groups for re-save
 * matching, and run the pure kernel planner. Returns null when the feature
 * is off — the submitted lines are then saved untouched.
 */
async function planDocumentEntryAllocations(args: {
  orgId: string
  documentId: string
  kind: string
  documentDate: string
  header: Pick<
    DocumentEditInput,
    'departmentId' | 'projectId' | 'locationId' | 'classId' | 'subsidiaryId'
  >
  lines: DocumentLineInput[]
  unsplitDistributionGroups?: string[]
}): Promise<EntryPlan | null> {
  const { orgId } = args
  if (!(await entryAllocationsEnabled(orgId))) return null
  const asOf = args.documentDate

  const keys = [
    ...new Set(
      args.lines
        .map((l) => l.distributionKey)
        .filter((k): k is string => typeof k === 'string' && k.length > 0),
    ),
  ]
  const explicitRules = new Map<string, RuleInEffect>()
  for (const key of keys) {
    const lookup = await loadEntryRuleByKey(orgId, key, asOf)
    if (lookup.status === 'not_found') {
      throw new DocumentEditError(422, `distributionKey "${key}" does not match an allocation rule`)
    }
    if (lookup.status === 'wrong_mode') {
      throw new DocumentEditError(
        422,
        `distributionKey "${key}" is a ${lookup.mode} rule — only entry rules can split document lines`,
      )
    }
    if (lookup.status === 'inactive') {
      throw new DocumentEditError(
        422,
        `distributionKey "${key}" is not active with a published version in effect`,
      )
    }
    explicitRules.set(key, lookup.rule)
  }

  const rules = await listEntryRulesInEffect({ orgId, mode: 'entry', asOf })

  // Account-group scopes resolve through one preloaded membership map per
  // referenced (dimension, groupKey) pair, keeping the matcher itself db-free.
  const needs = new Map<string, { dimension: string; groupKey: string }>()
  for (const r of [...rules, ...explicitRules.values()]) {
    const scope = r.version.accountScope
    if (scope.kind === 'account_group') {
      needs.set(JSON.stringify([scope.dimension, scope.groupKey]), {
        dimension: scope.dimension,
        groupKey: scope.groupKey,
      })
    }
  }
  let resolveAccountGroup: ((dimension: string, groupKey: string) => Set<string>) | undefined
  if (needs.size > 0) {
    const memberships = new Map<string, Set<string>>()
    for (const need of needs.values()) {
      const resolved = await resolveAccountGroups(need.dimension, orgId)
      const members = new Set<string>()
      for (const [accountId, ref] of resolved.byAccount) {
        if (ref.key === need.groupKey) members.add(accountId)
      }
      memberships.set(JSON.stringify([need.dimension, need.groupKey]), members)
    }
    resolveAccountGroup = (dimension, groupKey) =>
      memberships.get(JSON.stringify([dimension, groupKey])) ?? new Set<string>()
  }

  // Stored groups for re-save matching: group-level lock is ANY locked
  // child, and the total is normalized so the planner's exact comparison
  // cannot trip on numeric scale. Groups without rule stamps (never written
  // by this path) are left out — their members match fresh below.
  const existingGroups = new Map<string, StoredEntryGroup>()
  const stored = await db.execute<{
    groupId: string
    ruleId: string | null
    versionId: string | null
    locked: boolean
    total: string
    memberIds: string[]
  }>(sql`
    select distribution_group_id as "groupId",
           min(distribution_rule_id::text)::uuid as "ruleId",
           min(distribution_version_id::text)::uuid as "versionId",
           bool_or(distribution_locked) as "locked",
           sum(amount)::text as "total",
           array_agg(id order by line_number) as "memberIds"
      from document_lines
     where document_id = ${args.documentId} and org_id = ${orgId}
       and distribution_group_id is not null
     group by distribution_group_id
  `)
  for (const row of stored.rows) {
    if (!row.ruleId || !row.versionId) continue
    existingGroups.set(row.groupId, {
      groupId: row.groupId,
      ruleId: row.ruleId,
      versionId: row.versionId,
      locked: row.locked === true,
      total: normalizeMoney(row.total),
      memberIds: row.memberIds ?? [],
    })
  }

  // Header-default dims feed the match coordinate when a line leaves them blank.
  const headerRow = (
    await db.execute<{
      departmentId: string | null
      projectId: string | null
      locationId: string | null
      classId: string | null
      subsidiaryId: string | null
    }>(sql`
      select department_id as "departmentId", project_id as "projectId",
             location_id as "locationId", class_id as "classId",
             subsidiary_id as "subsidiaryId"
        from documents where id = ${args.documentId} and org_id = ${orgId}
    `)
  ).rows[0]
  const docContext: EntryDocumentContext = {
    kind: args.kind,
    departmentId: args.header.departmentId ?? headerRow?.departmentId ?? null,
    projectId: args.header.projectId ?? headerRow?.projectId ?? null,
    locationId: args.header.locationId ?? headerRow?.locationId ?? null,
    classId: args.header.classId ?? headerRow?.classId ?? null,
    subsidiaryId: args.header.subsidiaryId ?? headerRow?.subsidiaryId ?? null,
    unsplitDistributionGroups: args.unsplitDistributionGroups,
  }
  const entryLines: EntryLineInput[] = args.lines.map((l) => ({
    accountId: l.accountId!,
    amount: String(l.amount),
    quantity: l.quantity ?? null,
    unit: l.unit ?? null,
    unitPrice: l.unitPrice ?? null,
    itemId: l.itemId ?? null,
    description: l.description ?? null,
    taxCodeId: l.taxCodeId ?? null,
    taxGroupId: l.taxGroupId ?? null,
    partyId: l.partyId ?? null,
    departmentId: l.departmentId ?? null,
    projectId: l.projectId ?? null,
    locationId: l.locationId ?? null,
    classId: l.classId ?? null,
    subsidiaryId: null,
    stockLocationId: l.stockLocationId ?? null,
    extraDims: Object.fromEntries(
      Object.entries(l.extraDims ?? {}).filter(([, v]) => v !== null && v !== undefined),
    ) as Record<string, string>,
    custom: l.custom ?? {},
    isBillable: null,
    distributionKey: l.distributionKey ?? null,
    distributionGroupId: l.distributionGroupId ?? null,
    distributionLocked: l.distributionLocked ?? null,
  }))
  try {
    return planEntryDistributions(docContext, entryLines, rules, {
      explicitRules,
      existingGroups,
      resolveAccountGroup,
    })
  } catch (error) {
    if (error instanceof EntryAllocationError) throw new DocumentEditError(422, error.message)
    throw error
  }
}

/**
 * A document-layer signature of everything that shapes a posting document's GL
 * impact. Comparing before vs after a save tells us whether the edit was
 * GL-affecting WITHOUT assuming the stored entry was produced by our own
 * posting rules (migrated docs carry the source system's GL). Non-GL edits
 * (memo, reference #) leave this unchanged and never touch the ledger.
 */
/**
 * Apply a header + lines edit to a draft posting document. Approval snapshots
 * and posted history are immutable; rejected records return to draft before
 * editing, and posted corrections use controlled reversals/adjustments.
 *
 * Callers own auth + status/lock guards; this owns validation, the write, GL,
 * audit, and flows.
 */
export async function applyDocumentEdit(
  id: string,
  current: DocumentEditCurrent,
  body: DocumentEditInput,
  ctx: DocumentEditContext,
  /**
   * Join a caller-owned transaction instead of opening one: validation reads
   * and the versioned write all ride the caller's tx, so the caller's claim
   * and this edit commit or roll back together. The caller must fire the
   * deferred on_update event itself (see ctx.deferFlows) after committing.
   */
  scope?: { tx: DocumentTransaction },
): Promise<DocumentUpdateFlowEvent | undefined> {
  const cfg = docKindConfig(current.kind)
  if (!cfg) throw new DocumentEditError(422, `kind "${current.kind}" is not editable`)
  if (current.status !== 'draft') {
    throw new DocumentEditError(
      422,
      `a ${current.status} document cannot be edited — return it to draft or create a controlled correction`,
    )
  }
  const { orgId, userId } = ctx
  // Validation reads ride the caller's tx when one owns this edit, so they
  // observe the caller's uncommitted claim (the fresh row's own currency);
  // every other read is committed reference data either way.
  const runner = scope?.tx ?? db

  // Every call edits a row that already exists. Internal create/correction
  // paths read its exact persisted token first; no row shape may authorize a
  // missing revision.
  const expectedRevision = requireDocumentEditRevision(body.expectedUpdatedAt)

  // Kinds with a party role (vendor/customer) must keep a party — an explicit
  // null would strand the document without the entity its posting depends on.
  if (cfg.partyRole && body.partyId === null) {
    throw new DocumentEditError(422, `a ${current.kind} requires a ${cfg.partyRole}; the party cannot be removed`)
  }
  // Every document carries its legal entity: posting falls back to the root
  // when it is null, but every subsidiary-scoped list excludes null, so an
  // explicit null would hide a live document from restricted readers while
  // its ledger entries remain. Creation always assigns the root; null is
  // never a legitimate assignment.
  if (body.subsidiaryId === null) {
    throw new DocumentEditError(422, `a ${current.kind} requires a subsidiary; the subsidiary cannot be removed`)
  }
  if (body.subsidiaryId !== undefined && body.subsidiaryId !== null) {
    if (!isUuid(body.subsidiaryId)) throw new DocumentEditError(422, 'invalid subsidiaryId')
    const subsidiary = (await runner.execute(sql`
      select 1 from subsidiaries
       where id = ${body.subsidiaryId} and org_id = ${orgId}
         and is_active and not is_elimination`))
    if (!subsidiary.rows.length) throw new DocumentEditError(422, 'invalid subsidiary')
  }
  // Header dates and reference ids reach DATE/uuid columns uncast: a malformed
  // value dies at the storage layer as a raw 500 instead of a domain error.
  // Fail closed here — once, for every caller (UI routes, public API, MCP,
  // assistant) — covering both shape-invalid strings and impossible days.
  // Explicit nulls keep their existing clear-the-field semantics.
  const headerDates = [body.documentDate, body.dueDate, body.postingDate, body.expectedPayDate] as const
  const headerDateNames = ['documentDate', 'dueDate', 'postingDate', 'expectedPayDate'] as const
  for (let i = 0; i < headerDates.length; i++) {
    const value = headerDates[i]
    if (value !== undefined && value !== null && !isIsoCalendarDate(value)) {
      throw new DocumentEditError(422, `invalid ${headerDateNames[i]} — expected YYYY-MM-DD`)
    }
  }
  const headerRefs = [body.partyId, body.paymentCardId, body.departmentId, body.projectId, body.locationId, body.classId] as const
  const headerRefNames = ['partyId', 'paymentCardId', 'departmentId', 'projectId', 'locationId', 'classId'] as const
  for (let i = 0; i < headerRefs.length; i++) {
    const value = headerRefs[i]
    if (value !== undefined && value !== null && !isUuid(value)) {
      throw new DocumentEditError(422, `invalid ${headerRefNames[i]}`)
    }
  }
  // Tenant ownership of every referenced header id. The composite FKs would
  // refuse a foreign id at the write as an unhandled storage error (raw
  // 500); refuse it here with a tenant-opaque 404 that reveals nothing about
  // other tenants' records — same contract as the line-account precheck
  // below. Only ids actually present are looked up.
  const headerOwners: { label: string; table: 'parties' | 'payment_cards' | 'departments' | 'projects' | 'locations' | 'classes'; value: string }[] = []
  if (body.partyId !== undefined && body.partyId !== null) headerOwners.push({ label: 'party', table: 'parties', value: body.partyId })
  if (body.paymentCardId !== undefined && body.paymentCardId !== null) headerOwners.push({ label: 'payment card', table: 'payment_cards', value: body.paymentCardId })
  if (body.departmentId !== undefined && body.departmentId !== null) headerOwners.push({ label: 'department', table: 'departments', value: body.departmentId })
  if (body.projectId !== undefined && body.projectId !== null) headerOwners.push({ label: 'project', table: 'projects', value: body.projectId })
  if (body.locationId !== undefined && body.locationId !== null) headerOwners.push({ label: 'location', table: 'locations', value: body.locationId })
  if (body.classId !== undefined && body.classId !== null) headerOwners.push({ label: 'class', table: 'classes', value: body.classId })
  for (const ref of headerOwners) {
    const owned = await runner.execute(sql`select 1 from ${sql.raw(`"${ref.table}"`)} where id = ${ref.value} and org_id = ${orgId}`)
    if (!owned.rows.length) throw new DocumentEditError(404, `${ref.label} not found in this organization`)
  }

  if (body.currency !== undefined && !(await isFeatureEnabled(orgId, 'multiCurrency'))) {
    throw new DocumentEditError(404, 'not found')
  }
  let currency: string | undefined
  if (body.currency !== undefined) {
    const code = String(body.currency).trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(code)) throw new DocumentEditError(422, 'invalid currency')
    const found = (await runner.execute(sql`select 1 from currencies where code = ${code}`)) as { rows: unknown[] }
    if (!found.rows[0]) throw new DocumentEditError(422, 'invalid currency')
    currency = code
  }

  // custom-field validation (header + line) against the live definitions
  // applyDocumentEdit can participate in a caller-owned transaction (posted
  // correction initialization). Do not overlap queries on that one pinned
  // node-postgres client; concurrent client.query calls are unsupported and
  // can reorder protocol messages under load.
  const headerDefs = await loadFieldDefs('documents', current.kind)
  const lineDefs = await loadFieldDefs('document_lines', current.kind)
  const segments = await segmentRegistry(orgId)
  const headerDims = body.extraDims === undefined ? null : validateExtraDims(body.extraDims, segments)
  if (headerDims && !headerDims.ok) throw new DocumentEditError(422, headerDims.error!)
  let headerCustom: Record<string, unknown> | null = null
  if (body.custom !== undefined) {
    const supplied = body.custom
    const existingCustom = current.custom ?? {}
    const v = validateCustomValues(headerDefs, { ...existingCustom, ...supplied })
    if (!v.ok) throw new DocumentEditError(422, Object.values(v.errors)[0]!, v.errors)
    // Reference custom values are uuid-SHAPED at this point but nothing
    // proves the referenced row belongs to the caller: refuse foreign or
    // dangling ids with a tenant-opaque 404 instead of persisting a
    // cross-tenant pointer. Supplied values only, so legacy bags written
    // before this fence cannot lock unrelated edits.
    const suppliedHeaderCustom: Record<string, unknown> = {}
    for (const key of Object.keys(supplied)) {
      if (v.cleaned[key] !== undefined) suppliedHeaderCustom[key] = v.cleaned[key]
    }
    const unownedHeaderRefs = await findUnownedCustomReferences(orgId, headerDefs, suppliedHeaderCustom)
    if (unownedHeaderRefs.length > 0) {
      const def = unownedHeaderRefs[0]!
      throw new DocumentEditError(404, `${def.label} not found in this organization`, { [def.key]: 'not found in this organization' })
    }
    headerCustom = { ...existingCustom, ...v.cleaned }
    for (const def of headerDefs) {
      if (Object.prototype.hasOwnProperty.call(supplied, def.key) && supplied[def.key] == null) {
        delete headerCustom[def.key]
      }
    }
  }
  // Structural funding override (the drawer's fundingSource picker: deposit
  // destination, check source, card liability). It is not a registered
  // custom field, so validateCustomValues cannot see it — without an
  // explicit carry the picker silently stops persisting (the save succeeds
  // and the reopen shows '—'). Fence it like a reference: uuid-shaped and
  // owned by this org's reconcilable funding accounts of the kind's type,
  // the exact set the picker lists. An absent key leaves the stored bag
  // untouched; an explicit null/'' clears back to the org default.
  // F-t05-020 extends the F-t04-013 bank carry to fundingSource='card':
  // with no card instruments on file the drawer offers reconcilable
  // card-liability accounts, saved as the controlAccountId override the
  // engine cardRule already reads first.
  const fundingAccountType =
    cfg?.fundingSource === 'bank' ? 'asset_bank'
    : cfg?.fundingSource === 'card' ? 'liability_card'
    : null
  const fundingNoun = cfg?.fundingSource === 'card' ? 'card liability account' : 'bank account'
  if (body.custom !== undefined && fundingAccountType) {
    const override = (body.custom as Record<string, unknown>).controlAccountId
    if (override !== undefined) {
      if (override === null || override === '') {
        if (headerCustom) delete headerCustom.controlAccountId
      } else {
        if (
          typeof override !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(override)
        ) {
          throw new DocumentEditError(422, `${cfg?.fundingSource === 'card' ? 'card account' : 'funding bank'} must be a valid record reference`)
        }
        const owned = (await runner.execute<{ id: string }>(sql`
          select id from accounts
           where org_id = ${orgId} and is_active and not is_summary
             and reconcilable and type = ${fundingAccountType} and id = ${override}::uuid
        `))
        if (!owned.rows[0]) throw new DocumentEditError(404, `${fundingNoun} not found in this organization`)
        headerCustom = { ...(headerCustom ?? current.custom ?? {}), controlAccountId: override }
      }
    }
  }

  // Pre-validate + prepare lines before touching the DB, so a bad line fails
  // without a partial write.
  let totals: { subtotal: string; taxTotal: string; total: string } | null = null
  // Entry-mode distribution plan for this save (null when the feature is off
  // or no lines were submitted). Declared beside preparedLines so the write
  // transaction below can persist its stamps and lineage rows.
  let entryPlan: EntryPlan | null = null
  // Stable line identities for the native-provenance match below, aligned
  // with body.lines order (and with preparedLines while the entry plan did
  // not explode the line set — the same index correspondence the
  // distribution stamps rely on). Null = new line.
  let submittedLineKeys: (string | null)[] | null = null
  let preparedLines:
    | { accountId: string; itemId: string | null; description: string | null; quantity: string | null; unit: string | null; unitPrice: string | null; amount: string; taxCodeId: string | null; taxGroupId: string | null; taxInputAmount: string; taxAmount: string; taxOverridden: boolean; taxComponents: ReturnType<typeof computeBillTotals>['lines'][number]['taxComponents']; providerQuote?: ReturnType<typeof computeBillTotals>['lines'][number]['providerQuote']; partyId: string | null; departmentId: string | null; projectId: string | null; locationId: string | null; classId: string | null; stockLocationId: string | null; extraDims: Record<string, string>; custom: Record<string, unknown>; distributionGroupId: string | null; distributionRuleId: string | null; distributionVersionId: string | null; distributionLocked: boolean }[]
    | null = null
  if (body.lines) {
    // Charge lines are NOT editable through the generic line editor, and this
    // has to be refused at the service boundary rather than by the drawer
    // hiding the controls (which is all that stopped it before).
    //
    // The generic path replaces lines by delete-and-reinsert with the shared
    // column set. A project charge or field ticket line also carries an
    // immutable rate snapshot (rate_version_id, base_quantity, cost/bill
    // amounts, the charge_rate_components rows keyed to the line id) and now
    // the equipment unit and its OPERATOR. Re-inserting through the generic
    // shape silently drops every one of them: the customer's billable value
    // becomes zero, the rate components orphan, and the operator's equipment
    // incentive quietly stops being payable. Those lines have their own
    // writers (createProjectCharge / addTicketLine) and must go through them.
    if (current.kind === 'project_charge' || current.kind === 'field_ticket') {
      throw new DocumentEditError(
        422,
        `${current.kind} lines carry an immutable rate snapshot and cannot be edited here; ` +
          `change them on the source record`,
      )
    }
    // Native provenance is never caller-supplied (echoed or forged): strip
    // it here and from the validated output; trusted evidence is re-attached
    // from the locked rows in the write transaction.
    body.lines = body.lines.map((l) => {
      const custom = l.custom
      if (!custom || typeof custom !== 'object') return l
      if (!NATIVE_LINE_CUSTOM_KEYS.some((key) => (custom as Record<string, unknown>)[key] !== undefined)) {
        return l
      }
      return { ...l, custom: stripNativeLineCustom(custom as Record<string, unknown>) }
    })
    // Stable line identities ride the save for provenance matching. Shape and
    // duplicates fail here; ownership is proven under the document lock in
    // the write transaction (a pre-lock check could go stale).
    submittedLineKeys = body.lines.map((l) => {
      const raw = l.lineId
      if (raw === undefined || raw === null || raw === '') return null
      if (typeof raw !== 'string' || !isUuid(raw)) {
        const at = body.lines!.findIndex((other) => other.lineId === raw) + 1
        throw new DocumentEditError(422, `Line ${at}: invalid line identity — reload the document and save again`)
      }
      // UUIDs are case-equivalent (routes already treat them so): canonicalize
      // before duplicate detection and matching, or 'A…' and 'a…' read as two
      // lines and a valid uppercase identity misses its persisted row.
      return raw.toLowerCase()
    })
    if (submittedLineKeys.some((key) => key !== null)) {
      const seen = new Set<string>()
      for (let i = 0; i < submittedLineKeys.length; i++) {
        const key = submittedLineKeys[i]!
        if (key === null) continue
        if (seen.has(key)) {
          throw new DocumentEditError(
            422,
            `Line ${i + 1}: duplicate line identity — reload the document and save again; nothing was changed`,
          )
        }
        seen.add(key)
      }
    }
    // Silent single-warehouse default (F-t07-003 pickers): a stocked line
    // with no explicit warehouse takes the org's only active location, so
    // nobody answers a question with one possible answer. Several locations
    // (or a non-stocked item) leave the line blank for the picker, and the
    // stamped id flows through the same ownership checks below as an
    // explicitly chosen one. This only ever fills blanks, matching what the
    // posting reader would resolve the line to.
    if (body.lines.some((l) => (l.stockLocationId ?? '') === '')) {
      const active = await activeStockLocations(orgId)
      const singleDefault = active.length === 1 ? active[0]!.id : null
      if (singleDefault) {
        const profiled = await profiledItemIds(
          orgId,
          body.lines.map((l) => l.itemId).filter((v): v is string => typeof v === 'string' && v.length > 0),
        )
        body.lines = body.lines.map((l) =>
          (l.stockLocationId ?? '') === '' && l.itemId && profiled.has(l.itemId)
            ? { ...l, stockLocationId: singleDefault }
            : l,
        )
      }
    }
    // Line accounts are the tenant's chart of accounts. The lines FK is
    // tenant-coherent, so a foreign account dies at the re-insert as an
    // unhandled storage error; refuse it here with a domain 404 that
    // reveals nothing about other tenants' charts. Scoped to org ownership
    // only: posting-time postability (active, non-summary) keeps its own
    // domain errors later, so drafts holding a since-deactivated account
    // still save.
    const lineAccountIds = [...new Set(body.lines.map((l) => l.accountId).filter((v): v is string => typeof v === 'string' && v.length > 0))]
    const malformedLineAccounts = lineAccountIds.filter((v) => !isUuid(v))
    const usableLineAccounts = malformedLineAccounts.length === 0 && lineAccountIds.length > 0
      ? (await runner.execute<{ id: string }>(sql`
          select id from accounts
           where org_id = ${orgId} and id = any(${`{${lineAccountIds.join(',')}}`}::uuid[])`)).rows
      : []
    if (malformedLineAccounts.length > 0 || usableLineAccounts.length !== lineAccountIds.length) {
      throw new DocumentEditError(404, 'account not found in this organization')
    }
    // Line dimension references ride the same uncast path into the re-insert:
    // a malformed id dies as 22P02 and a foreign id as 23503, both unhandled
    // storage errors. Shape-check every submitted reference first, then prove
    // tenant ownership batched per table (same contract as line accounts).
    const lineRefDefs = [
      { key: 'partyId', label: 'party', table: 'parties' },
      { key: 'departmentId', label: 'department', table: 'departments' },
      { key: 'projectId', label: 'project', table: 'projects' },
      { key: 'locationId', label: 'location', table: 'locations' },
      { key: 'classId', label: 'class', table: 'classes' },
      { key: 'itemId', label: 'item', table: 'items' },
      { key: 'stockLocationId', label: 'stock location', table: 'stock_locations' },
    ] as const
    for (let i = 0; i < body.lines.length; i++) {
      const line = body.lines[i]!
      for (const def of lineRefDefs) {
        const value = line[def.key]
        if (value !== undefined && value !== null && !isUuid(value)) {
          throw new DocumentEditError(422, `Line ${i + 1}: invalid ${def.key}`)
        }
      }
    }
    for (const def of lineRefDefs) {
      const ids = [...new Set(body.lines.map((l) => l[def.key]).filter((v): v is string => typeof v === 'string' && v.length > 0))]
      if (ids.length === 0) continue
      const owned = new Set((await runner.execute<{ id: string }>(sql`
        select id from ${sql.raw(`"${def.table}"`)}
         where org_id = ${orgId} and id = any(${`{${ids.join(',')}}`}::uuid[])`)).rows.map((r) => r.id))
      const foreign = ids.find((v) => !owned.has(v))
      if (foreign !== undefined) {
        const lineNumber = body.lines.findIndex((l) => l[def.key] === foreign) + 1
        throw new DocumentEditError(404, `Line ${lineNumber}: ${def.label} not found in this organization`)
      }
    }
    // Allocation kernel, entry mode: explode distribution lines BEFORE totals
    // + tax so every child is taxed as its own real line. A null plan means
    // the feature is off and the submitted lines are saved untouched.
    entryPlan = await planDocumentEntryAllocations({
      orgId,
      documentId: id,
      kind: current.kind,
      documentDate: body.documentDate ?? current.documentDate,
      header: body,
      lines: body.lines,
      unsplitDistributionGroups: body.unsplitDistributionGroups,
    })
    const linesForTotals: DocumentLineInput[] = entryPlan ? entryPlan.lines : body.lines
    // Validate, don't filter. The old `filter((l) => l.accountId && cmp(l.amount, '0') > 0)`
    // dropped negative and zero lines before the totals were computed, so any
    // edit of a document carrying one rewrote it without that line — the
    // credit-memo leg disappeared and the balance silently moved. Every line
    // the caller sent now either reaches computeBillTotals exactly as
    // submitted (the tax engine handles signed bases) or fails closed with a
    // 422 naming the offending line.
    let computed: Awaited<ReturnType<typeof computeBillTotalsWithProvider>>
    // An explosion changes the line set the totals were precomputed for (and
    // taxes every child individually), so a structural change always
    // recomputes instead of reusing the create-path preflight.
    if (ctx.precomputedTotals && !entryPlan?.exploded) {
      computed = ctx.precomputedTotals
    } else {
      try {
        computed = await computeBillTotalsWithProvider(
          validateEditableDocumentLines(linesForTotals),
          await taxProfileMap(orgId, body.documentDate ?? current.documentDate),
          {
            orgId,
            kind: current.kind,
            currency: currency ?? (await runner.execute<{ currency: string }>(sql`
              select currency from documents where id = ${id} and org_id = ${orgId}`)).rows[0]?.currency ?? await orgBaseCurrency(orgId),
            documentDate: body.documentDate ?? current.documentDate,
            partyId: body.partyId !== undefined ? body.partyId : current.partyId,
            subsidiaryId: body.subsidiaryId !== undefined ? body.subsidiaryId : current.subsidiaryId,
            taxProviderAddresses: documentTaxProviderAddresses(headerCustom ?? current.custom),
          },
        )
      } catch (error) {
        throw new DocumentEditError(422, error instanceof Error ? error.message : String(error))
      }
    }
    totals = {
      subtotal: normalizeMoney(computed.subtotal),
      taxTotal: normalizeMoney(computed.taxTotal),
      total: normalizeMoney(computed.total),
    }
    // A transfer moves one amount between two accounts; its two legs carry the
    // same amount, so the document total is that amount — NOT the summed legs.
    if (current.kind === 'transfer' && computed.lines.length > 0) {
      const amt = normalizeMoney(computed.lines[0]!.amount)
      totals = { subtotal: amt, taxTotal: '0.0000', total: amt }
    }
    preparedLines = []
    for (let i = 0; i < computed.lines.length; i++) {
      const l = computed.lines[i]! as (typeof computed.lines)[number] & DocumentLineInput
      const lv = validateCustomValues(lineDefs, l.custom)
      if (!lv.ok) throw new DocumentEditError(422, `Line ${i + 1}: ${Object.values(lv.errors)[0]}`, lv.errors)
      // A tenant definition colliding with a native key cannot smuggle a
      // caller value past the input strip above: native keys never survive
      // into the persisted bag except from the locked rows below.
      for (const key of NATIVE_LINE_CUSTOM_KEYS) delete lv.cleaned[key]
      // Lines are replaced wholesale, so the whole submitted line bag is
      // newly supplied: refuse foreign or dangling reference ids here, the
      // same tenant-opaque 404 the native line-ref precheck above returns.
      const unownedLineRefs = await findUnownedCustomReferences(orgId, lineDefs, lv.cleaned)
      if (unownedLineRefs.length > 0) {
        const def = unownedLineRefs[0]!
        throw new DocumentEditError(404, `Line ${i + 1}: ${def.label} not found in this organization`, { [def.key]: 'not found in this organization' })
      }
      const lineDims = validateExtraDims(l.extraDims ?? {}, segments)
      if (!lineDims.ok) throw new DocumentEditError(422, `Line ${i + 1}: ${lineDims.error}`)
      let unitPrice: string | null = null
      if (l.unitPrice != null && String(l.unitPrice).trim() !== '') {
        unitPrice = exactUnitPrice(l.unitPrice)
        if (unitPrice === null) {
          throw new DocumentEditError(422, `Line ${i + 1}: unit price is not a valid amount`)
        }
      }
      const amount = exactMoney(l.amount)
      if (amount === null) {
        throw new DocumentEditError(422, `Line ${i + 1}: amount is not a valid amount`)
      }
      // Entry-mode stamps ride the planned line by index: computed lines
      // preserve the input order, so the i-th planned line stamps the i-th
      // prepared line (nulls when the feature is off or the line stayed plain).
      const stamp = entryPlan?.lines[i]
      preparedLines.push({
        accountId: l.accountId!,
        itemId: l.itemId ?? null,
        description: l.description ?? null,
        quantity: l.quantity ?? null,
        unit: l.unit ?? null,
        unitPrice,
        amount,
        taxCodeId: l.taxCodeId ?? null,
        taxGroupId: l.taxGroupId ?? null,
        taxInputAmount: l.taxInputAmount,
        taxAmount: l.taxAmount,
        taxOverridden: l.taxOverridden === true,
        taxComponents: l.taxComponents,
        providerQuote: l.providerQuote,
        partyId: l.partyId ?? null,
        departmentId: l.departmentId ?? null,
        projectId: l.projectId ?? null,
        locationId: l.locationId ?? null,
        classId: l.classId ?? null,
        stockLocationId: l.stockLocationId ?? null,
        extraDims: lineDims.cleaned,
        custom: lv.cleaned,
        distributionGroupId: stamp?.distributionGroupId ?? null,
        distributionRuleId: stamp?.distributionRuleId ?? null,
        distributionVersionId: stamp?.distributionVersionId ?? null,
        distributionLocked: stamp?.distributionLocked ?? false,
      })
    }
  }

  // Filled under the document lock for line-level flow change detection.
  let oldLines: {
    lineNumber: number
    accountId: string | null
    departmentId: string | null
    projectId: string | null
    amount: string
  }[] = []

  // All writes + the GL-Impact re-materialization happen in one transaction, so
  // a GL edit into a closed period rolls the whole edit back (nothing partial).
  // The row lock and exact revision comparison are the first operations in that same
  // transaction: a concurrent writer cannot slip between the check and the
  // header/line replacement.
  await runDocumentVersionedTransaction<
    DocumentTransaction,
    { kind: string; status: string; updatedAt: string },
    void
  >({
    expectedRevision,
    // A caller-owned tx is joined, not nested: node-postgres cannot overlap
    // queries on one client, and a nested COMMIT would release the caller's
    // claim early.
    transaction: (work) => (scope ? work(scope.tx) : db.transaction(work)),
    lock: async (tx) => (await tx.execute<{
        kind: string
        status: string
        updatedAt: string
      }>(sql`
        select kind, status,
               ${documentRevisionCounterSql(sql.raw('revision_seq'))} as "updatedAt"
          from documents
         where id = ${id} and org_id = ${orgId}
         for update
      `)).rows[0] ?? null,
    mutate: async (tx, locked) => {
      // Attaching a project makes this draft a Projects disable-blocker
      // (open project documents), so a disable racing this edit must refuse
      // one side or the other. Fenced inside the write transaction, before
      // any write: clearing the project or editing anything else needs no
      // gate.
      if (body.projectId !== undefined && body.projectId !== null) {
        if (!(await checkProjectsWriteEnabled(orgId, tx))) {
          throw new DocumentEditError(422, 'Projects feature is disabled')
        }
      }
      if (locked.kind !== current.kind) throw new DocumentEditError(409, DOCUMENT_EDIT_REVISION_CONFLICT)
      if (locked.status !== 'draft') {
        throw new DocumentEditError(
          422,
          `a ${locked.status} document cannot be edited — return it to draft or create a controlled correction`,
        )
      }

      // Native line provenance: a description-only save used to strip
      // conversion/capture evidence (tenant validation drops keys outside
      // the definitions), so posting received the stock a second time.
      // Trusted evidence is re-attached here from the locked persisted rows,
      // matched by stable line identity — never by position, never from the
      // caller. Only this document's row (already locked above) and its own
      // lines are read; source order rows are never written, so no new lock
      // order is introduced. Every refusal below fires before any delete, so
      // a refused edit changes nothing. Documents without persisted evidence
      // keep the legacy identity-less path; their supplied identities are
      // still validated below.
      if (preparedLines && submittedLineKeys) {
        const persisted = (await tx.execute<{
          id: string
          itemId: string | null
          quantity: string | null
          unit: string | null
          stockLocationId: string | null
          custom: unknown
        }>(sql`
          select id, item_id as "itemId", quantity::text as "quantity", unit,
                 stock_location_id as "stockLocationId", custom
            from document_lines
           where document_id = ${id} and org_id = ${orgId}
           order by line_number
           for update
        `)).rows
        // Persisted ids compare in the same canonical form: the driver returns
        // uuid columns lowercase, but the match must not depend on that.
        const byId = new Map(persisted.map((row) => [row.id.toLowerCase(), row]))
        // Ownership under the lock, on every edit carrying identities — even
        // when no line carries provenance. A foreign or stale identity is the
        // tenant-opaque 404 the line-account and reference prechecks return,
        // never a silently ignored line. Identity-less saves keep the legacy
        // path unless provenance below requires identities.
        for (let i = 0; i < submittedLineKeys.length; i++) {
          const key = submittedLineKeys[i]!
          if (key !== null && !byId.has(key)) {
            throw new DocumentEditError(
              404,
              `Line ${i + 1}: line not found in this document — reload the document and save again`,
            )
          }
        }
        const evidenceOf = (row: (typeof persisted)[number]) => persistedLineProvenance(row.custom)
        const kindOf = (row: (typeof persisted)[number]) => nativeReservationKind(row.custom)
        // Unreadable reservation evidence fails closed before any matching:
        // neither the guards below nor the delete/void unwind can interpret
        // it, so the edit names reconciliation instead of preserving a cover
        // no read can observe.
        const malformed = persisted.find((row) => kindOf(row) === 'malformed')
        if (malformed) {
          const at = persisted.findIndex((row) => row.id === malformed.id) + 1
          throw new DocumentEditError(
            422,
            `Line ${at}: this line carries unreadable billing provenance — ` +
              `reconcile it before editing; nothing was changed`,
          )
        }
        // An allocation explosion rebuilds the line set the identities were
        // read for, so no identity can be trusted past it while any native
        // evidence exists (source-bound or audit-only): refuse explicitly
        // rather than attaching by a stale position.
        const hasEvidence = persisted.some(
          (row) => kindOf(row) === 'source-bound' || kindOf(row) === 'audit-only',
        )
        if (hasEvidence) {
          if (entryPlan?.exploded) {
            const at = persisted.findIndex((row) => kindOf(row) !== null) + 1
            throw new DocumentEditError(
              422,
              `Line ${at}: an entry-allocation split cannot preserve this line's conversion provenance — ` +
                `clear the distribution key on the line to save; nothing was changed`,
            )
          }
          if (submittedLineKeys.length !== preparedLines.length) {
            throw new DocumentEditError(409, DOCUMENT_EDIT_REVISION_CONFLICT)
          }
        }
        // Only source-bound lines take the identity and source-bound guards:
        // capture evidence without a PO reference is audit metadata, kept by
        // identity in the reattachment below but otherwise editable like an
        // ordinary line.
        const provenanceRows = persisted.filter((row) => kindOf(row) === 'source-bound')
        if (provenanceRows.length > 0) {
          const matched = new Set(submittedLineKeys.filter((key): key is string => key !== null))
          const removed = provenanceRows.filter((row) => !matched.has(row.id.toLowerCase()))
          // An explicitly emptied line set removes every provenance line;
          // a populated but identity-less save is a legacy client. Both
          // refuse; only the first names line removal.
          if (removed.length > 0 && (submittedLineKeys.length === 0 || matched.size > 0)) {
            // A removed provenance line keeps its billed-quantity cover on
            // the source order: the canonical release runs only on
            // whole-draft delete/void, and there is no per-line release
            // machinery — so removal is refused with that existing remedy
            // rather than silently detached.
            const sources = await conversionSourceLabel(tx, orgId, id)
            throw new DocumentEditError(
              422,
              `Line ${persisted.findIndex((row) => row.id === removed[0]!.id) + 1}: ` +
                `removing a line converted from ${sources} is not supported here — ` +
                `keep the source-backed line, or delete the entire draft to undo its source-order quantity changes; ` +
                `nothing was changed`,
            )
          }
          if (matched.size === 0) {
            // A legacy identity-less save over source-backed lines: position
            // cannot say which line is which once lines reorder, so refuse
            // with the reload remedy instead of guessing.
            const sources = await conversionSourceLabel(tx, orgId, id)
            throw new DocumentEditError(
              422,
              `This ${current.kind} carries conversion provenance on ${provenanceRows.length} ` +
                `line(s) from ${sources}: lines must be saved with their stable identities — ` +
                `reload (or reopen) the document and save again; nothing was changed`,
            )
          }
          for (let i = 0; i < preparedLines.length; i++) {
            const key = submittedLineKeys[i]!
            if (key === null) continue
            const stored = byId.get(key)!
            if (kindOf(stored) !== 'source-bound') continue
            const line = preparedLines[i]!
            // Source-bound semantics: the child must still bill what its
            // source line provided. Repricing (unit price, amount),
            // descriptions, tax, dimensions, and tenant custom stay editable;
            // item, quantity, unit, or warehouse changes would misinterpret
            // the source line, so the remedy is to keep the converted value.
            const mismatch =
              normLineRef(line.itemId) !== normLineRef(stored.itemId) ? 'item'
              : !sameLineQuantity(line.quantity, stored.quantity) ? 'quantity'
              : normLineRef(line.unit) !== normLineRef(stored.unit) ? 'unit'
              : normLineRef(line.stockLocationId) !== normLineRef(stored.stockLocationId) ? 'stock location'
              : null
            if (mismatch === 'quantity') {
              const sources = await conversionSourceLabel(tx, orgId, id)
              throw new DocumentEditError(
                422,
                `Line ${i + 1}: quantity cannot be changed on a line converted from ${sources} — ` +
                  `keep the converted quantity (${stored.quantity}); nothing was changed`,
              )
            }
            if (mismatch !== null) {
              const sources = await conversionSourceLabel(tx, orgId, id)
              const keep =
                mismatch === 'item'
                  ? 'keep the ordered item'
                  : mismatch === 'unit'
                    ? `keep the converted unit (${stored.unit ?? ''})`
                    : 'keep the received warehouse'
              throw new DocumentEditError(
                422,
                `Line ${i + 1}: ${mismatch} cannot be changed on a line converted from ${sources} — ` +
                  `${keep}; nothing was changed`,
              )
            }
          }
        }
        // Reattachment by identity for every matched evidence line, outside
        // the source-bound block: audit-only documents keep their metadata
        // too. Lengths already match whenever evidence exists (409 above).
        if (hasEvidence && submittedLineKeys.length === preparedLines.length) {
          for (let i = 0; i < preparedLines.length; i++) {
            const key = submittedLineKeys[i]!
            if (key === null) continue
            const evidence = evidenceOf(byId.get(key)!)
            if (evidence === null) continue
            preparedLines[i]!.custom = { ...preparedLines[i]!.custom, ...evidence }
          }
        }
      }

      // AFTER reattachment: an explicit selection on this save must win over
      // the stored one, or changing a return source would silently keep the
      // old movement while the drawer showed the new one.
      if (preparedLines && body.lines) {
        await applyInventoryReturnSelections(tx, orgId, id, locked.kind, body.lines, preparedLines)
      }

      try {
        const generated = await assertGeneratedBillingEdit(tx, orgId, id, { ...body, currency, ...(totals ?? {}) }, preparedLines)
        // Equivalent editor lines permit header edits, but the source rows own
        // their IDs, billable flags, lineage, and audit metadata. Never replace
        // those rows through the generic editor's smaller column set.
        if (generated) preparedLines = null
      } catch (error) {
        if (error instanceof BillingSourceIntegrityError) throw new DocumentEditError(422, error.message)
        throw error
      }

      // Conversion children keep the source order's currency and party: credit
      // control relieves order exposure only with same-currency, same-party
      // posted billing, so a relabelled child would silently reprice billed
      // totals across currencies or release another customer's commitment.
      // Refuse a currency or party change away from the source order's
      // values; deleting the draft and reconverting restores them.
      // Stored uuids compare case-insensitively: the driver returns them
      // lowercase, but the match must not depend on that.
      const wantedParty = body.partyId === undefined
        ? undefined
        : body.partyId === null
          ? null
          : body.partyId.toLowerCase()
      if (currency !== undefined || wantedParty !== undefined) {
        const child = (await tx.execute<{ currency: string; partyId: string | null; documentNumber: string }>(sql`
          select currency, party_id as "partyId", document_number as "documentNumber"
            from documents
           where id = ${id} and org_id = ${orgId}
        `)).rows[0]
        const storedParty = child == null || child.partyId == null ? child?.partyId ?? null : child.partyId.toLowerCase()
        const currencyChange = currency !== undefined && child != null && currency !== child.currency
        const partyChange = wantedParty !== undefined && child != null && wantedParty !== storedParty
        if (currencyChange || partyChange) {
          // Only order sources establish conversion provenance. Other 'bills'
          // edges (for example field-ticket billing) are out of scope.
          const sources = (await tx.execute<{ kind: string; documentNumber: string; currency: string; partyId: string | null; partyName: string | null }>(sql`
            select source.kind, source.document_number as "documentNumber", source.currency,
                   source.party_id as "partyId", party.display_name as "partyName"
              from document_links link
              join documents source
                on source.id = link.from_document_id
               and source.org_id = link.org_id
              left join parties party
                on party.id = source.party_id
               and party.org_id = link.org_id
             where link.org_id = ${orgId}
               and link.to_document_id = ${id}
               and link.link_type in ('bills', 'created_from')
               and source.kind in ('quote', 'sales_order', 'purchase_order')
             order by source.document_number
          `)).rows
          // Any conflicting source refuses: with several edges, picking one
          // to compare against would be arbitrary.
          if (currencyChange) {
            const conflict = sources.find((source) => source.currency !== currency)
            if (conflict) {
              throw new DocumentEditError(
                422,
                `currency cannot be changed from ${child!.currency} to ${currency} on ${child!.documentNumber}: ` +
                `it was converted from ${conflict.kind.replaceAll("_", " ")} ${conflict.documentNumber} (${conflict.currency}) and must keep the source order currency. ` +
                `Delete this draft and reconvert it from ${conflict.documentNumber} to restore the ${conflict.currency} billing.`,
              )
            }
          }
          if (partyChange) {
            const conflict = sources.find((source) =>
              (source.partyId == null ? null : source.partyId.toLowerCase()) !== wantedParty)
            if (conflict) {
              const sourceParty = conflict.partyName ?? 'the source order party'
              throw new DocumentEditError(
                422,
                `party cannot be changed on ${child!.documentNumber}: ` +
                `it was converted from ${conflict.kind.replaceAll("_", " ")} ${conflict.documentNumber} and must keep the source order party (${sourceParty}). ` +
                `Delete this draft and reconvert it from ${conflict.documentNumber} to restore the original billing.`,
              )
            }
          }
        }
      }

      const auditBefore = await captureTransactionAuditSnapshot(tx, id, ctx.orgId)
      oldLines = ((await tx.execute<{
        lineNumber: number
        accountId: string | null
        departmentId: string | null
        projectId: string | null
        amount: string
      }>(sql`
        select line_number as "lineNumber", account_id as "accountId", department_id as "departmentId",
               project_id as "projectId", amount
          from document_lines
         where document_id = ${id} and org_id = ${ctx.orgId}
         order by line_number
      `))).rows

      if (preparedLines) {
        // Billed-time/cost provenance the editor's column set cannot express
        // (F-t04-003): a billing-generated invoice's lines are referenced by
        // time_entries.invoiced_by_line_id and by source cost lines'
        // billed_by_line_id, so a blind delete dies on those FKs as a raw
        // 500 — and would strand the provenance even if it did not. Snapshot
        // the per-line identity; the replacement below carries it forward
        // positionally (the same convention the editor already addresses
        // lines by) and re-points the references onto the new rows.
        const provenance = (await tx.execute<{
          id: string
          timeEntryId: string | null
          employeeId: string | null
          timeTypeId: string | null
          equipmentUnitId: string | null
          rateVersionId: string | null
          billRate: string | null
          billAmount: string | null
        }>(sql`
          select id, time_entry_id as "timeEntryId", employee_id as "employeeId",
                 time_type_id as "timeTypeId", equipment_unit_id as "equipmentUnitId",
                 rate_version_id as "rateVersionId",
                 bill_rate::text as "billRate", bill_amount::text as "billAmount"
            from document_lines
           where document_id = ${id} and org_id = ${orgId}
           order by line_number
        `)).rows
        // Every FK around document lines is deferrable: hold inbound
        // provenance checks until commit, when the re-point below has
        // restored them onto the replacement rows. Any other inbound
        // reference still fails the commit — fail closed, never dangling.
        await tx.execute(sql`set constraints all deferred`)
        await tx.execute(sql`delete from document_lines where document_id = ${id} and org_id = ${orgId}`)
        const insertedLineIds: string[] = []
        for (let i = 0; i < preparedLines.length; i++) {
          const l = preparedLines[i]!
          const carry = i < provenance.length ? provenance[i]! : undefined
          // A carried billable-value snapshot follows the edit: the snapshot
          // columns mirror the commercial price (as generation writes them),
          // so leaving a stale zero behind would corrupt the earned views
          // that prefer bill_amount over amount. Lines that never carried a
          // snapshot keep null rather than inventing one.
          const billRate = carry?.billRate != null ? (l.unitPrice ?? l.amount) : null
          const billAmount = carry?.billAmount != null ? l.amount : null
          const inserted = (await tx.execute<{ id: string }>(sql`
            insert into document_lines (org_id, document_id, line_number, account_id, item_id, description,
                                        quantity, unit, unit_price, amount, tax_code_id, tax_group_id, tax_input_amount,
                                        tax_amount, tax_overridden,
                                        party_id, department_id, project_id, location_id, class_id,
                                        stock_location_id, extra_dims, custom,
                                        distribution_group_id, distribution_rule_id, distribution_version_id,
                                        distribution_locked,
                                        time_entry_id, employee_id, time_type_id,
                                        equipment_unit_id, rate_version_id, bill_rate, bill_amount)
            values (${orgId}, ${id}, ${i + 1}, ${l.accountId}, ${l.itemId}, ${l.description},
                    ${l.quantity ?? '1'}, ${l.unit}, ${l.unitPrice ?? l.amount}, ${l.amount},
                    ${l.taxCodeId}, ${l.taxGroupId}, ${l.taxInputAmount}, ${l.taxAmount}, ${l.taxOverridden},
                    ${l.partyId}, ${l.departmentId}, ${l.projectId}, ${l.locationId}, ${l.classId},
                    ${l.stockLocationId}, ${JSON.stringify(l.extraDims)}::jsonb, ${JSON.stringify(l.custom)},
                    ${l.distributionGroupId}, ${l.distributionRuleId}, ${l.distributionVersionId},
                    ${l.distributionLocked},
                    ${carry?.timeEntryId ?? null}, ${carry?.employeeId ?? null}, ${carry?.timeTypeId ?? null},
                    ${carry?.equipmentUnitId ?? null}, ${carry?.rateVersionId ?? null}, ${billRate}, ${billAmount})
            returning id
          `))
          insertedLineIds.push(inserted.rows[0]!.id)
          await persistLineTaxComponents(tx, {
            orgId,
            documentLineId: inserted.rows[0]!.id,
            components: l.taxComponents,
            actorId: userId,
          })
          if (l.providerQuote) {
            await persistTaxQuote(
              orgId,
              l.providerQuote.providerConfigId,
              { ...l.providerQuote.request, documentLineId: inserted.rows[0]!.id },
              l.providerQuote.result,
              userId,
              tx,
            )
            await tx.execute(sql`
              update tax_rate_provider_configs
                 set last_attempt_at = now(), last_success_at = now(), last_error = null
               where id = ${l.providerQuote.providerConfigId} and org_id = ${orgId}
            `)
          }
        }
        // Entry-mode lineage rows land in the same transaction as the child
        // lines they explain: mode 'entry' anchored on the document, with
        // the replaced source line (regenerations) and the new child target.
        if (entryPlan && entryPlan.lineage.length > 0) {
          for (const row of entryPlan.lineage) {
            const childId = insertedLineIds[row.targetLineIndex]
            if (!childId) {
              throw new Error(
                `entry allocation lineage pointed past the inserted lines (index ${row.targetLineIndex})`,
              )
            }
            if (!row.definitionHash) {
              throw new Error('entry allocation lineage is missing its definition hash')
            }
            await tx.execute(sql`
              insert into allocation_lineage
                (org_id, mode, rule_id, version_id, definition_hash, document_id,
                 source_document_line_id, target_document_line_id, driver_id,
                 driver_value, driver_total, share, amount, residual)
              values (${orgId}, 'entry', ${row.ruleId}, ${row.versionId}, ${row.definitionHash}, ${id},
                      ${row.sourceDocumentLineId ?? null}, ${childId}, ${row.driverId ?? null},
                      ${row.driverValue ?? null}, ${row.driverTotal ?? null}, ${row.share ?? null},
                      ${row.amount}, ${row.residual})
            `)
          }
        }
        // Re-home the billed references the snapshot carried (F-t04-003): the
        // new rows replaced the old ids, so time entries and source cost
        // lines that pointed at the old rows must follow positionally.
        // References off lines the edit removed are released — the work
        // becomes billable again — instead of dangling at deleted rows.
        // Ordinary edits reference nothing and skip both moves entirely, so
        // the paired replay authority below is never raised for them.
        const moves = provenance.map((oldLine, index) => ({
          oldId: oldLine.id,
          newId: index < insertedLineIds.length ? insertedLineIds[index]! : null,
        }))
        if (moves.length > 0) {
          const oldIds = `{${moves.map((move) => move.oldId).join(',')}}`
          const hasTimeRefs = (await tx.execute(sql`select 1 from time_entries
            where org_id = ${orgId} and invoiced_by_line_id = any(${oldIds}::uuid[]) limit 1`)).rows.length > 0
          const hasCostRefs = (await tx.execute(sql`select 1 from document_lines
            where org_id = ${orgId} and billed_by_line_id = any(${oldIds}::uuid[]) limit 1`)).rows.length > 0
          if (hasTimeRefs) {
            for (const move of moves) {
              if (move.newId) {
                await tx.execute(sql`update time_entries set invoiced_by_line_id = ${move.newId}
                  where org_id = ${orgId} and invoiced_by_line_id = ${move.oldId}`)
              } else {
                await tx.execute(sql`update time_entries set invoiced_by_line_id = null, billing_status = 'unbilled'
                  where org_id = ${orgId} and invoiced_by_line_id = ${move.oldId}`)
              }
            }
          }
          if (hasCostRefs) {
            // Source cost lines live on (often non-draft) source documents,
            // so their billed_by links move under the same paired replay
            // authority the generator uses to stamp them — provenance
            // metadata, never a financial edit — cleared before continuing.
            await tx.execute(sql`set local openbooks.migration = on`)
            await tx.execute(sql`set local openbooks.amend = on`)
            try {
              for (const move of moves) {
                if (move.newId) {
                  await tx.execute(sql`update document_lines set billed_by_line_id = ${move.newId}
                    where org_id = ${orgId} and billed_by_line_id = ${move.oldId}`)
                } else {
                  await tx.execute(sql`update document_lines set billed_by_line_id = null
                    where org_id = ${orgId} and billed_by_line_id = ${move.oldId}`)
                }
              }
            } finally {
              await tx.execute(sql`set local openbooks.migration = off`)
              await tx.execute(sql`set local openbooks.amend = off`)
            }
          }
        }
      }

      await tx.execute(sql`
        update documents set
          party_id = ${body.partyId !== undefined ? body.partyId : sql`party_id`},
          payment_card_id = ${body.paymentCardId !== undefined ? body.paymentCardId : sql`payment_card_id`},
          document_date = coalesce(${body.documentDate ?? null}, document_date),
          due_date = ${body.dueDate !== undefined ? body.dueDate : sql`due_date`},
          reference_number = ${body.referenceNumber !== undefined ? body.referenceNumber : sql`reference_number`},
          memo = ${body.memo !== undefined ? body.memo : sql`memo`},
          posting_date = ${body.postingDate !== undefined ? body.postingDate : sql`posting_date`},
          department_id = ${body.departmentId !== undefined ? body.departmentId : sql`department_id`},
          project_id = ${body.projectId !== undefined ? body.projectId : sql`project_id`},
          location_id = ${body.locationId !== undefined ? body.locationId : sql`location_id`},
          class_id = ${body.classId !== undefined ? body.classId : sql`class_id`},
          extra_dims = ${headerDims ? JSON.stringify(headerDims.cleaned) : sql`extra_dims`}::jsonb,
          subsidiary_id = ${body.subsidiaryId !== undefined ? body.subsidiaryId : sql`subsidiary_id`},
          expected_pay_date = ${body.expectedPayDate !== undefined ? body.expectedPayDate : sql`expected_pay_date`},
          payment_hold_reason = ${body.paymentHoldReason !== undefined ? body.paymentHoldReason : sql`payment_hold_reason`},
          internal_notes = ${body.internalNotes !== undefined ? body.internalNotes : sql`internal_notes`},
          billing_method = ${body.billingMethod !== undefined ? body.billingMethod : sql`billing_method`},
          is_final_invoice = ${body.isFinalInvoice !== undefined ? body.isFinalInvoice : sql`is_final_invoice`},
          currency = ${currency !== undefined ? currency : sql`currency`},
          custom = coalesce(${headerCustom ? JSON.stringify(headerCustom) : null}::jsonb, custom),
          subtotal = coalesce(${totals?.subtotal ?? null}, subtotal),
          tax_total = coalesce(${totals?.taxTotal ?? null}, tax_total),
          total = coalesce(${totals?.total ?? null}, total),
          updated_at = greatest(
            clock_timestamp(),
            updated_at + interval '1 microsecond'
          ),
          updated_by = ${userId}
        where id = ${id} and org_id = ${orgId}
      `)

      const effectivePartyId = body.partyId !== undefined ? body.partyId : current.partyId
      if (effectivePartyId && ['customer_invoice', 'customer_credit', 'customer_payment'].includes(current.kind)) {
        await promoteCrmAccount(tx, {
          orgId,
          partyId: effectivePartyId,
          actorId: userId,
          toStage: 'customer',
          sourceKind: current.kind,
          sourceId: id,
        })
      }

      if (auditBefore) {
        const auditAfter = await captureTransactionAuditSnapshot(tx, id, ctx.orgId)
        if (!auditAfter) throw new Error(`document ${id} disappeared during amendment`)
        await recordTransactionAudit(tx, {
          orgId,
          documentId: id,
          action: 'update',
          actorId: userId,
          source: ctx.source,
          reason: body.amendmentReason?.trim(),
          before: auditBefore,
          after: auditAfter,
        })
      }
    },
  })

  // on_update flows fire AFTER the edit commits (unless the caller opts out).
  // The edit-shape data rides on the EVENT (previousTotal / totalChanged /
  // changedFields / changedLineFields). runRecordFlows never throws into the
  // caller and cannot veto the saved edit; it is awaited so it runs inside the
  // caller's RLS org scope.
  if (ctx.runFlows === false) return undefined
  const newTotal = totals?.total ?? current.total
  const newTaxTotal = totals?.taxTotal ?? current.taxTotal
  const changedFields: string[] = []
  if (cmp(newTotal, current.total) !== 0) changedFields.push('total')
  if (cmp(newTaxTotal, current.taxTotal) !== 0) changedFields.push('taxTotal')
  if (body.partyId !== undefined && body.partyId !== current.partyId) changedFields.push('partyId')
  const changedLineFields = new Set<string>()
  if (preparedLines) {
    const maxLen = Math.max(oldLines.length, preparedLines.length)
    for (let i = 0; i < maxLen; i++) {
      const o = oldLines[i]
      const n = preparedLines[i]
      if (!o || !n) {
        changedLineFields.add('accountId').add('departmentId').add('projectId').add('amount')
        break
      }
      if (o.accountId !== n.accountId) changedLineFields.add('accountId')
      if ((o.departmentId ?? null) !== (n.departmentId ?? null)) changedLineFields.add('departmentId')
      if ((o.projectId ?? null) !== (n.projectId ?? null)) changedLineFields.add('projectId')
      if (cmp(o.amount, n.amount) !== 0) changedLineFields.add('amount')
    }
  }
  const updateEvent: DocumentUpdateFlowEvent = {
    kind: 'on_update',
    source: ctx.source,
    previousTotal: current.total,
    totalChanged: cmp(newTotal, current.total) !== 0,
    changedFields,
    changedLineFields: [...changedLineFields],
    old: { total: current.total, taxTotal: current.taxTotal },
  }
  // A caller-owned transaction defers the event: firing now would run flows
  // against an uncommitted row over a separate connection. The caller fires
  // it after its own commit, preserving on_create → on_update order.
  if (ctx.deferFlows) return updateEvent
  await runRecordFlows(updateEvent, current.kind, id, { orgId, userId })
  return undefined
}

// ---------------------------------------------------------------------------
// Atomic document create (unsaved-create Save path)
// ---------------------------------------------------------------------------

/**
 * A reused idempotency key with a changed payload, or a key colliding with
 * another org's row. Fail closed: never return the older row as though it
 * matched. The route maps this to 409 invalid_idempotency_key.
 */
export class DocumentCreateConflict extends Error {
  constructor(message = 'invalid_idempotency_key') {
    super(message)
    this.name = 'DocumentCreateConflict'
  }
}

export interface DocumentCreateInput {
  orgId: string
  userId: string
  kind: string
  /** Caller UUID idempotency key; becomes the document id. */
  key: string
  /** The drawer's save payload (without expectedUpdatedAt — no revision exists yet). */
  body: DocumentEditInput
  /** Resolved subsidiary (root default or caller choice, scope-checked by the route). */
  subsidiaryId: string | null
  /** Full parsed request body for the idempotency image. */
  requestBody: unknown
}

export interface DocumentCreateResult {
  status: 'created' | 'replayed'
  id: string
  documentNumber: string
  /**
   * The on_update flow event the edit prepared. The caller fires it AFTER
   * this transaction commits, after the on_create flows — firing inside
   * would run flows against an uncommitted row over a separate connection.
   * Null on replay (nothing was written).
   */
  deferredUpdate: DocumentUpdateFlowEvent | null
}

/**
 * Create one draft document with its full validated header/lines write in a
 * SINGLE transaction: the replay check, the number allocation, the claim,
 * the insert audit event, and the shared writer's validation + writes all
 * commit or roll back together. An invalid Save leaves zero document, zero
 * audit insert, zero flow side effects (flows fire only after this commits),
 * and no idempotency claim — a retry with the same key proceeds as a fresh
 * create. Validation is the shared applyDocumentEdit core, never a copy.
 *
 * Provider-dependent totals precompute before the transaction (see above),
 * so no external resolution ever runs under the advisory/row locks. Audit
 * for a first create is exactly two events: the insert (request image) plus
 * the writer's update (initialization → final snapshots); a replay writes
 * nothing further.
 *
 * Same-key concurrency serializes on a key-scoped advisory lock, so a
 * retried request observes the winner's commit and replays instead of
 * racing it to a false conflict. `on conflict (id) do nothing` is the claim
 * itself: a colliding insert with no same-org row is another org's key and
 * 409s fail-closed.
 */
export async function createDocument(input: DocumentCreateInput): Promise<DocumentCreateResult> {
  const { orgId, userId, kind, key, body, subsidiaryId, requestBody } = input
  const cfg = docKindConfig(kind)
  if (!cfg) throw new DocumentEditError(422, `kind "${kind}" is not editable`)
  if (!isDocumentCreateKind(kind)) throw new DocumentEditError(422, `kind "${kind}" is not creatable here`)
  // Request-controlled idempotency image: kind + full body as parsed.
  // Derived values (number, currency default, totals) and lifecycle state
  // are EXCLUDED — they depend on allocator state or legitimately advance
  // after creation, so comparing them would turn a genuine retry into a
  // conflict.
  const match = { kind, body: requestBody }

  // Provider-dependent totals resolve BEFORE any lock or write: external tax
  // resolution must never run while the create holds advisory/row locks, and
  // a provider refusal must land with zero writes. Effective header inputs
  // are fixed once here so the precompute and the atomic write below observe
  // identical values (midnight-safe documentDate, resolved currency) — the
  // precomputed image exactly corresponds to this request. Applied line
  // transforms before totals are non-financial (provenance strip,
  // single-warehouse default); an allocation explosion recomputes instead of
  // reusing this image (see the `!entryPlan?.exploded` guard in the writer).
  //
  // The resolved currency seeds the row and the precompute ONLY. It is never
  // written back into the edit body: the writer treats any defined currency
  // as a user currency change and refuses it when multi-currency is off, so
  // an omitted currency must stay omitted (the row default it keeps is this
  // same resolved value).
  const today = await businessToday(orgId)
  const seedCurrency = await resolveCreateCurrency(orgId, body.currency)
  const effectiveBody: DocumentEditInput = {
    ...body,
    documentDate: body.documentDate ?? today,
  }
  const precomputedTotals = effectiveBody.lines
    ? await precomputeDocumentTotalsForCreate(orgId, kind, {
        lines: effectiveBody.lines,
        currency: seedCurrency,
        documentDate: effectiveBody.documentDate,
        partyId: effectiveBody.partyId,
        subsidiaryId: effectiveBody.subsidiaryId,
        custom: effectiveBody.custom,
      })
    : null

  return db.transaction(async (tx) => {
    // Same-key creates serialize here: the loser waits for the winner's
    // commit, then observes the row and replays (or 409s on a genuinely
    // changed payload) instead of racing to a false conflict. Distinct keys
    // never block each other.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
    // Replay BEFORE allocation: an exact retry must resolve without burning
    // a sequence number, and a changed payload must 409 before any write.
    // Only a key with no same-org row — and no insert image — proceeds.
    const existing = await tx.execute<{ id: string; documentNumber: string }>(sql`
      select id, document_number as "documentNumber" from documents where id = ${key} and org_id = ${orgId}`)
    if (existing.rows[0]) return resolveCreateReplay(tx, orgId, key, existing.rows[0], match)
    const documentNumber = await allocateDocumentNumber(tx, orgId, kind, cfg.numberPrefix)
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into documents
        (id, org_id, kind, subsidiary_id, document_number, document_date,
         currency, subtotal, tax_total, total, created_by)
      values (${key}, ${orgId}, ${kind}, ${subsidiaryId}, ${documentNumber},
              ${effectiveBody.documentDate}, ${seedCurrency}, '0', '0', '0', ${userId})
      on conflict (id) do nothing
      returning id`)
    // A same-key same-org row would have been found above under our advisory
    // lock, so a conflict here is another org's key: fail closed without
    // disclosing it.
    if (!inserted.rows[0]) throw new DocumentCreateConflict()
    // Audit contract for a first create is TWO events, stated exactly: this
    // insert carries the request image (what was asked), and the writer's
    // update below carries before/after snapshots (initialization → final
    // saved state). A replay writes nothing further.
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (
        ${orgId}, 'documents', ${key}, 'insert',
        ${JSON.stringify({ before: null, after: { ...match, id: key, org_id: orgId, document_number: documentNumber, status: 'draft' } })}::jsonb,
        ${userId}, ${key}
      )
    `)
    // The claim row is uncommitted, so its edit snapshot must ride this tx —
    // the shared loader would not see it. Mirrors loadDocumentEditCurrent.
    const current = (await tx.execute<DocumentEditCurrent>(sql`
      select kind, status, total, tax_total as "taxTotal", party_id as "partyId",
             document_date as "documentDate",
             custom, subsidiary_id as "subsidiaryId",
             ${documentRevisionCounterSql(sql.raw('revision_seq'))} as "updatedAt"
        from documents
       where id = ${key} and org_id = ${orgId}
    `)).rows[0] ?? null
    if (!current) throw new Error(`document ${key} disappeared during initialization`)
    const deferredUpdate = await applyDocumentEdit(
      key,
      current,
      { ...effectiveBody, expectedUpdatedAt: current.updatedAt },
      { orgId, userId, source: 'ui', deferFlows: true, precomputedTotals },
      { tx },
    )
    return { status: 'created', id: key, documentNumber, deferredUpdate: deferredUpdate ?? null } as DocumentCreateResult
  })
}

/**
 * The same-org row already exists under this key: an exact retry replays it,
 * anything else 409s. Runs before any allocation, so a replay burns no
 * sequence number and writes nothing.
 */
async function resolveCreateReplay(
  tx: DocumentTransaction,
  orgId: string,
  key: string,
  prior: { id: string; documentNumber: string },
  match: { kind: string; body: unknown },
): Promise<DocumentCreateResult> {
  const original = (
    await tx.execute<{ after: unknown }>(sql`
      select changes->'after' as after
        from audit_log
       where org_id = ${orgId}
         and table_name = 'documents'
         and row_id = ${key}
         and action = 'insert'
         and request_id = ${key}
       order by at asc
       limit 1
    `)
  ).rows[0]?.after
  // No insert image (a legacy draft row that happens to carry this id, or a
  // rolled-back attempt's ghost): the key is consumed by something this
  // request did not create — fail closed rather than adopt it.
  if (!original || typeof original !== 'object' || original === null) throw new DocumentCreateConflict()
  const keys = Object.keys(match)
  const projected: Record<string, unknown> = {}
  for (const k of keys) projected[k] = (original as Record<string, unknown>)[k]
  if (canonicalJson(projected) !== canonicalJson(match)) throw new DocumentCreateConflict()
  return { status: 'replayed', id: key, documentNumber: prior.documentNumber, deferredUpdate: null }
}

/**
 * Pre-transaction currency resolution for the create row and the totals
 * precompute. Shape-invalid and unknown codes refuse here with zero writes;
 * the multi-currency feature gate stays in the shared writer.
 */
async function resolveCreateCurrency(orgId: string, currency: unknown): Promise<string> {
  if (currency !== undefined) {
    const code = String(currency).trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(code)) throw new DocumentEditError(422, 'invalid currency')
    const found = await db.execute(sql`select 1 from currencies where code = ${code}`)
    if (!found.rows[0]) throw new DocumentEditError(422, 'invalid currency')
    return code
  }
  const base = (await db.execute<{ base_currency: string }>(sql`
    select base_currency from orgs where id = ${orgId}`)).rows[0]?.base_currency
  return base ?? 'CAD'
}

// ---------------------------------------------------------------------------
// Picker option loaders (shared by every list page's drawer hydration)
// ---------------------------------------------------------------------------

export type Opt = {
  id: string
  display_name?: string
  number?: string
  name?: string
  code?: string
  rate?: string
  label?: string
  last_four?: string | null
  network?: string | null
  liability_account_id?: string | null
  /** Settlement currency the account accepts (null = any). Drawers read it
   * for form-level currency validation (F-t06-002). */
  currency_restriction?: string | null
  /** Party pickers carry the party's primary subsidiary (drafts default to it). */
  subsidiary_id?: string | null
  tax_components?: import('@openbooks/engine/src/tax/tax.ts').TaxComponentConfig[]
};

export async function partyOptions(role: 'vendor' | 'customer', orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const filter =
    role === 'vendor'
      ? sql`exists (select 1 from vendor_roles vr
                     where vr.org_id = p.org_id
                       and vr.party_id = p.id
                       and vr.is_active)`
      : sql`exists (select 1 from customer_roles cr
                     where cr.org_id = p.org_id
                       and cr.party_id = p.id
                       and cr.is_active)`
  const r = (await db.execute<Opt>(sql`
    select p.id, p.display_name, p.subsidiary_id from parties p
     where p.org_id = ${resolvedOrgId} and ${filter} and p.is_active
     order by p.display_name limit 2000
  `))
  return r.rows
}

export async function accountOptions(cfg: DocKindConfig, orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const typeFilter = cfg.accountTypes
    ? sql` and a.type in (${sql.join(cfg.accountTypes.map((ty) => sql`${ty}`), sql`, `)})`
    : sql``
  const r = (await db.execute<Opt>(sql`
    select id, number, name, currency_restriction from accounts a
     where a.org_id = ${resolvedOrgId} and a.is_active and not a.is_summary ${typeFilter}
     order by a.number nulls last
  `))
  return r.rows
}

export async function taxCodeOptions(orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const profiles = await taxProfileMap(resolvedOrgId)
  const r = (await db.execute<Opt>(sql`
    select tc.id, tc.code, tc.name, coalesce(tr.rate_percent, 0) as rate
      from tax_codes tc
      left join lateral (
        select rate_percent from tax_rates
         where org_id = ${resolvedOrgId} and tax_code_id = tc.id and effective_from <= now()
         order by effective_from desc limit 1) tr on true
     where tc.org_id = ${resolvedOrgId} and tc.is_active order by tc.code
  `))
  return r.rows.map((row) => ({ ...row, tax_components: profiles.codes.get(row.id) ?? [] }))
}

export async function taxGroupOptions(orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const profiles = await taxProfileMap(resolvedOrgId)
  const result = (await db.execute<Opt>(sql`
    select id, code, name from tax_groups
     where org_id = ${resolvedOrgId} and is_active order by code
  `))
  return result.rows.map((row) => ({ ...row, tax_components: profiles.groups.get(row.id) ?? [] }))
}

export async function dimensionOptions(orgId?: string) {
  const resolvedOrgId = await resolveOrgId(orgId)
  const [departments, projects, locations, classes, registry] = await Promise.all([
    db.execute(sql`select id, name from departments where org_id = ${resolvedOrgId} and is_active order by name`),
    db.execute(sql`select id, name from projects where org_id = ${resolvedOrgId} and is_active order by name limit 2000`),
    db.execute(sql`select id, name from locations where org_id = ${resolvedOrgId} and is_active order by name`),
    db.execute(sql`select id, name from classes where org_id = ${resolvedOrgId} and is_active order by name`),
    segmentRegistry(resolvedOrgId),
  ])
  return {
    departments: departments.rows as Opt[],
    projects: projects.rows as Opt[],
    locations: locations.rows as Opt[],
    classes: classes.rows as Opt[],
    segments: registry.filter((segment) => segment.sourceKind === 'custom'),
    builtinSegments: registry.filter((segment) => segment.sourceKind === 'builtin'),
  }
}

/** Active catalog items (for the optional line `item` column). */
export async function itemOptions(orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const r = (await db.execute<Opt>(sql`
    select id, code, name from items where org_id = ${resolvedOrgId} and is_active order by coalesce(code, name), name limit 2000
  `))
  return r.rows
}

/** Active corporate cards (for card_charge / card_refund funding source). */
export async function cardOptions(orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const r = (await db.execute<{ id: string; label: string; last_four: string | null; network: string | null; liability_account_id: string | null; holder: string | null }>(sql`
    select pc.id, pc.label, pc.last_four, pc.network, pc.liability_account_id, p.display_name as holder
      from payment_cards pc
      left join parties p on p.id = pc.holder_party_id and p.org_id = pc.org_id
     where pc.org_id = ${resolvedOrgId} and pc.is_active
     order by pc.label
  `))
  return r.rows.map((c) => ({
    id: c.id,
    label: c.last_four ? `${c.label}` : c.label,
    display_name: c.last_four ? `${c.network ?? ''} •••• ${c.last_four} — ${c.holder ?? ''}`.trim() : c.label,
    last_four: c.last_four,
    network: c.network,
    liability_account_id: c.liability_account_id,
  }))
}

/** Reconcilable bank accounts (for check funding source + transfer legs). */
export async function bankAccountOptions(orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const r = (await db.execute<Opt>(sql`
    select id, number, name, currency_restriction from accounts
     where org_id = ${resolvedOrgId} and is_active and not is_summary and reconcilable and type = 'asset_bank'
     order by number nulls last
  `))
  return r.rows
}

/**
 * Reconcilable card-liability accounts (the card-charge fallback when no
 * card instruments exist — F-t05-020). Offered as the controlAccountId
 * override the engine cardRule reads first; fenced to this exact set by
 * the funding-override guard in applyDocumentEdit.
 */
export async function cardLiabilityAccountOptions(orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const r = (await db.execute<Opt>(sql`
    select id, number, name, currency_restriction from accounts
     where org_id = ${resolvedOrgId} and is_active and not is_summary and reconcilable and type = 'liability_card'
     order by number nulls last
  `))
  return r.rows
}
