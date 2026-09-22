'use client'

import { useMoney } from '@/components/money-provider'
import { initialDrawerMode, type DrawerMode } from '@/lib/drawer-mode'
import { isDocumentRevisionToken } from '@/lib/api/registry-data'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { documentDrawerHref } from '../lib/document-drawer-navigation'
import { displayDocumentNumber, displayFormName } from '../lib/document-display'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { useAppAction } from '@/lib/use-app-action'
import { Badge, Button, FieldLabel, Input, SearchSelect, Select } from '@openbooks/ui'
import { TransactionDrawer } from './transaction-drawer'
import { LineGrid, type LineGridColumn, type LineGridDistribution } from './line-grid'
import {
  chipForRow,
  groupHeaderModels,
  groupIdOf,
  groupMembers,
  isGroupLocked,
  menuKeysForRow,
  reapportionGroupTotal,
  unsplitGroup as collapseDistributionGroup,
  type EntryDistributionCandidate,
} from './allocations/distribution-groups'
import { DistributionDialog, type DistributionDialogChild } from './allocations/DistributionDialog'
import { CustomFieldInputs, customFieldColumns, type CustomFieldDefClient } from './custom-field-inputs'
import { CustomFieldInput } from './custom-field-input'
import { HeaderFields } from './transaction-form/header-fields'
import { DocTypeBadge, docTypeMeta } from './doc-type-badge'
import { JournalEntryLink } from './journal-entry-link'
import { PdfButton } from './pdf-button'
import { SendButton } from './send-button'
import { FlowManualButtons } from './flow-manual-buttons'
import { ApprovalActions } from './approval-actions'
import { ApprovalHistory } from './approval-history'
import { PDF_RECORD_TYPE_BY_KEY } from '../lib/pdf-templates/catalog'
import { add, cmp, fromUnits, normalizeMoney, roundDiv, sum } from '@openbooks/engine/src/money/money.ts'
import { computeLineTaxes, type TaxComponentConfig } from '@openbooks/engine/src/tax/tax.ts'
import { confirmDialog } from '../lib/confirm'
import { promptDialog } from '../lib/prompt'
import { runClientScripts } from '../lib/client-scripts'
import { displayLineDecimal } from '../lib/line-grid-decimal'
import type { DocKindConfig } from '../lib/document-kinds'
import {
  type FormLayoutConfig,
  type HeaderFieldPlacement,
  type LineColumnPlacement,
  customFieldDefKey,
  isCustomFieldKey,
  lineFieldMeta,
  FORM_ACTION_KEYS,
} from '@openbooks/customization'
type Opt = {
  id: string
  display_name?: string
  number?: string
  name?: string
  code?: string
  rate?: string
  label?: string
  subsidiary_id?: string | null
  tax_components?: TaxComponentConfig[]
  /** Settlement currency the account accepts (null = any; F-t06-002). */
  currency_restriction?: string | null
  /** True when the item carries an inventory costing profile (line pickers). */
  has_inventory_profile?: boolean | null
};

interface SubsidiaryOpt {
  id: string
  name: string
  /** Root = 0; used to indent the picker like a tree. */
  depth: number
}
interface SegmentOpt {
  key: string
  name: string
  showOnHeader: boolean
  showOnLines: boolean
  values: { id: string; code: string | null; name: string }[]
}
interface BuiltinSegmentOpt {
  key: string
  storageColumn: string | null
  showOnHeader: boolean
  showOnLines: boolean
}

// Stable identities for the omitted-`segments`/`builtinSegments` defaults. A
// `= []` default would hand the `payload_` memo below a fresh array on every
// render, and the render-time dirty tracker keys on that memo's identity —
// an ever-churning identity re-renders forever.
const EMPTY_SEGMENTS: SegmentOpt[] = []
const EMPTY_BUILTIN_SEGMENTS: BuiltinSegmentOpt[] = []
/** One posted receipt or shipment a credit memo may still return against. */
interface ReturnableSourceOption {
  movementId: string
  movedAt: string
  documentNumber: string | null
  remaining: string
  lotId: string | null
  lotCode: string | null
  serialId: string | null
  serialCode: string | null
}

interface LineRow extends Record<string, unknown> {
  /** Loader line id this row edits (empty = new row); the save round-trips
   *  it and a redraw adopts replacement ids via toRow. */
  lineId: string
  /**
   * Client-only React identity for the line grid (never serialized — the
   * save payload picks explicit fields). Server ids are empty for new rows
   * and are replaced on every redraw, so neither can key the grid: without
   * this, a reorder/duplicate leaves two rows sharing one key and an
   * uncommitted cell draft commits onto the wrong line.
   */
  clientKey: string
  accountId: string
  itemId: string
  description: string
  quantity: string
  unit: string
  unitPrice: string
  costRate: string
  billRate: string
  billAmount: string
  isBillable: boolean
  departmentId: string
  projectId: string
  locationId: string
  classId: string
  /** Warehouse for inventory receipt/issue effects; blank unless the line's
   *  item is stocked (F-t07-003 pickers). */
  stockLocationId: string
  /** On a credit memo, the posted receipt or shipment this line returns.
   *  Blank = a purely financial credit line that moves no stock. The chosen
   *  movement carries its own lot/serial, so the row stores only its id. */
  returnSourceMovementId: string
  taxProfileId: string
  amount: string
  taxInputAmount: string
  taxOverridden: boolean
  taxAmount: string
  /** Entry-mode distribution staging (shard A9; exploded by A4 on save). */
  distributionGroupId: string
  distributionRuleId: string
  distributionRuleName: string
  distributionVersionId: string
  distributionLocked: boolean
  /** Rule key staged for explosion; blank once the server materializes children. */
  distributionKey: string
}

/** The distribution slice of a grid row: server line → row, row → collapse. */
export interface DistributionLineFields {
  distributionGroupId: string
  distributionRuleId: string
  distributionRuleName: string
  distributionVersionId: string
  distributionLocked: boolean
  distributionKey: string
}

/**
 * Distribution columns off a document-line read. Tolerant by design: the
 * read path gains these columns from A4, so a line without them (older
 * payloads, other writers) is simply ungrouped — never an error.
 */
export function distributionFieldsOf(line: Record<string, unknown>): DistributionLineFields {
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  return {
    distributionGroupId: text(line.distribution_group_id),
    distributionRuleId: text(line.distribution_rule_id),
    distributionRuleName: text(line.distribution_rule_name),
    distributionVersionId: text(line.distribution_version_id),
    distributionLocked: line.distribution_locked === true,
    distributionKey: '',
  }
}

export function clearedDistributionFields(): DistributionLineFields {
  return {
    distributionGroupId: '',
    distributionRuleId: '',
    distributionRuleName: '',
    distributionVersionId: '',
    distributionLocked: false,
    distributionKey: '',
  }
}
export interface DocPayload {
  doc: Record<string, unknown>
  lines: Record<string, unknown>[]
}

/** The document header: `documents` plus the loader's joins. Dates, uuids
 *  and numerics arrive from the driver as strings; nullable columns,
 *  left-join columns and kind-specific extras stay nullable. Column
 *  nullability per schema (`balance_due` is loader-computed, so it also
 *  accepts numbers). */
export interface DocumentDoc extends Record<string, unknown> {
  id: string
  status: string
  currency: string
  kind: string
  payment_card_id: string | null
  reference_number: string | null
  party_name: string | null
  memo: string | null
  due_date: string | null
  document_date: string | null
  billing_method: string | null
  updated_at: string
  project_id: string | null
  posting_date: string | null
  payment_hold_reason: string | null
  location_id: string | null
  is_final_invoice: boolean
  internal_notes: string | null
  expected_pay_date: string | null
  entry_id: string | null
  department_id: string | null
  class_id: string | null
  balance_due: string | number | null
  total: string
  tax_total: string
  subtotal: string
  subsidiary_id: string | null
  party_id: string | null
  extra_dims: Record<string, string>
  document_number: string | null
  custom: Record<string, unknown>
}

/** Narrow a loader's untyped document row to the header fields this drawer
 *  reads. Loader rows always carry strings (or string maps for
 *  custom/extra_dims) here, so valid payloads pass through unchanged. */
export function asDocumentDoc(raw: Record<string, unknown>): DocumentDoc {
  const text = (value: unknown): string | null =>
    typeof value === 'string' ? value : null
  const dims = (value: unknown): Record<string, string> =>
    isLineMap(value)
      ? Object.fromEntries(
          Object.entries(value).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : {}
  const decimal = (value: unknown): string | number | null =>
    typeof value === 'string' || typeof value === 'number' ? value : null
  return {
    ...raw,
    id: text(raw.id) ?? '',
    status: text(raw.status) ?? '',
    currency: text(raw.currency) ?? '',
    kind: text(raw.kind) ?? '',
    payment_card_id: text(raw.payment_card_id),
    reference_number: text(raw.reference_number),
    party_name: text(raw.party_name),
    memo: text(raw.memo),
    due_date: text(raw.due_date),
    document_date: text(raw.document_date),
    billing_method: text(raw.billing_method),
    updated_at: text(raw.updated_at) ?? '',
    project_id: text(raw.project_id),
    posting_date: text(raw.posting_date),
    payment_hold_reason: text(raw.payment_hold_reason),
    location_id: text(raw.location_id),
    is_final_invoice: raw.is_final_invoice === true,
    internal_notes: text(raw.internal_notes),
    expected_pay_date: text(raw.expected_pay_date),
    entry_id: text(raw.entry_id),
    department_id: text(raw.department_id),
    class_id: text(raw.class_id),
    balance_due: decimal(raw.balance_due),
    total: text(raw.total) ?? '0',
    tax_total: text(raw.tax_total) ?? '0',
    subtotal: text(raw.subtotal) ?? '0',
    subsidiary_id: text(raw.subsidiary_id),
    party_id: text(raw.party_id),
    extra_dims: dims(raw.extra_dims),
    document_number: text(raw.document_number),
    custom: isLineMap(raw.custom) ? raw.custom : {},
  }
}

/** Any request that carries one exact revision token as fence evidence.
 *  Documents name it expectedUpdatedAt; field tickets expectedRevision. */
export type RevisionFencedRequest = {
  path: string
  method: 'PATCH' | 'POST'
  body: Record<string, unknown>
}

export type DocumentSaveRequest<Method extends 'PATCH' | 'POST' = 'PATCH' | 'POST'> = {
  path: string
  method: Method
  body: Record<string, unknown> & { expectedUpdatedAt: string }
}

/** Client-side echo of the API's stale-write 409 contract (lib/documents). */
export const DOCUMENT_CHANGED_AFTER_OPEN =
  'this document changed after you opened it; reload and review the latest revision'

/** The revision is an opaque value loaded from persisted document state. */
export function persistedDocumentRevision(value: unknown): string {
  if (!isDocumentRevisionToken(value)) {
    throw new Error('DOCUMENT_REVISION_REQUIRED')
  }
  return value
}

/**
 * The single write an unsaved create makes: first Save POSTs the collection
 * once with a caller UUID idempotency key (stable per drawer session, so a
 * retried Save replays instead of duplicating). The body is the drawer's own
 * save payload plus the kind — the exact shape PATCH would receive — so the
 * server validates a create with the same rules and messages as an edit.
 * Pure, unit-tested alongside the kind hrefs.
 */
export function buildDocumentCreateRequest(
  kind: string,
  payload: Record<string, unknown>,
  key: string,
): { path: string; method: 'POST'; headers: Record<string, string>; body: Record<string, unknown> } {
  return {
    path: '/api/documents',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: { kind, ...payload },
  }
}

export function buildDocumentSaveRequest(
  documentId: string,
  persistedRevision: string,
  payload: Record<string, unknown>,
  isPosted: boolean,
  amendmentReason?: string,
  /** Draft families whose PATCH lives on their own equally fenced route
   *  (e.g. /api/expenses, /api/journals) instead of /api/documents. */
  route: { basePath?: string } = {},
): DocumentSaveRequest {
  const basePath = route.basePath ?? '/api/documents'
  const body = {
    ...payload,
    expectedUpdatedAt: persistedDocumentRevision(persistedRevision),
  }
  if (!isPosted) {
    return {
      path: `${basePath}/${documentId}`,
      method: 'PATCH',
      body,
    } satisfies DocumentSaveRequest<'PATCH'>
  }
  return {
    path: `${basePath}/${documentId}/correct`,
    method: 'POST',
    body: { ...body, amendmentReason },
  } satisfies DocumentSaveRequest<'POST'>
}

/**
 * The exact token a successful fenced save hands back to its caller, across
 * both wire shapes this app returns: `{ doc: { updated_at } }` document
 * payloads and the field-ticket payload whose revision rides at the top level.
 */
export function revisionFromSuccessfulDocumentSave(data: unknown): string {
  const saved = data as { doc?: { updated_at?: unknown }; revision?: unknown }
  return persistedDocumentRevision(saved?.doc?.updated_at ?? saved?.revision)
}

/** Identity + exact revision of a `{ doc }` draft payload (expenses,
 *  journals). RSC props carry a lossy Date `updated_at`, so only a canonical
 *  API read can mint a usable snapshot. */
export function draftDocumentIdentity(payload: unknown): { documentId: string; revision: string } {
  const doc = (payload as { doc?: Record<string, unknown> } | null)?.doc
  if (!doc || doc.id == null || doc.id === '') throw new Error('DOCUMENT_ID_REQUIRED')
  return { documentId: String(doc.id), revision: persistedDocumentRevision(doc.updated_at) }
}

/** Load a canonical draft payload and pin its exact persisted revision —
 *  fail closed when the read fails or returns a lossy token (never guess). */
export async function loadDraftDocumentSnapshot(
  path: string,
  fallbackMessage: string,
  transport: typeof fetch = fetch,
): Promise<PersistedDocumentSnapshot<DocPayload>> {
  let res: Response
  try {
    res = await transport(path)
  } catch {
    throw new Error(fallbackMessage)
  }
  if (!res.ok) throw new Error(fallbackMessage)
  const data = (await res.json()) as DocPayload
  const identity = draftDocumentIdentity(data)
  return { documentId: identity.documentId, revision: identity.revision, payload: data }
}

export type DocumentSaveOutcome<Data> =
  | { ok: true; data: Data; revision: string }
  | { ok: false; message: string; isConflict: boolean }

/** Uniform result of one interactive editor's fenced mutation: a success
 *  carries the refreshed exact token, conflicts carry the server's 409
 *  message so the caller can run its reload flow. */
export type FencedSaveResult<Saved> =
  | { status: 'saved'; saved: Saved; revision: string }
  | { status: 'conflict'; message: string }
  | { status: 'error'; message: string }

/** Execute one revision-fenced save request and classify its outcome: a
 *  success carries the refreshed exact token, a failure keeps the server's
 *  message and flags conflicts so callers can run their reload flow. */
export async function executeDocumentSave<Data extends object = DocPayload>(
  request: RevisionFencedRequest,
  fallbackMessage: string,
  transport: typeof fetch = fetch,
): Promise<DocumentSaveOutcome<Data>> {
  let res: Response
  try {
    res = await transport(request.path, {
      method: request.method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
    })
  } catch {
    return { ok: false, message: fallbackMessage, isConflict: false }
  }
  if (!res.ok) {
    return { ok: false, ...(await readDocumentSaveFailure(res, fallbackMessage)) }
  }
  const data = (await res.json()) as Data
  return { ok: true, data, revision: revisionFromSuccessfulDocumentSave(data) }
}

/**
 * What a canonical read means for an already-open editor. A clean editor
 * adopts the fresh snapshot wholesale. A dirty editor may keep its edits only
 * while nothing actually moved server-side — it then pins the newer exact
 * token under unchanged content. Content that drifted under active edits is a
 * conflict: blessing stale edits with the newer token would recreate the
 * silent last-write-wins this fence exists to prevent.
 *
 * Content comparison strips the revision itself (a Date in props can never
 * equal its exact wire token) and compares everything else byte-stably.
 */
export type CanonicalDraftAdoption =
  | { action: 'adopt'; snapshot: PersistedDocumentSnapshot<DocPayload> }
  | { action: 'pin'; revision: string }
  | { action: 'conflict'; snapshot: PersistedDocumentSnapshot<DocPayload> }

function draftContentFingerprint(snapshot: PersistedDocumentSnapshot<DocPayload>): string {
  const { updated_at: _revision, ...doc } = snapshot.payload.doc ?? {}
  void _revision
  return JSON.stringify({ doc, lines: snapshot.payload.lines })
}

export function reconcileCanonicalDraftRead(args: {
  current: PersistedDocumentSnapshot<DocPayload>
  incoming: PersistedDocumentSnapshot<DocPayload>
  isDirty: boolean
}): CanonicalDraftAdoption {
  if (args.current.documentId !== args.incoming.documentId) {
    return { action: 'conflict', snapshot: args.incoming }
  }
  if (!args.isDirty) return { action: 'adopt', snapshot: args.incoming }
  if (
    args.current.revision === args.incoming.revision ||
    draftContentFingerprint(args.current) === draftContentFingerprint(args.incoming)
  ) {
    return { action: 'pin', revision: args.incoming.revision }
  }
  return { action: 'conflict', snapshot: args.incoming }
}

export type PersistedDocumentSnapshot<Payload> = {
  documentId: string
  revision: string
  payload: Payload
}

export function reconcilePersistedDocumentSnapshot<Payload>(
  current: PersistedDocumentSnapshot<Payload>,
  incoming: PersistedDocumentSnapshot<Payload>,
  isDirty: boolean,
  seenPersistedRevisions: ReadonlySet<string>,
): { snapshot: PersistedDocumentSnapshot<Payload>; rehydrate: boolean } {
  const exactIncoming = {
    ...incoming,
    revision: persistedDocumentRevision(incoming.revision),
  }
  persistedDocumentRevision(current.revision)
  if (current.documentId !== exactIncoming.documentId) {
    return { snapshot: exactIncoming, rehydrate: true }
  }
  if (isDirty || seenPersistedRevisions.has(exactIncoming.revision)) {
    return { snapshot: current, rehydrate: false }
  }
  return { snapshot: exactIncoming, rehydrate: true }
}

export async function readDocumentSaveFailure(
  response: Pick<Response, 'status' | 'json'>,
  fallbackMessage: string,
): Promise<{ message: string; isConflict: boolean }> {
  const data = await response.json().catch(() => ({})) as { error?: unknown }
  return {
    message: typeof data.error === 'string' && data.error ? data.error : fallbackMessage,
    isConflict: response.status === 409,
  }
}

/**
 * Read a submit/post action response without ever throwing. Error bodies
 * may be proxy HTML pages rather than JSON — letting res.json() throw
 * turns the failure silent (unhandled rejection, zero toast) and wedges
 * the action button busy. A null message tells the caller to use the
 * localized fallback.
 */
export async function readDocumentActionResult(
  response: Pick<Response, 'ok' | 'json'>,
): Promise<{ ok: boolean; message: string | null; pendingApproval: boolean }> {
  const data = await response.json().catch(() => ({})) as { error?: unknown; pendingApproval?: unknown }
  return {
    ok: response.ok,
    message: typeof data.error === 'string' && data.error ? data.error : null,
    pendingApproval: data.pendingApproval === true,
  }
}

export interface CurrencyMismatchedAccount {
  accountId: string
  label: string
  allowed: string
}

/**
 * Form-level currency proof (F-t06-002): every referenced account carrying
 * a settlement-currency restriction must name the document's own currency —
 * the storage trigger would refuse anything else at post, so saving or
 * posting a mismatched form only buys a round trip to a certain refusal.
 * Returns the first offender in form order, or null when nothing provably
 * mismatches (unknown accounts stay the server's call — fail open).
 */
export function findCurrencyMismatchedAccount(
  docCurrency: unknown,
  refs: { accountId: unknown; label: string }[],
  restrictionById: Map<string, string | null | undefined>,
): CurrencyMismatchedAccount | null {
  if (typeof docCurrency !== 'string' || !docCurrency) return null
  for (const ref of refs) {
    if (typeof ref.accountId !== 'string' || !ref.accountId) continue
    const allowed = restrictionById.get(ref.accountId)
    if (allowed && allowed !== docCurrency) {
      return { accountId: ref.accountId, label: ref.label, allowed }
    }
  }
  return null
}

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'secondary' | 'warning' | 'outline'> = {
  open: 'default',
  paid: 'success',
  posted: 'success',
  approved: 'success',
  pending_approval: 'warning',
  draft: 'secondary',
  voided: 'outline',
}

const STATUS_KEYS: Record<string, string> = {
  draft: 'draft',
  pending_approval: 'pendingApproval',
  approved: 'approved',
  posted: 'posted',
  open: 'open',
  paid: 'paid',
  voided: 'voided',
}

/**
 * Drawer title row: type badge + document number + status pill. The status
 * is decision-relevant (open/paid/voided), so the pill must never be the
 * thing that clips on narrow viewports — it keeps its width and wraps to
 * its own line instead (F-t12-013).
 */
export function DocumentDrawerTitle({
  kind,
  documentNumber,
  statusLabel,
  statusVariant,
}: {
  kind: string
  documentNumber: string
  statusLabel: string
  statusVariant: 'default' | 'success' | 'secondary' | 'warning' | 'outline'
}) {
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <DocTypeBadge kind={kind} />
      <span className="font-mono">{documentNumber}</span>
      <Badge variant={statusVariant} className="shrink-0">
        {statusLabel}
      </Badge>
    </span>
  )
}

const emptyLine = (): LineRow => ({
  lineId: '',
  clientKey: crypto.randomUUID(),
  accountId: '',
  itemId: '',
  description: '',
  quantity: '',
  unit: '',
  unitPrice: '',
  costRate: '',
  billRate: '',
  billAmount: '',
  isBillable: false,
  departmentId: '',
  projectId: '',
  locationId: '',
  classId: '',
  stockLocationId: '',
  returnSourceMovementId: '',
  taxProfileId: '',
  amount: '',
  taxInputAmount: '',
  taxOverridden: false,
  taxAmount: '',
  ...clearedDistributionFields(),
})

function positiveAmount(value: unknown): boolean {
  try { return cmp(String(value ?? ''), '0') > 0 } catch { return false }
}

/**
 * Rows that carry a booking, shared by the footer and the save payload so the
 * reviewed total is always the booked total. An account plus any entered
 * amount rides: the server passes signed and zero lines to computeBillTotals
 * untouched (see validateEditableDocumentLines), rejecting only a missing
 * account or a malformed amount with a line-named error. Dropping a signed
 * row here used to book something other than the reviewed footer — silent
 * data loss on a financial document. Only blank placeholder rows are dropped.
 */
export function isPricedDrawerLine(row: { accountId: string; amount: string }): boolean {
  return Boolean(row.accountId) && String(row.amount ?? '').trim() !== ''
}

const LINE_DECIMAL_RE = /^[-+]?(\d+(\.\d*)?|\.\d+)$/
const MAX_LINE_DECIMAL_SCALE = 10

function parseLineDecimal(value: string): { units: bigint; scale: number } | null {
  const raw = String(value ?? '').trim()
  if (!LINE_DECIMAL_RE.test(raw)) return null
  const unsigned = raw.replace(/^[-+]/, '')
  const [whole = '0', fraction = ''] = unsigned.split('.')
  if (fraction.length > MAX_LINE_DECIMAL_SCALE) return null
  const units = BigInt(`${whole === '' ? '0' : whole}${fraction}`)
  return { units: raw.startsWith('-') ? -units : units, scale: fraction.length }
}

/**
 * Quantity × Unit price as a canonical ledger amount (F-t02-004: the invoice
 * line editor silently ignored qty/price, so totals followed only the
 * hand-typed Amount). Exact bigint math, halves away from zero, no Number
 * hop. Returns null when either side is blank or unparseable — a manual
 * discount line or a hand-typed amount must never be guessed over.
 */
export function lineAmountFromQtyPrice(quantity: string, unitPrice: string): string | null {
  const q = parseLineDecimal(quantity)
  const p = parseLineDecimal(unitPrice)
  if (!q || !p) return null
  const product = q.units * p.units
  const scale = q.scale + p.scale
  if (scale <= 4) return fromUnits(product * 10n ** BigInt(4 - scale))
  return fromUnits(roundDiv(product, 10n ** BigInt(scale - 4)))
}

type QtyPriceRow = { quantity: string; unitPrice: string; amount: string }

/**
 * Grid change handler companion: a row whose quantity or unit price just
 * changed re-derives its amount when the stored amount is blank or still the
 * product of the previous qty/price (i.e. it was derived, not hand-typed).
 * A divergent hand-typed amount — discount, reapportioned split,
 * tax-adjusted figure — is never overwritten.
 */
export function applyQtyPriceToRows<Row extends QtyPriceRow>(prev: Row[], next: Row[]): Row[] {
  // Rows carry a client identity (document-drawer LineRow.clientKey) that
  // survives reorder: match the previous row by identity so a moved line is
  // compared against itself, not against whichever line used to sit at its
  // position. Rows without an identity (and the unit tests) fall back to
  // position, preserving the previous behaviour exactly.
  const prevByKey = new Map<string, Row>()
  for (const row of prev) {
    const key = (row as { clientKey?: unknown }).clientKey
    if (typeof key === 'string' && key !== '') prevByKey.set(key, row)
  }
  return next.map((row, i) => {
    const key = (row as { clientKey?: unknown }).clientKey
    const old = (typeof key === 'string' && key !== '' ? prevByKey.get(key) : undefined) ?? prev[i]
    if (!old || (old.quantity === row.quantity && old.unitPrice === row.unitPrice)) return row
    const derived = lineAmountFromQtyPrice(row.quantity, row.unitPrice)
    if (derived === null || row.amount === derived) return row
    if (row.amount.trim() !== '') {
      const wasDerived = lineAmountFromQtyPrice(old.quantity, old.unitPrice)
      if (row.amount !== wasDerived) return row
    }
    return { ...row, amount: derived }
  })
}

/** Line text columns are uuids/text-or-null; numerics are handled with String(). */
function lineText(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function isLineMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function toRow(l: Record<string, unknown>, lineDefs: CustomFieldDefClient[], segments: SegmentOpt[]): LineRow {
  const row: LineRow = {
    lineId: lineText(l.id),
    // Fresh client identity on every load: the grid's React key must be
    // unique among the live rows, and a redraw replaces every row object.
    clientKey: crypto.randomUUID(),
    accountId: lineText(l.account_id),
    itemId: lineText(l.item_id),
    description: lineText(l.description),
    quantity: l.quantity != null ? String(l.quantity) : '',
    unit: lineText(l.unit),
    unitPrice: l.unit_price != null ? String(l.unit_price) : '',
    costRate: l.cost_rate != null ? String(l.cost_rate) : '',
    billRate: l.bill_rate != null ? String(l.bill_rate) : '',
    billAmount: l.bill_amount != null ? String(l.bill_amount) : '',
    isBillable: l.is_billable === true,
    departmentId: lineText(l.department_id),
    projectId: lineText(l.project_id),
    locationId: lineText(l.location_id),
    classId: lineText(l.class_id),
    stockLocationId: lineText(l.stock_location_id),
    // Overwritten below from native return evidence when the line carries it.
    returnSourceMovementId: '',
    taxProfileId: l.tax_group_id ? `group:${l.tax_group_id}` : l.tax_code_id ? `code:${l.tax_code_id}` : '',
    amount: l.amount != null ? String(l.amount) : '',
    taxInputAmount: l.tax_input_amount != null ? String(l.tax_input_amount) : '',
    taxOverridden: l.tax_overridden === true,
    taxAmount: l.tax_amount != null ? String(l.tax_amount) : '',
    ...distributionFieldsOf(l),
  }
  const custom = isLineMap(l.custom) ? l.custom : null
  const extraDims = isLineMap(l.extra_dims) ? l.extra_dims : null
  // Native return evidence: the server owns both spellings (a vendor credit
  // names a receipt, a customer credit a shipment) and only ever writes one.
  const inventoryReturn = custom && isLineMap(custom.inventoryReturn) ? custom.inventoryReturn : null
  row.returnSourceMovementId = lineText(
    inventoryReturn?.sourceReceiptMovementId ?? inventoryReturn?.sourceIssueMovementId,
  )
  for (const def of lineDefs) row[`cf_${def.key}`] = custom?.[def.key] ?? ''
  for (const segment of segments) row[`seg_${segment.key}`] = extraDims?.[segment.key] ?? ''
  return row
}

type DrawerTotalsRow = Pick<LineRow, 'accountId' | 'amount' | 'taxInputAmount' | 'taxProfileId' | 'taxOverridden' | 'taxAmount'>

export type DocumentDrawerTotals = {
  subtotal: string
  taxTotal: string
  total: string
}

/**
 * Keep the edit-mode footer in lockstep with the line payload. Persisted
 * inclusive-tax lines retain both their net `amount` and the original gross
 * `taxInputAmount`; use the latter only while the amount still matches its
 * derived net value, so a subsequent amount edit is treated as fresh input.
 */
export function computeDocumentDrawerTotals(
  rows: readonly DrawerTotalsRow[],
  taxByProfile: ReadonlyMap<string, TaxComponentConfig[]>,
  hasTax: boolean,
): DocumentDrawerTotals {
  const lineTotals = rows
    .filter((row) => isPricedDrawerLine(row))
    .map((row) => {
      const amount = String(row.amount)
      const taxConfig = taxByProfile.get(row.taxProfileId) ?? []
      if (!hasTax) {
        try {
          return { subtotal: normalizeMoney(amount), taxTotal: '0.0000' }
        } catch {
          return { subtotal: '0.0000', taxTotal: '0.0000' }
        }
      }

      const persistedInput = String(row.taxInputAmount ?? '').trim()
      let inputAmount = amount
      if (persistedInput && taxConfig.some((component) => component.priceIncludesTax)) {
        try {
          const normalizedAmount = normalizeMoney(amount)
          const persistedResult = computeLineTaxes(persistedInput, taxConfig)
          if (cmp(persistedResult.netAmount, normalizedAmount) === 0) inputAmount = persistedInput
        } catch {
          // An incomplete profile or malformed persisted value is handled by
          // the normal calculation/fallback below; never block the drawer.
        }
      }

      try {
        const result = computeLineTaxes(
          inputAmount,
          taxConfig,
          row.taxOverridden
            ? { overridden: true, taxAmount: row.taxAmount }
            : undefined,
        )
        return { subtotal: result.netAmount, taxTotal: result.taxTotal }
      } catch {
        // The save boundary still rejects malformed amounts. Showing a zero
        // for an invalid draft cell avoids inventing a numeric total here.
        try {
          return {
            subtotal: normalizeMoney(amount),
            taxTotal: row.taxOverridden ? normalizeMoney(row.taxAmount) : '0.0000',
          }
        } catch {
          return { subtotal: '0.0000', taxTotal: '0.0000' }
        }
      }
    })
  const subtotal = sum(lineTotals.map((line) => line.subtotal))
  const taxTotal = sum(lineTotals.map((line) => line.taxTotal))
  return { subtotal, taxTotal, total: add(subtotal, taxTotal) }
}

function drawerTaxInputAmount(row: DrawerTotalsRow, taxConfig: TaxComponentConfig[]): string {
  const amount = String(row.amount ?? '')
  const persistedInput = String(row.taxInputAmount ?? '').trim()
  if (!persistedInput || !taxConfig.some((component) => component.priceIncludesTax)) return amount
  try {
    return cmp(computeLineTaxes(persistedInput, taxConfig).netAmount, normalizeMoney(amount)) === 0
      ? persistedInput
      : amount
  } catch {
    return amount
  }
}

export interface DocumentDrawerProps {
  payload: DocPayload
  config: DocKindConfig
  basePath: string
  /** Related records retain their party/project/report drawer host. */
  relatedNavigation?: boolean
  parties?: Opt[]
  accounts: Opt[]
  taxCodes?: Opt[]
  taxGroups?: Opt[]
  cards?: Opt[]
  /** Reconcilable card-liability accounts: the card picker fallback when no
   * card instruments exist (F-t05-020). Only passed by loaders for
   * fundingSource='card' kinds. */
  cardAccounts?: Opt[]
  bankAccounts?: Opt[]
  departments: Opt[]
  projects: Opt[]
  locations?: Opt[]
  classes?: Opt[]
  segments?: SegmentOpt[]
  builtinSegments?: BuiltinSegmentOpt[]
  items?: Opt[]
  /** Active warehouses for the line-level stock-location picker. Only passed
   *  by loaders for kinds with inventory lines; empty/undefined (or a single
   *  location, which the writer stamps silently) renders NO picker. */
  stockLocations?: { id: string; code: string | null }[]
  /** The org's subsidiaries (depth-first tree order). Only passed by pages in
   *  multi-subsidiary orgs — empty/undefined renders NO subsidiary UI. */
  subsidiaries?: SubsidiaryOpt[]
  headerDefs: CustomFieldDefClient[]
  lineDefs: CustomFieldDefClient[]
  canCreate: boolean
  canPost: boolean
  /**
   * Unsaved create (`?doc=new&kind=`): the drawer edits a blank in-memory
   * payload with autosave disarmed — no revision machinery runs because no
   * persisted row exists. Save POSTs the collection once (Idempotency-Key
   * per drawer session) and routes to the persisted id; Cancel/close
   * navigates away and writes nothing. Reuses this same drawer, layout, and
   * validation — never a forked create form.
   */
  createMode?: boolean
  /** Initial presentation mode. Creation flows request edit; existing records
   *  continue to default to view. Status and permission checks still apply. */
  initialMode?: DrawerMode
  /** Resolved transaction form layout; when present the header + line columns
   *  render from it (move/hide/rename/custom fields). Omitted only for the
   *  defensive loading fallback used while a page is resolving. */
  layout?: FormLayoutConfig
  /** Available org form layouts (for the per-record "Custom Form" picker). */
  availableLayouts?: { id: string; name: string; isDefault?: boolean }[]
  currentLayoutId?: string | null
  /** Record-type key (for the form-preference API). */
  recordType?: string
  /** User holds admin.customization.manage — shows the Customize entry that
   *  deep-links into the form designer for this record type. */
  canCustomize?: boolean
  /** Optional kind-specific section rendered read-only at the bottom of the
   *  drawer body (e.g. online payment links on customer invoices). */
  afterContent?: React.ReactNode
  /** Server-known entry-mode allocation gate. When explicitly false the
   *  drawer skips the entry-candidates presence checks entirely instead of
   *  firing requests the server must refuse (console 404s in orgs without
   *  the feature). Undefined preserves the probe-and-hide behavior. */
  allocationsEntryEnabled?: boolean
}

export function DocumentDrawer({
  payload,
  config,
  basePath,
  relatedNavigation,
  parties,
  accounts,
  taxCodes,
  taxGroups,
  cards,
  cardAccounts,
  bankAccounts,
  departments,
  projects,
  locations,
  classes,
  segments = EMPTY_SEGMENTS,
  builtinSegments = EMPTY_BUILTIN_SEGMENTS,
  items,
  stockLocations,
  subsidiaries,
  headerDefs,
  lineDefs,
  canCreate,
  canPost,
  createMode = false,
  initialMode = 'view',
  layout,
  availableLayouts,
  currentLayoutId,
  recordType,
  canCustomize,
  afterContent,
  allocationsEntryEnabled,
}: DocumentDrawerProps) {
  const { money } = useMoney()
  const t = useTranslations(config.i18n)
  const tCommon = useTranslations('common')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const doc = asDocumentDoc(payload.doc)
  const hrefForDocument = (targetId: string, form?: string) => documentDrawerHref({
    pathname, query: searchParams.toString(), basePath, currentId: String(doc.id),
    targetId, kind: config.kind, related: relatedNavigation, form,
  })
  const isDraft = doc.status === 'draft'
  const isPosted = doc.status === 'posted'
  const isTransfer = config.kind === 'transfer'

  const canEditStatus =
    (doc.status === 'draft' && canCreate) ||
    (doc.status === 'posted' && canCreate && canPost)
  // Existing records default to read-only. A creation flow may request edit
  // mode, but status and permission checks remain authoritative. An unsaved
  // create always opens editing its blank payload (never a persisted state).
  const isCreate = createMode === true
  const [mode, setMode] = useState<DrawerMode>(
    isCreate ? 'edit' : initialDrawerMode(initialMode, canEditStatus),
  )
  // Stable per drawer session (remounted per `new:<kind>` upstream): a
  // retried first Save replays against this key instead of duplicating.
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const editable = mode === 'edit' && canEditStatus
  // Posted open-item docs that carry a balance resolve to open/paid from the
  // applications ledger (invoices). Credits post open items too but their
  // "applied" flows the opposite direction, so they show their raw status.
  const displayStatus = isPosted && config.showsBalance
    ? cmp(String(doc.balance_due ?? '0'), '0') > 0
      ? 'open'
      : 'paid'
    : doc.status

  const [partyId, setPartyId] = useState<string>(doc.party_id ?? '')
  const [paymentCardId, setPaymentCardId] = useState<string>(doc.payment_card_id ?? '')
  const [documentDate, setDocumentDate] = useState<string>(doc.document_date ?? '')
  const [dueDate, setDueDate] = useState<string>(doc.due_date ?? '')
  const [referenceNumber, setReferenceNumber] = useState<string>(doc.reference_number ?? '')
  const [memo, setMemo] = useState<string>(doc.memo ?? '')
  // Full-schema header built-ins (off by default; shown when a form enables them).
  const [postingDate, setPostingDate] = useState<string>(doc.posting_date ?? '')
  const [departmentId, setDepartmentId] = useState<string>(doc.department_id ?? '')
  const [projectIdHeader, setProjectIdHeader] = useState<string>(doc.project_id ?? '')
  const [locationId, setLocationId] = useState<string>(doc.location_id ?? '')
  const [classId, setClassId] = useState<string>(doc.class_id ?? '')
  const [subsidiaryId, setSubsidiaryId] = useState<string>(doc.subsidiary_id ?? '')
  const [expectedPayDate, setExpectedPayDate] = useState<string>(doc.expected_pay_date ?? '')
  const [paymentHoldReason, setPaymentHoldReason] = useState<string>(doc.payment_hold_reason ?? '')
  const [internalNotes, setInternalNotes] = useState<string>(doc.internal_notes ?? '')
  const [billingMethod, setBillingMethod] = useState<string>(doc.billing_method ?? '')
  const [isFinalInvoice, setIsFinalInvoice] = useState<boolean>(doc.is_final_invoice === true)
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(doc.custom ?? {})
  const [extraDims, setExtraDims] = useState<Record<string, string>>(doc.extra_dims ?? {})

  // -- transfer: dedicated to/from + amount state ---------------------------
  const transferFromPayload = (
    source: DocPayload,
  ): { toAccount: string; fromAccount: string; amount: string } | null =>
    isTransfer
      ? {
          toAccount: lineText(source.lines[0]?.account_id),
          fromAccount: lineText(source.lines[1]?.account_id),
          amount: source.lines[0]?.amount != null ? String(source.lines[0].amount) : '',
        }
      : null
  const initialTransfer = transferFromPayload(payload)
  const [transfer, setTransfer] = useState(initialTransfer)

  const [rows, setRows] = useState<LineRow[]>(
    payload.lines.length > 0 ? payload.lines.map((l) => toRow(l, lineDefs, segments)) : [emptyLine()],
  )
  // F-t02-004: grid edits flow through here so a quantity/unit-price change
  // re-derives the line amount (blank/manual-divergent amounts are kept).
  const handleGridRowsChange = useCallback((next: LineRow[]) => {
    setRows((prev) => applyQtyPriceToRows(prev, next))
  }, [])
  const [totals, setTotals] = useState({ subtotal: doc.subtotal, taxTotal: doc.tax_total, total: doc.total })
  // No persisted row exists in create mode, so there is no revision token to
  // pin: the revision-coupled effects below are disarmed there instead.
  const persistedPropRevision = isCreate ? '' : persistedDocumentRevision(doc.updated_at)
  const [documentRevision, setDocumentRevision] = useState(persistedPropRevision)
  const seenPersistedRevisions = useRef(new Set([persistedPropRevision]))
  const persistedBaseline = useRef<PersistedDocumentSnapshot<DocPayload>>({
    documentId: String(doc.id),
    revision: persistedPropRevision,
    payload,
  })
  const [rehydrationEpoch, setRehydrationEpoch] = useState(0)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  // A refused submit/post that only fires a transient toast reads as
  // "nothing happened" once it dismisses (the F-t06-018 precedent): the
  // typed refusal also persists as a record-level alert, cleared on the
  // next action. Saves, lifecycle actions, deletes, voids and form
  // preference writes all run on the shared action path, whose busy flag
  // always releases through its own finally.
  const { busy, refusal, execute, refuse, runExclusive } = useAppAction()

  const taxProfiles = useMemo(() => [
    ...(taxCodes ?? []).map((profile) => ({ ...profile, value: `code:${profile.id}` })),
    ...(taxGroups ?? []).map((profile) => ({ ...profile, value: `group:${profile.id}` })),
  ], [taxCodes, taxGroups])
  const taxByProfile = useMemo(
    () => new Map(taxProfiles.map((profile) => [profile.value, profile.tax_components ?? []])),
    [taxProfiles],
  )
  const lineTax = (row: LineRow) => {
    try {
      const taxConfig = taxByProfile.get(row.taxProfileId) ?? []
      return computeLineTaxes(drawerTaxInputAmount(row, taxConfig), taxConfig).taxTotal
    } catch {
      return '0.0000'
    }
  }

  // -- entry-mode distributions (shard A9) ----------------------------------
  // The server is the feature truth: every affordance below renders only
  // while entry-candidates answers. A 404/403 (gate off, out of scope)
  // hides everything, and the server refuses regardless of UI.
  const tAlloc = useTranslations('allocations')
  const distEditable = editable && !isTransfer && config.kind !== 'project_charge'
  const [distOn, setDistOn] = useState(false)
  const [distAuto, setDistAuto] = useState<EntryDistributionCandidate[]>([])
  const [distLineMap, setDistLineMap] = useState<ReadonlyMap<string, EntryDistributionCandidate[]>>(new Map())
  const [distLineFailed, setDistLineFailed] = useState<ReadonlySet<string>>(new Set())
  const [distApplying, setDistApplying] = useState(false)
  const [splitTarget, setSplitTarget] = useState<number | null>(null)
  const distInflight = useRef(new Set<string>())
  // Staged-key display names only: applied-rule names ride the read-path
  // stamps (distribution_rule_name, A4), never this cache.
  const distNamesByKey = useRef(new Map<string, string>())

  const distCoordKey = (row: LineRow): string =>
    JSON.stringify([row.accountId, row.departmentId, row.projectId, row.locationId, row.classId])

  const distParams = (extra: Record<string, string> = {}): string => {
    const params = new URLSearchParams({
      documentKind: config.kind,
      documentDate: /^\d{4}-\d{2}-\d{2}$/.test(documentDate) ? documentDate : new Date().toISOString().slice(0, 10),
      ...extra,
    })
    if (subsidiaryId) params.set('subsidiaryId', subsidiaryId)
    return params.toString()
  }

  const cacheDistNames = (rules: EntryDistributionCandidate[]): void => {
    for (const rule of rules) {
      distNamesByKey.current.set(rule.ruleKey, rule.ruleName)
    }
  }

  // Header-level presence check: which automatic rules are in effect.
  useEffect(() => {
    let cancelled = false
    const run = async (): Promise<void> => {
      // The whole block runs async so the gate-off reset below never sets
      // state synchronously in the effect body (cascading renders).
      // A server-known off gate skips the probe entirely: the server must
      // refuse entry-candidates when the feature is off, and firing that
      // refusal litters the console on every drawer open.
      if (allocationsEntryEnabled === false) {
        if (!cancelled) {
          setDistOn(false)
          setDistAuto([])
        }
        return
      }
      if (!distEditable) {
        if (!cancelled) {
          setDistOn(false)
          setDistAuto([])
        }
        return
      }
      try {
        const res = await fetch(`/api/allocations/entry-candidates?${distParams()}`)
        if (!res.ok) {
          if (!cancelled) {
            setDistOn(false)
            setDistAuto([])
          }
          return
        }
        const body = (await res.json()) as { rules?: EntryDistributionCandidate[] }
        const rules = Array.isArray(body.rules) ? body.rules : []
        if (!cancelled) {
          cacheDistNames(rules)
          setDistOn(true)
          setDistAuto(rules.filter((rule) => rule.applyPolicy === 'automatic'))
        }
      } catch {
        if (!cancelled) {
          setDistOn(false)
          setDistAuto([])
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distEditable, config.kind, documentDate, subsidiaryId, allocationsEntryEnabled])

  // Per-line candidates for priced ungrouped rows, fetched lazily and
  // cached by coordinate so typing in one row never storms the route.
  const distLineSignature =
    distOn && distEditable
      ? rows
          .filter((r) => isPricedDrawerLine(r) && groupIdOf(r) === null)
          .map((r) => `${distCoordKey(r)}@${r.amount}`)
          .sort()
          .join('|')
      : ''
  useEffect(() => {
    if (!distLineSignature) return
    const timer = setTimeout(() => {
      const missing = new Map<string, LineRow>()
      for (const row of rows) {
        if (!isPricedDrawerLine(row) || groupIdOf(row) !== null) continue
        const key = distCoordKey(row)
        if (distLineMap.has(key) || distLineFailed.has(key) || distInflight.current.has(key)) continue
        if (!missing.has(key)) missing.set(key, row)
      }
      for (const [key, row] of missing) {
        distInflight.current.add(key)
        const params = distParams({
          accountId: row.accountId,
          ...(row.departmentId ? { departmentId: row.departmentId } : {}),
          ...(row.projectId ? { projectId: row.projectId } : {}),
          ...(row.locationId ? { locationId: row.locationId } : {}),
          ...(row.classId ? { classId: row.classId } : {}),
        })
        void (async () => {
          try {
            const res = await fetch(`/api/allocations/entry-candidates?${params}`)
            if (!res.ok) throw new Error(`candidates ${res.status}`)
            const body = (await res.json()) as { rules?: EntryDistributionCandidate[] }
            const rules = Array.isArray(body.rules) ? body.rules : []
            cacheDistNames(rules)
            setDistLineMap((prev) => new Map(prev).set(key, rules))
          } catch {
            setDistLineFailed((prev) => new Set(prev).add(key))
          } finally {
            distInflight.current.delete(key)
          }
        })()
      }
    }, 250)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distLineSignature, distOn, distEditable])

  const distNameByKey = (key: string): string | null => distNamesByKey.current.get(key) ?? null

  const distSuggest = (row: LineRow): EntryDistributionCandidate | null => {
    const found = distLineMap.get(distCoordKey(row))?.find((rule) => rule.applyPolicy === 'suggest')
    return found ?? null
  }

  const stageDistributionKey = (index: number, ruleKey: string): void => {
    setRows((prev) => prev.map((r, j) => (j === index ? { ...r, distributionKey: ruleKey } : r)))
  }

  const applyDistSuggestion = (index: number): void => {
    const row = rows[index]
    if (!row) return
    const pick = distSuggest(row)
    if (pick) stageDistributionKey(index, pick.ruleKey)
  }

  const applyDistAutomatic = async (): Promise<void> => {
    setDistApplying(true)
    try {
      const staged = new Map<string, string>()
      const missing = new Map<string, LineRow>()
      for (const row of rows) {
        if (!isPricedDrawerLine(row) || groupIdOf(row) !== null || row.distributionKey) continue
        const key = distCoordKey(row)
        const cached = distLineMap.get(key)?.filter((rule) => rule.applyPolicy === 'automatic')
        if (cached && cached.length > 0) {
          const winner = cached.find((rule) => rule.recommended) ?? cached[0]
          if (winner) staged.set(key, winner.ruleKey)
        } else if (!distLineFailed.has(key) && !distInflight.current.has(key)) {
          if (!missing.has(key)) missing.set(key, row)
        }
      }
      for (const [key, row] of missing) {
        distInflight.current.add(key)
        try {
          const params = distParams({
            accountId: row.accountId,
            ...(row.departmentId ? { departmentId: row.departmentId } : {}),
            ...(row.projectId ? { projectId: row.projectId } : {}),
            ...(row.locationId ? { locationId: row.locationId } : {}),
            ...(row.classId ? { classId: row.classId } : {}),
            policy: 'automatic',
          })
          const res = await fetch(`/api/allocations/entry-candidates?${params}`)
          if (!res.ok) throw new Error(`candidates ${res.status}`)
          const body = (await res.json()) as { rules?: EntryDistributionCandidate[] }
          const rules = Array.isArray(body.rules) ? body.rules : []
          cacheDistNames(rules)
          setDistLineMap((prev) => new Map(prev).set(key, rules))
          const winner = rules.find((rule) => rule.recommended) ?? rules[0]
          if (winner) staged.set(key, winner.ruleKey)
        } catch {
          setDistLineFailed((prev) => new Set(prev).add(key))
        } finally {
          distInflight.current.delete(key)
        }
      }
      if (staged.size > 0) {
        setRows((prev) =>
          prev.map((r) => {
            if (!isPricedDrawerLine(r) || groupIdOf(r) !== null || r.distributionKey) return r
            const key = staged.get(distCoordKey(r))
            return key ? { ...r, distributionKey: key } : r
          }),
        )
      }
    } finally {
      setDistApplying(false)
    }
  }

  const unsplitDistGroup = (groupKey: string): void => {
    setRows((prev) => {
      const collapsed = collapseDistributionGroup(prev, groupKey)
      if (!collapsed) return prev
      const members = groupMembers(prev, groupKey)
      const keep = new Set(members.map((m) => m.index))
      const first = members[0]!
      const next: LineRow[] = []
      prev.forEach((r, j) => {
        if (!keep.has(j)) next.push(r)
        else if (j === first.index) next.push({ ...first.row, ...clearedDistributionFields(), amount: collapsed.total })
      })
      return next.length > 0 ? next : [emptyLine()]
    })
  }

  const toggleDistLock = (groupKey: string): void => {
    setRows((prev) => {
      const members = groupMembers(prev, groupKey)
      if (members.length === 0) return prev
      const locked = !isGroupLocked(members.map((m) => m.row))
      const keep = new Set(members.map((m) => m.index))
      return prev.map((r, j) => (keep.has(j) ? { ...r, distributionLocked: locked } : r))
    })
  }

  const editDistGroupTotal = (groupKey: string, total: string): void => {
    setRows((prev) => {
      const members = groupMembers(prev, groupKey)
      if (members.length === 0 || isGroupLocked(members.map((m) => m.row))) return prev
      const amounts = reapportionGroupTotal(
        members.map((m) => String(m.row.amount ?? '')),
        total,
      )
      const byIndex = new Map(members.map((m, k) => [m.index, amounts[k]!]))
      return prev.map((r, j) => (byIndex.has(j) ? { ...r, amount: byIndex.get(j)! } : r))
    })
  }

  const applyDialogRule = (ruleKey: string): void => {
    if (splitTarget !== null) stageDistributionKey(splitTarget, ruleKey)
    setSplitTarget(null)
  }

  const applyDialogChildren = (children: DistributionDialogChild[]): void => {
    if (splitTarget === null) return
    const parent = rows[splitTarget]
    if (!parent) {
      setSplitTarget(null)
      return
    }
    const groupKey = crypto.randomUUID()
    const built: LineRow[] = children.map((child) => {
      const base: LineRow = { ...emptyLine(), ...clearedDistributionFields() }
      for (const key of Object.keys(parent)) {
        if (key.startsWith('cf_') || key.startsWith('seg_')) base[key] = parent[key]
      }
      return {
        ...base,
        accountId: child.accountId,
        itemId: parent.itemId,
        description: child.description ?? parent.description,
        quantity: parent.quantity,
        unit: parent.unit,
        unitPrice: parent.unitPrice,
        costRate: parent.costRate,
        billRate: parent.billRate,
        billAmount: parent.billAmount,
        isBillable: parent.isBillable,
        departmentId: child.departmentId ?? parent.departmentId,
        projectId: child.projectId ?? parent.projectId,
        locationId: child.locationId ?? parent.locationId,
        classId: child.classId ?? parent.classId,
        taxProfileId: parent.taxProfileId,
        amount: child.amount,
        distributionGroupId: groupKey,
        // Hand-entered children are locked from birth: the operator tuned
        // them, so no later amount change re-explodes the group.
        distributionLocked: true,
      }
    })
    const at = splitTarget
    setRows((prev) => [...prev.slice(0, at), ...built, ...prev.slice(at + 1)])
    setSplitTarget(null)
  }

  const distCodings = useMemo(() => {
    const opts = (list: Opt[] | undefined): { value: string; label: string }[] =>
      (list ?? []).map((o) => ({ value: o.id, label: o.display_name ?? o.name ?? o.id }))
    return [
      { key: 'department' as const, label: tCommon('labels.department'), options: opts(departments) },
      { key: 'project' as const, label: tCommon('labels.project'), options: opts(projects) },
      { key: 'location' as const, label: tCommon('labels.location'), options: opts(locations) },
      { key: 'class' as const, label: tCommon('labels.class'), options: opts(classes) },
    ]
  }, [departments, projects, locations, classes, tCommon])

  const distribution = useMemo<LineGridDistribution<LineRow> | undefined>(() => {
    if (!distOn || !distEditable) return undefined
    const groups = groupHeaderModels(rows, { ruleNameOf: (member) => member.distributionRuleName || null })
    const groupedIndexes = new Set<number>()
    for (const group of groups) {
      for (const member of groupMembers(rows, group.key)) groupedIndexes.add(member.index)
    }
    const lookup = {
      ruleNameOf: (row: LineRow) => row.distributionRuleName || null,
      pendingRuleNameOf: (row: LineRow) =>
        row.distributionKey ? (distNameByKey(row.distributionKey) ?? row.distributionKey) : null,
      suggestionOf: (row: LineRow) => {
        const found = distSuggest(row)
        return found ? { ruleName: found.ruleName } : null
      },
      splittable: (row: LineRow) => isPricedDrawerLine(row) && groupIdOf(row) === null,
    }
    return {
      groups,
      groupedIndexes,
      groupKeyOf: (row) => groupIdOf(row),
      chipOf: (row, index) => chipForRow(row, index, lookup),
      menuKeysOf: (row, index) => menuKeysForRow(row, index, lookup),
      onSplit: (index) => setSplitTarget(index),
      onUnsplit: (groupKey) => unsplitDistGroup(groupKey),
      onToggleLock: (groupKey) => toggleDistLock(groupKey),
      onApplySuggestion: (index) => applyDistSuggestion(index),
      onEditGroupTotal: (groupKey, total) => editDistGroupTotal(groupKey, total),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distOn, distEditable, rows, distLineMap])

  const calculatedTotals = useMemo<DocumentDrawerTotals | null>(() => {
    if (!editable) return null
    if (isTransfer) {
      try {
        const amount = normalizeMoney(String(transfer?.amount ?? ''))
        return { subtotal: amount, taxTotal: '0.0000', total: amount }
      } catch {
        return { subtotal: '0.0000', taxTotal: '0.0000', total: '0.0000' }
      }
    }
    // Project-charge lines are immutable here; their source editor owns the
    // rate snapshot and the server-provided totals remain authoritative.
    if (config.kind === 'project_charge') return null
    return computeDocumentDrawerTotals(rows, taxByProfile, config.hasTax)
  }, [editable, isTransfer, transfer, config.kind, config.hasTax, rows, taxByProfile])
  const effectiveTotals = calculatedTotals ?? totals

  // -- subsidiaries (multi-subsidiary orgs only; empty/undefined = no UI) ----
  const multiSub = (subsidiaries?.length ?? 0) > 0
  const subsidiaryOpts = useMemo(
    () => (subsidiaries ?? []).map((s) => ({ value: s.id, label: '\u2003'.repeat(s.depth) + s.name })),
    [subsidiaries],
  )
  const subsidiaryName = (id: unknown): string =>
    (subsidiaries ?? []).find((s) => s.id === id)?.name ?? '—'
  /** Picking a party on a draft defaults the document's subsidiary to the party's primary. */
  const changeParty = (v: string | null | undefined) => {
    setPartyId(v ?? '')
    if (multiSub && isDraft && v) {
      const sub = (parties ?? []).find((p) => p.id === v)?.subsidiary_id
      if (sub) setSubsidiaryId(sub)
    }
  }

  // Stocked lines relieve a warehouse at posting, so a customer invoice for
  // stocked goods must name one per line. The picker appears only when the
  // choice is real (several active locations) and only on stocked rows; a
  // single location is stamped silently by the edit writer instead.
  const stockedItemIds = useMemo(
    () => new Set((items ?? []).filter((item) => item.has_inventory_profile === true).map((item) => item.id)),
    [items],
  )
  // A credit memo may return stock. The engine settles the return against the
  // posted movement the goods left or arrived on, so the operator picks that
  // movement here; leaving a row blank keeps it a purely financial credit.
  // The same reader answers this list and the save-time check, so the picker
  // cannot offer a source the save refuses.
  const returnSide =
    recordType === 'vendor_credit' ? 'purchase' : recordType === 'customer_credit' ? 'sales' : null
  const returnRowsKey = rows
    .map((row) => `${row.itemId}:${row.stockLocationId}`)
    .filter((key) => key !== ':')
    .join('|')
  const [returnSources, setReturnSources] = useState<ReturnableSourceOption[]>([])
  useEffect(() => {
    let cancelled = false
    const run = async (): Promise<void> => {
      if (!returnSide || !partyId || returnRowsKey === '') {
        if (!cancelled) setReturnSources([])
        return
      }
      try {
        const res = await fetch(
          `/api/inventory/returnable-sources?side=${returnSide}&partyId=${encodeURIComponent(partyId)}`,
        )
        // Inventory off, credit kind off, or no permission: no picker, and no
        // console noise for a refusal the drawer already knows how to absorb.
        if (!res.ok) {
          if (!cancelled) setReturnSources([])
          return
        }
        const body = (await res.json()) as { sources?: ReturnableSourceOption[] }
        if (!cancelled) setReturnSources(Array.isArray(body.sources) ? body.sources : [])
      } catch {
        if (!cancelled) setReturnSources([])
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [returnSide, partyId, returnRowsKey])
  const showReturnPicker = returnSide !== null && returnSources.length > 0
  const returnSourceColumn = useMemo<LineGridColumn<LineRow> | null>(() => {
    if (!showReturnPicker) return null
    return {
      key: 'returnSourceMovementId',
      label: returnSide === 'purchase' ? t('drawer.returnsReceipt') : t('drawer.returnsShipment'),
      width: '190px',
      type: 'select',
      options: [
        { value: '', label: t('drawer.returnsNone') },
        ...returnSources.map((source) => ({
          value: source.movementId,
          label: `${source.documentNumber ?? source.movedAt} · ${source.remaining}${
            source.lotCode ? ` · ${source.lotCode}` : source.serialCode ? ` · ${source.serialCode}` : ''
          }`,
        })),
      ],
      // Only a stocked row in a named warehouse can carry a return: the save
      // refuses one without both, so do not offer the choice before then.
      isCellEditable: (row) =>
        stockedItemIds.has(String(row.itemId ?? '')) && String(row.stockLocationId ?? '') !== '',
    }
  }, [showReturnPicker, returnSide, returnSources, stockedItemIds, t])

  const payload_ = useMemo(() => {
    if (isTransfer) {
      return {
        paymentCardId: null,
        partyId: null,
        documentDate: documentDate || undefined,
        dueDate: null,
        referenceNumber: null,
        memo,
        // Only sent in multi-subsidiary orgs (undefined drops out of the JSON body).
        subsidiaryId: multiSub ? subsidiaryId || null : undefined,
        extraDims,
        custom: customValues,
        // Kernel contract: the amount rides ONLY the destination line; the
        // source line names its account and carries zero — the same shape
        // every native importer emits. Two full-amount legs post 2x.
        lines:
          transfer && transfer.toAccount && transfer.fromAccount && positiveAmount(transfer.amount)
            ? [
                { accountId: transfer.toAccount, amount: transfer.amount, description: null },
                { accountId: transfer.fromAccount, amount: '0', description: null },
              ]
            : [],
      }
    }
    return {
      partyId: partyId || null,
      paymentCardId: config.fundingSource === 'card' ? paymentCardId || null : null,
      documentDate: documentDate || undefined,
      dueDate: config.hasDueDate ? dueDate || null : null,
      referenceNumber: config.hasReference ? referenceNumber : null,
      memo,
      // Full-schema header built-ins (persisted only when the form exposes them,
      // but harmless to always send — the API updates the columns directly).
      postingDate: postingDate || null,
      departmentId: departmentId || null,
      projectId: projectIdHeader || null,
      locationId: locationId || null,
      classId: classId || null,
      extraDims,
      // Only sent in multi-subsidiary orgs (undefined drops out of the JSON body).
      subsidiaryId: multiSub ? subsidiaryId || null : undefined,
      expectedPayDate: expectedPayDate || null,
      paymentHoldReason: paymentHoldReason || null,
      internalNotes: internalNotes || null,
      billingMethod: billingMethod || null,
      isFinalInvoice,
      custom: customValues,
      ...(config.kind === 'project_charge'
        ? {}
        : {
            lines: rows
              .filter((r) => isPricedDrawerLine(r))
              .map((r) => ({
                // Server provenance match needs the identity; native custom
                // is never sent (the server re-attaches its locked rows).
                lineId: r.lineId || null,
                accountId: r.accountId,
                itemId: r.itemId || null,
                description: r.description,
                quantity: r.quantity !== '' ? r.quantity : null,
                unit: r.unit || null,
                unitPrice: r.unitPrice !== '' ? r.unitPrice : null,
                // Inclusive-tax rows are displayed from their persisted net
                // amount, but the edit API accepts the original gross input.
                // Keep an untouched row round-tripping without changing its
                // tax treatment; an edited amount is detected by the helper.
                amount: config.hasTax
                  ? drawerTaxInputAmount(r, taxByProfile.get(r.taxProfileId) ?? [])
                  : r.amount,
                taxCodeId: config.hasTax && r.taxProfileId.startsWith('code:') ? r.taxProfileId.slice(5) : null,
                taxGroupId: config.hasTax && r.taxProfileId.startsWith('group:') ? r.taxProfileId.slice(6) : null,
                taxOverridden: config.hasTax ? r.taxOverridden : false,
                taxAmount: config.hasTax && r.taxOverridden ? r.taxAmount : null,
                departmentId: r.departmentId || null,
                projectId: r.projectId || null,
                locationId: r.locationId || null,
                classId: r.classId || null,
                stockLocationId: r.stockLocationId || null,
                // Tri-state, and only on kinds that can return stock: absent
                // preserves the stored selection, null clears it, an object
                // replaces it. The chosen movement carries its own lot and
                // serial, so they ride from the offered source rather than
                // being retyped — the save refuses any mismatch.
                ...(returnSourceColumn
                  ? {
                      inventoryReturnSource: r.returnSourceMovementId
                        ? {
                            movementId: r.returnSourceMovementId,
                            lotId:
                              returnSources.find((s) => s.movementId === r.returnSourceMovementId)
                                ?.lotId ?? null,
                            serialId:
                              returnSources.find((s) => s.movementId === r.returnSourceMovementId)
                                ?.serialId ?? null,
                          }
                        : null,
                    }
                  : {}),
                // Entry-mode distribution staging for A4's save path: a
                // blank key is skipped server-side; the lock rides as the
                // tri-state's explicit edge (absent would mean "stored").
                distributionKey: r.distributionKey || null,
                distributionLocked: r.distributionLocked,
                extraDims: Object.fromEntries(
                  segments
                    .map((segment) => [segment.key, r[`seg_${segment.key}`]])
                    .filter(([, value]) => value !== '' && value != null),
                ),
                custom: Object.fromEntries(
                  lineDefs.map((d) => [d.key, r[`cf_${d.key}`]]).filter(([, v]) => v !== '' && v != null),
                ),
              })),
          }),
    }
  }, [isTransfer, transfer, partyId, paymentCardId, documentDate, dueDate, referenceNumber, memo, postingDate, departmentId, projectIdHeader, locationId, classId, subsidiaryId, multiSub, expectedPayDate, paymentHoldReason, internalNotes, billingMethod, isFinalInvoice, customValues, extraDims, rows, lineDefs, segments, config, taxByProfile, returnSourceColumn, returnSources])

  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    // Unsaved create has no persisted snapshot to reconcile against — the
    // blank seed never changes under the editor, and Save navigates away.
    if (isCreate) return
    const incoming = {
      documentId: String(doc.id),
      revision: persistedPropRevision,
      payload,
    }
    const previousDocumentId = persistedBaseline.current.documentId
    const previouslySeen = new Set(seenPersistedRevisions.current)
    const decision = reconcilePersistedDocumentSnapshot(
      persistedBaseline.current,
      incoming,
      dirty,
      previouslySeen,
    )
    if (previousDocumentId !== incoming.documentId) {
      seenPersistedRevisions.current = new Set([persistedPropRevision])
    } else if (decision.rehydrate) {
      seenPersistedRevisions.current.add(persistedPropRevision)
    }
    if (decision.rehydrate) {
      persistedBaseline.current = decision.snapshot
      resetForm(decision.snapshot.payload)
      setDocumentRevision(decision.snapshot.revision)
      setDirty(false)
      setMode('view')
    }
    // The payload is inseparable from its revision. A changed payload with an
    // unchanged revision is an invalid server contract and is not adopted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, persistedPropRevision, dirty])
  // Track unsaved edits (no autosave — Save is an explicit button). Adjusted
  // during render (same committed value, no extra render). resetForm always
  // advances the rehydration epoch — even when the incoming values are
  // identical and payload_ therefore does not change — so the epoch change
  // itself bounds the suppression to that render and the next real user edit
  // can never be ignored.
  const [prevPayload, setPrevPayload] = useState(payload_)
  const [prevRehydrationEpoch, setPrevRehydrationEpoch] = useState(rehydrationEpoch)
  if (prevPayload !== payload_ || prevRehydrationEpoch !== rehydrationEpoch) {
    const rehydrating = prevRehydrationEpoch !== rehydrationEpoch
    setPrevPayload(payload_)
    setPrevRehydrationEpoch(rehydrationEpoch)
    if (!rehydrating && editable) setDirty(true)
  }

  function resetForm(source: DocPayload) {
    setRehydrationEpoch((epoch) => epoch + 1)
    const sourceDoc = asDocumentDoc(source.doc)
    setPartyId(sourceDoc.party_id ?? '')
    setPaymentCardId(sourceDoc.payment_card_id ?? '')
    setDocumentDate(sourceDoc.document_date ?? '')
    setDueDate(sourceDoc.due_date ?? '')
    setReferenceNumber(sourceDoc.reference_number ?? '')
    setMemo(sourceDoc.memo ?? '')
    setPostingDate(sourceDoc.posting_date ?? '')
    setDepartmentId(sourceDoc.department_id ?? '')
    setProjectIdHeader(sourceDoc.project_id ?? '')
    setLocationId(sourceDoc.location_id ?? '')
    setClassId(sourceDoc.class_id ?? '')
    setSubsidiaryId(sourceDoc.subsidiary_id ?? '')
    setExpectedPayDate(sourceDoc.expected_pay_date ?? '')
    setPaymentHoldReason(sourceDoc.payment_hold_reason ?? '')
    setInternalNotes(sourceDoc.internal_notes ?? '')
    setBillingMethod(sourceDoc.billing_method ?? '')
    setIsFinalInvoice(sourceDoc.is_final_invoice === true)
    setCustomValues(sourceDoc.custom ?? {})
    setExtraDims(sourceDoc.extra_dims ?? {})
    setTransfer(transferFromPayload(source))
    setRows(source.lines.length > 0 ? source.lines.map((l) => toRow(l, lineDefs, segments)) : [emptyLine()])
    setTotals({ subtotal: sourceDoc.subtotal, taxTotal: sourceDoc.tax_total, total: sourceDoc.total })
  }

  // Re-entry runs through the shared guard: save awaits the client-script
  // gate (up to 2 s) before execute sets busy, so a double-click used to
  // send two saves with the same revision — the second 409ing after the
  // first succeeded and pinning its error over the success. The guard flips
  // synchronously at click time and covers the whole preamble.
  const save = runExclusive(async () => {
    let amendmentReason: string | undefined
    if (isPosted) {
      const reason = await promptDialog({
        title: tCommon('amendment.title'),
        label: tCommon('amendment.reason'),
        placeholder: tCommon('amendment.placeholder'),
        confirmLabel: tCommon('actions.save'),
      })
      if (!reason) return
      amendmentReason = reason
    }
    setSaveState('saving')
    // Client scripts (sandboxed, opaque-origin evaluator) gate the save: an
    // explicit { abort } blocks; { warnings } toast and proceed; fail-open.
    const gate = await runClientScripts(config.kind, payload_)
    if (!gate.ok) {
      refuse(gate.reason, t('toasts.actionFailed'))
      setSaveState('error')
      return
    }
    for (const w of gate.warnings) toast.warning(w)
    // A currency-mismatched form can never post (the ledger refuses it), so
    // refuse the save up front with the account named (F-t06-002).
    if (blockCurrencyMismatch()) {
      setSaveState('error')
      return
    }
    // Unsaved create: the single collection write. Same client-script and
    // currency gates as an edit above; the server runs the shared writer, so
    // validation, refusals, and audit match an edit exactly.
    if (isCreate) {
      const create = buildDocumentCreateRequest(config.kind, payload_, idempotencyKey)
      await execute(
        () =>
          fetchAction(create.path, {
            method: create.method,
            headers: create.headers,
            body: JSON.stringify(create.body),
          }),
        {
          fallbackMessage: t('toasts.actionFailed'),
          onOk: (payload) => {
            const saved = (payload as DocPayload).doc
            router.push(`${basePath}?doc=${String(saved.id)}&mode=edit`)
            router.refresh()
          },
          onRefused: () => {
            setSaveState('error')
          },
        },
      )
      return
    }
    const request = buildDocumentSaveRequest(
      String(doc.id),
      documentRevision,
      payload_,
      isPosted,
      amendmentReason,
    )
    await execute(
      () =>
        fetchAction(request.path, {
          method: request.method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.body),
        }),
      {
        // A fresh attempt clears the previous refusal: the alert pins until
        // the next action, not past a successful save (F-t03-002).
        fallbackMessage: t('toasts.actionFailed'),
        onOk: (payload) => {
          const data = payload as DocPayload & {
            correctionId?: string
            voidStatus?: 'voided' | 'pending_approval'
          }
          if (isPosted && data.correctionId) {
            toast.success(
              data.voidStatus === 'pending_approval'
                ? t('toasts.submitted')
                : tCommon('amendment.correctionCreated'),
            )
            router.push(hrefForDocument(data.correctionId))
            router.refresh()
            return
          }
          const savedRevision = revisionFromSuccessfulDocumentSave(data)
          persistedBaseline.current = {
            documentId: String(data.doc.id),
            revision: savedRevision,
            payload: data,
          }
          seenPersistedRevisions.current.add(savedRevision)
          resetForm(data)
          setDocumentRevision(savedRevision)
          setSaveState('saved')
          setDirty(false)
          setMode('view')
          router.refresh()
        },
        onRefused: () => {
          // A save refusal stays on the record, not only in a toast
          // (F-t03-002): the typed reason pins as an alert until the next
          // action or edit.
          setSaveState('error')
        },
      },
    )
  })

  // A dirty editor never closes silently: the X button (via beforeClose) and
  // Cancel both ask first, so typed work survives a stray click (F-t02-003).
  async function confirmDiscard() {
    if (mode !== 'edit' || !dirty) return true
    return confirmDialog({
      message: tCommon('feedback.unsavedChanges'),
      confirmLabel: tCommon('confirm.discardChanges'),
      tone: 'danger',
    })
  }

  async function cancelWithConfirm() {
    if (!(await confirmDiscard())) return
    cancel()
  }

  function cancel() {
    // Unsaved create holds no persisted state to restore: closing navigates
    // away and writes nothing — zero writes by construction (the only write
    // this drawer can make is the Save POST above, which Cancel never runs).
    if (isCreate) {
      router.push(basePath)
      router.refresh()
      return
    }
    const incoming = {
      documentId: String(doc.id),
      revision: persistedPropRevision,
      payload,
    }
    const previousDocumentId = persistedBaseline.current.documentId
    const previouslySeen = new Set(seenPersistedRevisions.current)
    const decision = reconcilePersistedDocumentSnapshot(
      persistedBaseline.current,
      incoming,
      false,
      previouslySeen,
    )
    if (previousDocumentId !== incoming.documentId) {
      seenPersistedRevisions.current = new Set([persistedPropRevision])
    } else if (decision.rehydrate) {
      seenPersistedRevisions.current.add(persistedPropRevision)
    }
    persistedBaseline.current = decision.snapshot
    resetForm(decision.snapshot.payload)
    setDocumentRevision(decision.snapshot.revision)
    setDirty(false)
    setSaveState('saved')
    setMode('view')
  }

  async function act(action: 'submit' | 'post') {
    // Same up-front refusal as save: posting a currency-mismatched record
    // is a certain 422, so name the account before the round trip (F-t06-002).
    if (blockCurrencyMismatch()) {
      return
    }
    await execute(
      () =>
        fetchAction('/api/documents/actions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, documentId: doc.id }),
        }),
      {
        fallbackMessage: t('toasts.actionFailed'),
        onOk: (data) => {
          const pendingApproval =
            (data as { pendingApproval?: unknown } | null)?.pendingApproval === true
          if (pendingApproval) toast.success(t('toasts.submitted'))
          else toast.success(action === 'submit' ? t('toasts.submitted') : t('toasts.posted'))
          router.refresh()
        },
        onRefused: (error) => {
          // Lifecycle refusals (period locks, missing control accounts,
          // kernel guards) must stay visible in the drawer: a transient
          // toast alone is too easy to miss, so the message also pins as an
          // inline banner until the next action or edit. A rejected transport
          // pins without refreshing — there is nothing new to show.
          if (error.kind !== 'transport') router.refresh()
        },
      },
    )
  }

  async function remove() {
    if (
      !(await confirmDialog({
        title: t('drawer.deleteTitle'),
        message: t('drawer.deleteDraftBody'),
        confirmLabel: tCommon('actions.delete'),
        tone: 'danger',
      }))
    )
      return
    await execute(
      () =>
        fetchAction(`/api/documents/${doc.id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedUpdatedAt: documentRevision }),
        }),
      {
        fallbackMessage: t('toasts.deleteFailed'),
        successMessage: t('toasts.deleted'),
        onOk: () => {
          router.push(basePath)
          router.refresh()
        },
      },
    )
  }

  async function voidDocument() {
    const reason = await promptDialog({
      title: tCommon('amendment.voidTitle'),
      label: tCommon('amendment.reason'),
      placeholder: tCommon('amendment.voidPlaceholder'),
      confirmLabel: tCommon('actions.void'),
    })
    if (!reason) return
    await execute(
      () =>
        fetchAction(`/api/documents/${doc.id}/void`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason, expectedUpdatedAt: documentRevision }),
        }),
      {
        fallbackMessage: t('toasts.actionFailed'),
        onOk: (data) => {
          const status = (data as { status?: unknown } | null)?.status
          if (status === 'pending_approval') toast.success(t('toasts.submitted'))
          else toast.success(tCommon('status.voided'))
        },
      },
    )
    router.refresh()
  }

  // -- line warehouse picker (F-t07-003) ------------------------------------
  const showWarehousePicker =
    recordType === 'customer_invoice' &&
    (stockLocations ?? []).length > 1 &&
    rows.some((row) => row.itemId !== '' && stockedItemIds.has(row.itemId))
  const warehouseColumn = useMemo<LineGridColumn<LineRow> | null>(() => {
    if (!showWarehousePicker) return null
    return {
      key: 'stockLocationId',
      label: tCommon('labels.warehouse'),
      width: '150px',
      type: 'select',
      options: [{ value: '', label: '—' }, ...(stockLocations ?? []).map((l) => ({ value: l.id, label: l.code ?? '' }))],
      isCellEditable: (row) => stockedItemIds.has(String(row.itemId ?? '')),
    }
  }, [showWarehousePicker, stockLocations, stockedItemIds, tCommon])

  // -- grid columns (line-based kinds; transfer uses its own fields) --------
  const columns = useMemo<LineGridColumn<LineRow>[]>(() => {
    const cols: LineGridColumn<LineRow>[] = [
      {
        key: 'accountId',
        label: t('drawer.accountColumn'),
        width: 'minmax(200px,2fr)',
        type: 'search-select',
        required: true,
        options: accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() })),
        placeholder: t('drawer.accountPlaceholder'),
      },
      { key: 'description', label: tCommon('labels.description'), width: 'minmax(160px,1.6fr)', type: 'text' },
      {
        key: 'departmentId',
        label: tCommon('labels.department'),
        width: '140px',
        type: 'select',
        options: [{ value: '', label: '—' }, ...departments.map((d) => ({ value: d.id, label: d.name ?? '' }))],
      },
      {
        key: 'projectId',
        label: tCommon('labels.project'),
        width: 'minmax(150px,1.2fr)',
        type: 'search-select',
        options: projects.map((p) => ({ value: p.id, label: p.name ?? '' })),
        placeholder: '—',
      },
    ]
    if (warehouseColumn) cols.push(warehouseColumn)
    if (returnSourceColumn) cols.push(returnSourceColumn)
    if (config.hasTax) {
      cols.push({
        key: 'taxProfileId',
        label: tCommon('labels.tax'),
        width: '110px',
        type: 'select',
        options: [{ value: '', label: t('drawer.noTax') }, ...taxProfiles.map((profile) => ({ value: profile.value, label: profile.code ?? '' }))],
      })
    }
    for (const segment of segments.filter((item) => item.showOnLines)) {
      cols.push({
        key: `seg_${segment.key}`,
        label: segment.name,
        width: '150px',
        type: 'search-select',
        options: segment.values.map((value) => ({
          value: value.id,
          label: `${value.code ? `${value.code} · ` : ''}${value.name}`,
        })),
        placeholder: '—',
      })
    }
    for (const c of customFieldColumns<LineRow>(lineDefs)) cols.push(c)
    cols.push({ key: 'amount', label: tCommon('labels.amount'), width: '120px', type: 'amount', align: 'right', required: true })
    if (config.hasTax) {
      cols.push({
        key: 'taxAmount',
        label: t('drawer.taxAmountColumn'),
        width: '120px',
        type: 'tax',
        align: 'right',
        computeTax: lineTax,
        onTaxChange: (index, next) =>
          setRows((prev) =>
            prev.map((r, j) =>
              j === index ? { ...r, taxOverridden: next.overridden, taxAmount: next.taxAmount } : r,
            ),
          ),
      })
    }
    const lineVisibility = new Map(builtinSegments.map((segment) => [segment.storageColumn, segment.showOnLines]))
    const storageForRowKey: Record<string, string> = {
      departmentId: 'department_id', projectId: 'project_id', locationId: 'location_id', classId: 'class_id',
    }
    return cols.filter((column) => {
      const storage = storageForRowKey[String(column.key)]
      return !storage || lineVisibility.get(storage) !== false
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, departments, projects, taxProfiles, lineDefs, segments, builtinSegments, config, t, tCommon, warehouseColumn, returnSourceColumn])

  const field = 'space-y-1.5'
  const accountName = (id: unknown): string => {
    if (!id) return '—'
    const a = [...(cardAccounts ?? []), ...(bankAccounts ?? accounts)].find((x) => x.id === id) ?? accounts.find((x) => x.id === id)
    return a ? `${a.number ?? ''} ${a.name ?? ''}`.trim() : String(id)
  }
  // Settlement-currency restrictions keyed by account, across every picker
  // list the form can reference (F-t06-002).
  const currencyRestrictionById = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const a of [...(cardAccounts ?? []), ...(bankAccounts ?? accounts), ...accounts]) {
      if (!map.has(a.id)) map.set(a.id, a.currency_restriction ?? null)
    }
    return map
  }, [accounts, bankAccounts, cardAccounts])
  // Collect the accounts this save would actually insert (zero legs never
  // reach the ledger — the kernel drops them before the trigger runs) and
  // prove each one against the document currency.
  const currencyMismatch = (): CurrencyMismatchedAccount | null => {
    const lines = (payload_ as { lines?: { accountId?: unknown; amount?: unknown }[] }).lines ?? []
    const refs = lines
      .filter((l) => typeof l.amount === 'string' && l.amount !== '' && Number(l.amount) !== 0)
      .map((l) => ({ accountId: l.accountId, label: accountName(l.accountId) }))
    const override = customValues.controlAccountId
    if (typeof override === 'string' && override) {
      refs.push({ accountId: override, label: accountName(override) })
    }
    return findCurrencyMismatchedAccount(doc.currency, refs, currencyRestrictionById)
  }
  const blockCurrencyMismatch = (): boolean => {
    const mismatch = currencyMismatch()
    if (!mismatch) return false
    const message = t('drawer.currencyMismatch', {
      account: mismatch.label,
      allowed: mismatch.allowed,
      actual: String(doc.currency),
    })
    // A refusal the operator can trigger stays on the record, not only in
    // a toast: the typed reason pins as an alert until the next action.
    refuse(message, t('toasts.actionFailed'))
    return true
  }
  // Card-instrument fallback (F-t05-020): no UI creates payment_cards rows,
  // so with zero instruments the instrument picker is unfillable. Offer the
  // reconcilable card-liability accounts as the controlAccountId override
  // the engine cardRule reads first; name what qualifies when those are
  // absent too. Unused while instruments exist.
  const cardAccountFallback = (editable: boolean) => {
    if (editable) {
      return (cardAccounts ?? []).length > 0 ? (
        <>
          <SearchSelect
            options={(cardAccounts ?? []).map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() }))}
            value={(customValues.controlAccountId as string) ?? ''}
            onChange={(v) => setCustomValues((c) => ({ ...c, controlAccountId: v ?? '' }))}
            placeholder={t('drawer.accountPlaceholder')}
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('drawer.cardAccountHelp')}</p>
        </>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t('drawer.noCardAccounts')}{' '}
          <Link href="/accounts" className="font-medium text-teal-700 hover:underline dark:text-teal-300">
            {t('drawer.noCardAccountsCta')}
          </Link>
        </p>
      )
    }
    return <p className="text-sm">{accountName(customValues.controlAccountId)}</p>
  }
  // Header party picker role: a mandatory partyRole, else an opt-in payee
  // (optionalPartyRole) that never blocks save/submit/post or the server edit
  // guard — both key off config.partyRole alone.
  const pickerPartyRole = config.partyRole ?? config.optionalPartyRole ?? null
  const partyLabel = pickerPartyRole === 'customer' ? tCommon('labels.customer') : tCommon('labels.vendor')
  const partyPlaceholder = pickerPartyRole === 'customer' ? t('drawer.selectCustomerPlaceholder') : t('drawer.selectVendorPlaceholder')

  // -- layout-driven path: header via <HeaderFields> + line columns from the
  //    resolved FormLayoutConfig. The hardcoded path is a defensive fallback
  //    for callers that have not resolved a tenant form yet. -----------------
  const useLayout = !!layout

  // A multi-subsidiary org's transaction must ALWAYS show its subsidiary, even
  // if a user-customized layout hides the field — mirror how required built-ins
  // render by force-showing it after the layout groups.
  const layoutShowsSubsidiary =
    !!layout && layout.header.groups.some((g) => g.fields.some((f) => f.key === 'subsidiary_id' && f.visible))

  const cfColumns = useMemo(() => {
    const m = new Map<string, LineGridColumn<LineRow>>()
    for (const c of customFieldColumns<LineRow>(lineDefs)) m.set(c.key, c)
    return m
  }, [lineDefs])

  const columnsFromLayout = useMemo<LineGridColumn<LineRow>[]>(() => {
    if (!layout) return columns
    const builtIn: Record<string, Omit<LineGridColumn<LineRow>, 'label'>> = {
      account_id: {
        key: 'accountId', width: 'minmax(200px,2fr)', type: 'search-select', required: true,
        options: accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() })),
        placeholder: t('drawer.accountPlaceholder'),
      },
      item_id: {
        key: 'itemId', width: 'minmax(150px,1.4fr)', type: 'search-select',
        options: (items ?? []).map((it) => ({ value: it.id, label: `${it.code ? it.code + ' ' : ''}${it.name ?? ''}`.trim() })), placeholder: '—',
      },
      description: { key: 'description', width: 'minmax(160px,1.6fr)', type: 'text' },
      quantity: { key: 'quantity', width: '90px', type: 'decimal', decimalScale: 8, align: 'right' },
      unit: { key: 'unit', width: '80px', type: 'text' },
      unit_price: { key: 'unitPrice', width: '110px', type: 'decimal', decimalScale: 8, align: 'right' },
      cost_rate: { key: 'costRate', width: '110px', type: 'readonly', align: 'right', render: (row) => displayLineDecimal(row.costRate, 8) },
      bill_rate: { key: 'billRate', width: '110px', type: 'readonly', align: 'right', render: (row) => displayLineDecimal(row.billRate, 8) },
      bill_amount: { key: 'billAmount', width: '120px', type: 'readonly', align: 'right', render: (row) => money(row.billAmount, { currency: doc.currency }) },
      is_billable: {
        key: 'isBillable',
        width: '90px',
        type: 'readonly',
        render: (row) => row.isBillable ? tCommon('labels.yes') : tCommon('labels.no'),
      },
      department_id: {
        key: 'departmentId', width: '140px', type: 'select',
        options: [{ value: '', label: '—' }, ...departments.map((d) => ({ value: d.id, label: d.name ?? '' }))],
      },
      project_id: {
        key: 'projectId', width: 'minmax(150px,1.2fr)', type: 'search-select',
        options: projects.map((p) => ({ value: p.id, label: p.name ?? '' })), placeholder: '—',
      },
      location_id: {
        key: 'locationId', width: '140px', type: 'select',
        options: [{ value: '', label: '—' }, ...(locations ?? []).map((l) => ({ value: l.id, label: l.name ?? '' }))],
      },
      class_id: {
        key: 'classId', width: '140px', type: 'select',
        options: [{ value: '', label: '—' }, ...(classes ?? []).map((c) => ({ value: c.id, label: c.name ?? '' }))],
      },
      tax_code_id: {
        key: 'taxProfileId', width: '110px', type: 'select',
        options: [{ value: '', label: t('drawer.noTax') }, ...taxProfiles.map((profile) => ({ value: profile.value, label: profile.code ?? '' }))],
      },
      amount: { key: 'amount', width: '120px', type: 'amount', align: 'right', required: true },
      tax_amount: {
        key: 'taxAmount', width: '120px', type: 'tax', align: 'right', computeTax: lineTax,
        onTaxChange: (index, next) =>
          setRows((prev) => prev.map((r, j) => (j === index ? { ...r, taxOverridden: next.overridden, taxAmount: next.taxAmount } : r))),
      },
    }
    const defLabel: Record<string, string> = {
      account_id: t('drawer.accountColumn'),
      item_id: tCommon('labels.item'),
      description: tCommon('labels.description'),
      quantity: tCommon('labels.quantity'),
      unit: tCommon('labels.unit'),
      unit_price: tCommon('labels.unitPrice'),
      cost_rate: tCommon('labels.costRate'),
      bill_rate: tCommon('labels.billRate'),
      bill_amount: tCommon('labels.billAmount'),
      is_billable: tCommon('labels.billable'),
      department_id: tCommon('labels.department'),
      project_id: tCommon('labels.project'),
      location_id: tCommon('labels.location'),
      class_id: tCommon('labels.class'),
      tax_code_id: tCommon('labels.tax'),
      amount: tCommon('labels.amount'),
      tax_amount: t('drawer.taxAmountColumn'),
    }
    const configured = layout.lines.columns
      .filter((p: LineColumnPlacement) => p.visible && builtinSegments.find((segment) => segment.storageColumn === p.key)?.showOnLines !== false)
      .map((p): LineGridColumn<LineRow> | null => {
        if (isCustomFieldKey(p.key)) {
          const base = cfColumns.get(p.key)
          if (!base) return null
          return { ...base, width: p.width ?? base.width, label: p.labelOverride?.trim() ? p.labelOverride.trim() : base.label }
        }
        const base = builtIn[p.key]
        if (!base) return null
        const meta = recordType ? lineFieldMeta(recordType, p.key) : undefined
        return {
          ...base,
          width: p.width ?? base.width,
          required: meta?.required ?? (base as { required?: boolean }).required,
          label: p.labelOverride?.trim() ? p.labelOverride.trim() : (defLabel[p.key] ?? p.key),
        }
      })
      .filter((c): c is LineGridColumn<LineRow> => c !== null)
    // The warehouse and return pickers are force-shown like the subsidiary
    // header field: tenant layouts predate those keys, so placement alone
    // would hide them.
    return [
      ...configured,
      ...(warehouseColumn ? [warehouseColumn] : []),
      ...(returnSourceColumn ? [returnSourceColumn] : []),
      ...columns.filter((column) => String(column.key).startsWith('seg_')),
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, accounts, departments, projects, locations, classes, items, taxProfiles, lineDefs, cfColumns, columns, recordType, builtinSegments, t, tCommon, warehouseColumn, returnSourceColumn])

  const headerDefByDefKey = useMemo(() => new Map(headerDefs.map((d) => [d.key, d])), [headerDefs])
  const defLabelForHeader = (key: string): string => {
    switch (key) {
      case 'party_id': return partyLabel
      case 'payment_card_id': return t('drawer.card')
      case 'document_date': return t('drawer.dateLabel')
      case 'due_date': return t('drawer.dueDate')
      case 'reference_number': return t('drawer.reference')
      case 'memo': return tCommon('labels.memo')
      case 'posting_date': return tCommon('labels.postingDate')
      case 'department_id': return tCommon('labels.department')
      case 'project_id': return tCommon('labels.project')
      case 'location_id': return tCommon('labels.location')
      case 'class_id': return tCommon('labels.class')
      case 'subsidiary_id': return tCommon('labels.subsidiary')
      case 'expected_pay_date': return tCommon('labels.expectedPayDate')
      case 'payment_hold_reason': return tCommon('labels.paymentHold')
      case 'internal_notes': return tCommon('labels.internalNotes')
      case 'billing_method': return tCommon('labels.billingMethod')
      case 'is_final_invoice': return tCommon('labels.finalInvoice')
      default:
        if (isCustomFieldKey(key)) return headerDefByDefKey.get(customFieldDefKey(key))?.label ?? key
        return key
    }
  }

  // Look up a dimension/entity display name for read-only header rendering.
  const optName = (opts: Opt[] | undefined, id: unknown): string =>
    (opts ?? []).find((o) => o.id === id)?.name ?? (opts ?? []).find((o) => o.id === id)?.display_name ?? '—'

  const renderHeaderField = (p: HeaderFieldPlacement, isEditable: boolean): React.ReactNode => {
    if (builtinSegments.find((segment) => segment.storageColumn === p.key)?.showOnHeader === false) return null
    const label = p.labelOverride?.trim() ? p.labelOverride.trim() : defLabelForHeader(p.key)
    const required = p.required === true
    switch (p.key) {
      case 'party_id':
        return (
          <>
            <FieldLabel fieldName={label}>{label}{required && isEditable ? <span className="text-red-500"> *</span> : null}</FieldLabel>
            {isEditable ? (
              <SearchSelect
                options={(parties ?? []).map((v) => ({ value: v.id, label: v.display_name ?? '' }))}
                value={partyId}
                onChange={changeParty}
                placeholder={partyPlaceholder}
              />
            ) : (<p className="text-sm">{doc.party_name}</p>)}
          </>
        )
      case 'payment_card_id': {
        const savedCardName = (cards ?? []).find((c) => c.id === doc.payment_card_id)?.display_name ?? doc.payment_card_id
        return (
          <>
            <FieldLabel fieldName={label}>{label}{required && isEditable ? <span className="text-red-500"> *</span> : null}</FieldLabel>
            {isEditable ? (
              (cards ?? []).length > 0 ? (
                <SearchSelect
                  options={(cards ?? []).map((c) => ({ value: c.id, label: c.display_name ?? c.label ?? '' }))}
                  value={paymentCardId}
                  onChange={(v) => setPaymentCardId(v ?? '')}
                  placeholder={t('drawer.selectCardPlaceholder')}
                />
              ) : (
                cardAccountFallback(true)
              )
            ) : (
              savedCardName ? (
                <p className="text-sm">{savedCardName}</p>
              ) : (
                cardAccountFallback(false)
              )
            )}
          </>
        )
      }
      case 'document_date':
        return (
          <>
            <FieldLabel fieldName={label}>{label}</FieldLabel>
            {isEditable ? (
              <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
            ) : (<p className="text-sm">{doc.document_date}</p>)}
          </>
        )
      case 'due_date':
        return (
          <>
            <FieldLabel fieldName={label}>{label}</FieldLabel>
            {isEditable ? (
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            ) : (<p className="text-sm">{doc.due_date ?? '—'}</p>)}
          </>
        )
      case 'reference_number':
        return (
          <>
            <FieldLabel fieldName={label}>{label}</FieldLabel>
            {isEditable ? (
              <Input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} />
            ) : (<p className="text-sm">{doc.reference_number ?? '—'}</p>)}
          </>
        )
      case 'memo':
        return (
          <>
            <FieldLabel fieldName={label}>{label}</FieldLabel>
            {isEditable ? (
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            ) : (<p className="text-sm">{doc.memo ?? '—'}</p>)}
          </>
        )
      case 'posting_date':
        return (
          <>
            <FieldLabel fieldName={label}>{label}</FieldLabel>
            {isEditable ? (
              <Input type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} />
            ) : (<p className="text-sm">{doc.posting_date ?? '—'}</p>)}
          </>
        )
      case 'expected_pay_date':
        return (
          <>
            <FieldLabel fieldName={label}>{label}</FieldLabel>
            {isEditable ? (
              <Input type="date" value={expectedPayDate} onChange={(e) => setExpectedPayDate(e.target.value)} />
            ) : (<p className="text-sm">{doc.expected_pay_date ?? '—'}</p>)}
          </>
        )
      case 'department_id':
        return (
          <>
            <FieldLabel fieldName={label}>{label}</FieldLabel>
            {isEditable ? (
              <SearchSelect options={(departments ?? []).map((d) => ({ value: d.id, label: d.name ?? '' }))} value={departmentId} onChange={(v) => setDepartmentId(v ?? '')} placeholder="—" />
            ) : (<p className="text-sm">{optName(departments, doc.department_id)}</p>)}
          </>
        )
      case 'project_id':
        return (
          <>
            <FieldLabel fieldName={label}>{label}</FieldLabel>
            {isEditable && config.kind !== 'project_charge' ? (
              <SearchSelect options={(projects ?? []).map((pr) => ({ value: pr.id, label: pr.name ?? '' }))} value={projectIdHeader} onChange={(v) => setProjectIdHeader(v ?? '')} placeholder="—" />
            ) : (<p className="text-sm">{optName(projects, doc.project_id)}</p>)}
          </>
        )
      case 'location_id':
        return (
          <>
            <FieldLabel fieldName={label}>{label}</FieldLabel>
            {isEditable ? (
              <SearchSelect options={(locations ?? []).map((l) => ({ value: l.id, label: l.name ?? '' }))} value={locationId} onChange={(v) => setLocationId(v ?? '')} placeholder="—" />
            ) : (<p className="text-sm">{optName(locations, doc.location_id)}</p>)}
          </>
        )
      case 'class_id':
        return (
          <>
            <FieldLabel fieldName={label}>{label}</FieldLabel>
            {isEditable ? (
              <SearchSelect options={(classes ?? []).map((c) => ({ value: c.id, label: c.name ?? '' }))} value={classId} onChange={(v) => setClassId(v ?? '')} placeholder="—" />
            ) : (<p className="text-sm">{optName(classes, doc.class_id)}</p>)}
          </>
        )
      case 'subsidiary_id': {
        // HARD RULE: no subsidiary UI in single-subsidiary orgs, even if a
        // form layout carries the field. Locked (read-only) once posted — the
        // subsidiary shapes the GL and intercompany balancing.
        // An unset subsidiary reads as unset (F-t03-003): the empty option
        // must never borrow the root name, or the picker lists "Main Co"
        // twice and the pre-selected entry saves as null.
        if (!multiSub) return null
        return (
          <>
            <FieldLabel fieldName={label}>{label}</FieldLabel>
            {isEditable && !isPosted && config.kind !== 'project_charge' ? (
              <SearchSelect
                options={subsidiaryOpts}
                value={subsidiaryId}
                onChange={(v) => setSubsidiaryId(v ?? '')}
                clearable
                placeholder="—"
              />
            ) : (<p className="text-sm">{subsidiaryId ? subsidiaryName(subsidiaryId) : '—'}</p>)}
          </>
        )
      }
      case 'payment_hold_reason':
        return (
          <>
            <FieldLabel fieldName={label}>{label}</FieldLabel>
            {isEditable ? (
              <Input value={paymentHoldReason} onChange={(e) => setPaymentHoldReason(e.target.value)} />
            ) : (<p className="text-sm">{doc.payment_hold_reason ?? '—'}</p>)}
          </>
        )
      case 'internal_notes':
        return (
          <>
            <FieldLabel fieldName={label}>{label}</FieldLabel>
            {isEditable ? (
              <Input value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} />
            ) : (<p className="text-sm">{doc.internal_notes ?? '—'}</p>)}
          </>
        )
      case 'billing_method':
        return (
          <>
            <FieldLabel fieldName={label}>{label}</FieldLabel>
            {isEditable ? (
              <Select value={billingMethod} onChange={(e) => setBillingMethod(e.target.value)}>
                <option value="">—</option>
                <option value="time_and_materials">{tCommon('billingMethods.timeAndMaterials')}</option>
                <option value="fixed_price">{tCommon('billingMethods.fixedPrice')}</option>
              </Select>
            ) : (
              <p className="text-sm">
                {doc.billing_method === 'time_and_materials' ? tCommon('billingMethods.timeAndMaterials') : doc.billing_method === 'fixed_price' ? tCommon('billingMethods.fixedPrice') : '—'}
              </p>
            )}
          </>
        )
      case 'is_final_invoice':
        return (
          <>
            <FieldLabel fieldName={label}>{label}</FieldLabel>
            {isEditable ? (
              <label className="flex h-9 items-center gap-2 text-sm">
                <input type="checkbox" checked={isFinalInvoice} onChange={(e) => setIsFinalInvoice(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500" />
                {tCommon('labels.finalInvoice')}
              </label>
            ) : (<p className="text-sm">{doc.is_final_invoice ? tCommon('labels.yes') : tCommon('labels.no')}</p>)}
          </>
        )
      default:
        if (isCustomFieldKey(p.key)) {
          const defKey = customFieldDefKey(p.key)
          const def = headerDefByDefKey.get(defKey)
          if (!def) return null
          // The other agent's <CustomFieldInput> renders its own Label + control
          // + help text (and honours displayMode/readOnly), so the layout cell
          // only contributes the col-span placement. A labelOverride on the
          // placement is applied by swapping the def's label for this render.
          const fieldDef = p.labelOverride?.trim()
            ? { ...def, label: p.labelOverride.trim(), isRequired: p.required === true ? true : def.isRequired }
            : p.required === true
              ? { ...def, isRequired: true }
              : def
          return (
            <CustomFieldInput
              def={fieldDef}
              value={customValues[defKey]}
              onChange={(v) => setCustomValues((c) => ({ ...c, [defKey]: v }))}
              readOnly={!isEditable}
            />
          )
        }
        return null
    }
  }

  // Per-record "Custom Form" picker (view mode) — switch the form layout for
  // this record, optionally set it as the user's preferred form.
  async function setPreferredForm(layoutId: string | null) {
    if (!recordType) return
    await execute(
      () =>
        fetchAction('/api/customization/form-preferences', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recordType, layoutId }),
        }),
      {
        fallbackMessage: t('drawer.formPreferredFailed'),
        successMessage: layoutId ? t('drawer.formSetPreferredDone') : t('drawer.formPreferredCleared'),
      },
    )
  }
  const showFormPicker = !editable && !!availableLayouts && availableLayouts.length > 0 && !!recordType

  // Deep link into the form designer for this record type — straight to the
  // active layout when one is applied, otherwise the record type's forms tab.
  const customizeHref =
    canCustomize && recordType
      ? `/admin/customization?recordType=${encodeURIComponent(recordType)}&tab=forms${currentLayoutId ? `&form=${currentLayoutId}` : ''}`
      : null

  const actionLayout = layout?.actions ?? FORM_ACTION_KEYS.map((key) => ({ key, visible: true }))
  const renderFormAction = (key: string) => {
    switch (key) {
      case 'customize':
        return customizeHref ? (
          <Button variant="ghost" asChild>
            <Link href={customizeHref}>{tCommon('actions.customize')}</Link>
          </Button>
        ) : null
      case 'pdf':
        return PDF_RECORD_TYPE_BY_KEY[recordType ?? String(doc.kind)] ? (
          <PdfButton recordType={recordType ?? String(doc.kind)} recordId={String(doc.id)} />
        ) : null
      case 'workflow':
        return <FlowManualButtons subjectKind={String(doc.kind)} subjectId={String(doc.id)} />
      case 'approval':
        return <ApprovalActions subjectKind={String(doc.kind)} subjectId={String(doc.id)} />
      case 'submit':
        return isDraft && canCreate && !config.directPost ? (
          <Button disabled={busy || (config.partyRole ? !partyId : false) || !positiveAmount(effectiveTotals.total)} onClick={() => act('submit')}>
            {t('actions.submitForApproval')}
          </Button>
        ) : null
      case 'post':
        return (isDraft && canCreate && config.directPost) || (doc.status === 'approved' && canPost) ? (
          <Button disabled={busy || (isDraft && !positiveAmount(effectiveTotals.total))} onClick={() => act('post')}>
            {tCommon('actions.post')}
          </Button>
        ) : null
      case 'void':
        return (doc.status === 'approved' || doc.status === 'posted') && canPost ? (
          <Button variant="ghost" disabled={busy} onClick={voidDocument} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40">
            {tCommon('actions.void')}
          </Button>
        ) : null
      case 'gl_impact':
        return doc.entry_id ? (
          <Button variant="outline" asChild>
            <JournalEntryLink entryId={doc.entry_id}>{t('drawer.viewGlImpact')}</JournalEntryLink>
          </Button>
        ) : null
      case 'delete':
        return doc.status === 'draft' && canCreate ? (
          <Button variant="ghost" disabled={busy} onClick={remove} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40">
            {tCommon('actions.delete')}
          </Button>
        ) : null
      default:
        return null
    }
  }

  return (
    <TransactionDrawer
      closeHref={basePath}
      beforeClose={confirmDiscard}
      recordId={String(doc.id)}
      showEvidenceTabs={!isCreate}
      canEditAttachments={isCreate ? false : canCreate}
      panelClassName={docTypeMeta(config.kind).surfaceCls}
      title={
        <DocumentDrawerTitle
          kind={config.kind}
          documentNumber={displayDocumentNumber(doc.document_number, doc.reference_number)}
          statusLabel={STATUS_KEYS[displayStatus]
            ? tCommon(`status.${STATUS_KEYS[displayStatus]}`)
            : String(displayStatus).replace('_', ' ')}
          statusVariant={STATUS_VARIANT[displayStatus] ?? 'secondary'}
        />
      }
      description={mode === 'edit' ? t('drawer.editingHint') : (doc.party_name ?? undefined)}
      primaryAction={
        canEditStatus ? (
          mode === 'edit' ? (
            <>
              <Button size="sm" className="h-8 px-2.5 text-xs" disabled={busy} onClick={() => void save()}>
                {busy ? tCommon('actions.saving') : tCommon('actions.save')}
              </Button>
              <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs" disabled={busy} onClick={cancelWithConfirm}>
                {tCommon('actions.cancel')}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs" disabled={busy} onClick={() => setMode('edit')}>
              {tCommon('actions.edit')}
            </Button>
          )
        ) : null
      }
      actionsMenuHeader={showFormPicker ? (
        <div className="mb-1.5 space-y-1.5 border-b border-slate-100 px-1 pb-2 dark:border-slate-800">
          <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            {t('drawer.formLabel')}
          </span>
          <Select
            value={currentLayoutId ?? ''}
            onChange={(e) => router.push(hrefForDocument(String(doc.id), e.target.value))}
            aria-label={t('drawer.formLabel')}
            triggerClassName="!h-8 !min-h-0 !px-2 !py-0 !text-xs"
          >
            {availableLayouts!.map((availableLayout) => (
              <option key={availableLayout.id} value={availableLayout.id}>{displayFormName(availableLayout.name, availableLayout.isDefault, tCommon('labels.defaultForm'))}</option>
            ))}
          </Select>
          <Button
            variant="ghost"
            size="sm"
            className="!h-8 w-full !justify-start !px-2 !text-xs"
            onClick={() => setPreferredForm(currentLayoutId ?? null)}
            disabled={!currentLayoutId}
          >
            {t('drawer.formSetPreferred')}
          </Button>
        </div>
      ) : null}
      actions={
        mode === 'edit' ? (
          <>
            {actionLayout.find((action) => action.key === 'customize')?.visible ? renderFormAction('customize') : null}
          </>
        ) : (
          <>
            {actionLayout.filter((action) => action.visible && action.key !== 'edit').map((action) => (
              <Fragment key={action.key}>{renderFormAction(action.key)}</Fragment>
            ))}
            {(doc.kind === 'customer_invoice' || doc.kind === 'customer_credit') && canCreate ? (
              <SendButton recordType={String(doc.kind)} recordId={String(doc.id)} />
            ) : null}
          </>
        )
      }
      footer={
        <div className="flex w-full items-center gap-3">
          <span
            className={
              'text-xs ' +
              (saveState === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')
            }
          >
            {mode === 'edit'
              ? saveState === 'saving'
                ? tCommon('actions.saving')
                : saveState === 'error'
                  ? t('drawer.saveState.error')
                  : dirty
                    ? t('drawer.saveState.dirty')
                    : null
              : null}
          </span>
          <span className="flex-1" />
          <span className="text-sm text-slate-600 tabular-nums dark:text-slate-300">
            {t('drawer.subtotalAmount', { amount: money(effectiveTotals.subtotal, { currency: doc.currency }) })}
            {config.hasTax ? <> · {t('drawer.taxTotalAmount', { amount: money(effectiveTotals.taxTotal, { currency: doc.currency }) })}</> : null}
            {' · '}
            <strong className="text-slate-900 dark:text-slate-100">
              {t('drawer.totalAmount', { amount: money(effectiveTotals.total, { currency: doc.currency }) })}
            </strong>
            {isPosted && config.showsBalance ? (
              <>
                {' · '}
                <strong className="text-slate-900 dark:text-slate-100">
                  {t('drawer.balanceDueAmount', { amount: money(doc.balance_due, { currency: doc.currency }) })}
                </strong>
              </>
            ) : null}
          </span>
        </div>
      }
    >
      <div className="space-y-6 p-1">
        <ActionAlert error={refusal} fallbackMessage={t('toasts.actionFailed')} />
        {isTransfer ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className={field}>
              <FieldLabel fieldName={t('drawer.transferAmount')}>{t('drawer.transferAmount')}{editable ? <span className="text-red-500"> *</span> : null}</FieldLabel>
              {editable ? <Input type="number" step="0.01" value={transfer?.amount ?? ''} onChange={(e) => setTransfer((p) => ({ ...p!, amount: e.target.value }))} /> : <p className="text-sm tabular-nums">{money(lineText(payload.lines[0]?.amount), { currency: doc.currency })}</p>}
            </div>
            <div className={field}>
              <FieldLabel fieldName={t('drawer.toAccount')}>{t('drawer.toAccount')}{editable ? <span className="text-red-500"> *</span> : null}</FieldLabel>
              {editable ? <SearchSelect options={(bankAccounts ?? accounts).map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() }))} value={transfer?.toAccount ?? ''} onChange={(v) => setTransfer((p) => ({ ...p!, toAccount: v ?? '' }))} placeholder={t('drawer.accountPlaceholder')} /> : <p className="text-sm">{accountName(payload.lines[0]?.account_id)}</p>}
            </div>
            <div className={field}>
              <FieldLabel fieldName={t('drawer.fromAccount')}>{t('drawer.fromAccount')}{editable ? <span className="text-red-500"> *</span> : null}</FieldLabel>
              {editable ? <SearchSelect options={(bankAccounts ?? accounts).map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() }))} value={transfer?.fromAccount ?? ''} onChange={(v) => setTransfer((p) => ({ ...p!, fromAccount: v ?? '' }))} placeholder={t('drawer.accountPlaceholder')} /> : <p className="text-sm">{accountName(payload.lines[1]?.account_id)}</p>}
            </div>
          </div>
        ) : null}

        {config.fundingSource === 'bank' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className={field}>
              <FieldLabel fieldName={config.kind === 'deposit' ? t('drawer.depositTo') : t('drawer.fromAccount')}>{config.kind === 'deposit' ? t('drawer.depositTo') : t('drawer.fromAccount')}{editable ? <span className="text-red-500"> *</span> : null}</FieldLabel>
              {editable ? (
                // Zero bank accounts is valid data (a fresh org), not a broken
                // source: name it with a way forward instead of a dead
                // 'No matches' picker with no search.
                (bankAccounts ?? accounts).length > 0 ? (
                  <SearchSelect options={(bankAccounts ?? accounts).map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() }))} value={(customValues.controlAccountId as string) ?? ''} onChange={(v) => setCustomValues((c) => ({ ...c, controlAccountId: v ?? '' }))} placeholder={t('drawer.accountPlaceholder')} />
                ) : (
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {t('drawer.noBankAccounts')}{' '}
                    <Link href="/banking" className="font-medium text-teal-700 hover:underline dark:text-teal-300">
                      {t('drawer.noBankAccountsCta')}
                    </Link>
                  </p>
                )
              ) : <p className="text-sm">{accountName(customValues.controlAccountId as string)}</p>}
            </div>
          </div>
        ) : null}

        {useLayout ? (
          <>
            <HeaderFields layout={layout!} editable={editable} renderField={renderHeaderField} />
            {multiSub && !layoutShowsSubsidiary ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className={field}>{renderHeaderField({ key: 'subsidiary_id', visible: true }, editable)}</div>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {pickerPartyRole ? (
                <div className={`${field} lg:col-span-2`}>
                  <FieldLabel fieldName={partyLabel}>{partyLabel}{editable && config.partyRole ? <span className="text-red-500"> *</span> : null}</FieldLabel>
                  {editable ? (
                    <SearchSelect
                      options={(parties ?? []).map((p) => ({ value: p.id, label: p.display_name ?? '' }))}
                      value={partyId}
                      onChange={changeParty}
                      placeholder={partyPlaceholder}
                    />
                  ) : (
                    <p className="text-sm">{doc.party_name}</p>
                  )}
                </div>
              ) : null}

              {config.fundingSource === 'card' ? (
                <div className={`${field} lg:col-span-2`}>
                  <FieldLabel fieldName={t('drawer.card')}>{t('drawer.card')}{editable ? <span className="text-red-500"> *</span> : null}</FieldLabel>
                  {(() => {
                    const savedCardName = (cards ?? []).find((c) => c.id === doc.payment_card_id)?.display_name ?? doc.payment_card_id
                    if (editable) {
                      return (cards ?? []).length > 0 ? (
                        <SearchSelect
                          options={(cards ?? []).map((c) => ({ value: c.id, label: c.display_name ?? c.label ?? '' }))}
                          value={paymentCardId}
                          onChange={(v) => setPaymentCardId(v ?? '')}
                          placeholder={t('drawer.selectCardPlaceholder')}
                        />
                      ) : (
                        cardAccountFallback(true)
                      )
                    }
                    return savedCardName ? (
                      <p className="text-sm">{savedCardName}</p>
                    ) : (
                      cardAccountFallback(false)
                    )
                  })()}
                </div>
              ) : null}

              {multiSub ? (
                <div className={field}>{renderHeaderField({ key: 'subsidiary_id', visible: true }, editable)}</div>
              ) : null}

              <div className={field}>
                <FieldLabel fieldName={t('drawer.dateLabel')}>{t('drawer.dateLabel')}</FieldLabel>
                {editable ? (
                  <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
                ) : (
                  <p className="text-sm">{doc.document_date}</p>
                )}
              </div>
              {config.hasDueDate ? (
                <div className={field}>
                  <FieldLabel fieldName={t('drawer.dueDate')}>{t('drawer.dueDate')}</FieldLabel>
                  {editable ? (
                    <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                  ) : (
                    <p className="text-sm">{doc.due_date ?? '—'}</p>
                  )}
                </div>
              ) : null}
              {config.hasReference ? (
                <div className={field}>
                  <FieldLabel fieldName={t('drawer.reference')}>{t('drawer.reference')}</FieldLabel>
                  {editable ? (
                    <Input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} />
                  ) : (
                    <p className="text-sm">{doc.reference_number ?? '—'}</p>
                  )}
                </div>
              ) : null}
              <div className={`${field} lg:col-span-3`}>
                <FieldLabel fieldName={tCommon('labels.memo')}>{tCommon('labels.memo')}</FieldLabel>
                {editable ? (
                  <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
                ) : (
                  <p className="text-sm">{doc.memo ?? '—'}</p>
                )}
              </div>
            </div>

            <CustomFieldInputs defs={headerDefs} values={customValues} onChange={setCustomValues} readOnly={!editable} />
          </>
        )}

        {segments.some((segment) => segment.showOnHeader) ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {segments.filter((segment) => segment.showOnHeader).map((segment) => {
              const selected = extraDims[segment.key] ?? ''
              const selectedLabel = segment.values.find((value) => value.id === selected)
              return (
                <div className={field} key={segment.key}>
                  <FieldLabel fieldName={segment.name}>{segment.name}</FieldLabel>
                  {editable ? (
                    <SearchSelect
                      options={segment.values.map((value) => ({
                        value: value.id,
                        label: `${value.code ? `${value.code} · ` : ''}${value.name}`,
                      }))}
                      value={selected}
                      onChange={(value) => setExtraDims((current) => ({ ...current, [segment.key]: value ?? '' }))}
                      placeholder="—"
                    />
                  ) : (
                    <p className="text-sm">{selectedLabel?.name ?? '—'}</p>
                  )}
                </div>
              )
            })}
          </div>
        ) : null}

        {!isTransfer ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <FieldLabel fieldName={tCommon('labels.lines')}>{tCommon('labels.lines')}</FieldLabel>
              {distOn && distEditable && distAuto.length > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={distApplying}
                  onClick={() => void applyDistAutomatic()}
                >
                  {tAlloc('entry.applyAutomatic')}
                </Button>
              ) : null}
            </div>
            <LineGrid<LineRow>
              columns={useLayout ? columnsFromLayout : columns}
              rows={rows}
              onRowsChange={handleGridRowsChange}
              emptyRow={emptyLine}
              getRowKey={(row, i) => row.clientKey !== '' ? row.clientKey : `row-${i}`}
              cloneRow={(row) => ({ ...row, clientKey: crypto.randomUUID() })}
              readOnly={!editable || config.kind === 'project_charge'}
              formatAmount={(value) => money(value, { currency: doc.currency })}
              distribution={distribution}
            />
          </div>
        ) : null}
        {splitTarget !== null && rows[splitTarget] ? (
          <DistributionDialog
            key={`${splitTarget}:${rows[splitTarget]!.amount}:${rows[splitTarget]!.distributionKey}`}
            open
            lineAmount={rows[splitTarget]!.amount || '0'}
            candidates={distLineMap.get(distCoordKey(rows[splitTarget]!)) ?? []}
            candidatesFailed={distLineFailed.has(distCoordKey(rows[splitTarget]!))}
            accountOptions={accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() }))}
            codings={distCodings}
            initialRuleKey={rows[splitTarget]!.distributionKey || null}
            onClose={() => setSplitTarget(null)}
            onApplyRule={applyDialogRule}
            onApplyChildren={applyDialogChildren}
          />
        ) : null}

        {mode === 'view' && !isCreate ? (
          // The record's tenant-authored Flow approval timeline. Renders
          // nothing when no approval flow applies. Never in create mode:
          // no persisted record exists to carry a timeline yet.
          <ApprovalHistory subjectKind={String(doc.kind)} subjectId={String(doc.id)} />
        ) : null}

        {mode === 'view' ? afterContent : null}

      </div>
    </TransactionDrawer>
  )
}
