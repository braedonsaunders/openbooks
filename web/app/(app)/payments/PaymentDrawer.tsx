'use client'

import { useMoney } from '@/components/money-provider'
import { initialDrawerMode, type DrawerMode } from '@/lib/drawer-mode'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Wand2 } from 'lucide-react'
import { Badge, Button, FieldLabel, Input, Label, SearchSelect } from '@openbooks/ui'
import { TransactionDrawer } from '../../../components/transaction-drawer'
import { DocTypeBadge, docTypeMeta } from '../../../components/doc-type-badge'
import { JournalEntryLink } from '../../../components/journal-entry-link'
import { PdfButton } from '../../../components/pdf-button'
import { SendButton } from '../../../components/send-button'
import { confirmDialog } from '../../../lib/confirm'
import { readApiErrorMessage } from '../../../lib/api-error'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { useAppAction } from '@/lib/use-app-action'
import { displayDocumentNumber } from '../../../lib/document-display'
import { HeaderFields } from '../../../components/transaction-form/header-fields'
import { FlowManualButtons } from '../../../components/flow-manual-buttons'
import { ApprovalActions } from '../../../components/approval-actions'
import { ApprovalHistory } from '../../../components/approval-history'
import { promptDialog } from '../../../lib/prompt'
import type { FormLayoutConfig, HeaderFieldPlacement } from '@openbooks/customization'
import { cmp, divRate, formatMoney, mulRate, normalizeMoney, sum } from '@openbooks/engine/src/money/money.ts'

/**
 * Shared payment/receipt flyout. side='ap' → vendor payment applying open
 * bills; side='ar' → customer receipt applying open invoices. Drafts
 * autosave; "Pay & post" / "Receive & post" is the explicit kernel action.
 */
type Opt = {
  id: string
  display_name?: string
  number?: string | null
  name?: string
};

export interface OpenItemClient {
  lineId: string
  entryNumber: string
  postingDate: string
  dueDate: string | null
  documentNumber: string | null
  documentKind: string | null
  referenceNumber: string | null
  amount: string
  applied: string
  open: string
  currency: string
  transactionAmount: string
  transactionApplied: string
  transactionOpen: string
}

interface AllocationClient {
  openLineId: string
  sourceTransactionAmount: string
  targetTransactionAmount: string
  targetBaseAmount?: string
  settlementRate: string
  settlementRateSource: 'same_currency' | 'provider' | 'manual' | 'contractual' | 'imported'
  settlementRateReference: string
  settlementFxRateId?: string | null
}

interface SettlementRateOption {
  id: string
  toCurrency: string
  rate: string
  asOf: string
  source: string
}

/** One live application on the payment, with the target line/document join —
 *  column types per the `applications` table (all NOT NULL) plus the joins
 *  (target document columns are null when the target has no document). */
export interface PaymentAppliedRow {
  id: string
  amount: string
  source_amount: string
  source_transaction_amount: string
  source_transaction_currency: string
  target_transaction_amount: string
  target_transaction_currency: string
  settlement_rate: string
  settlement_rate_source: string
  settlement_rate_reference: string
  applied_on: string
  target_entry_number: string
  target_posting_date: string
  target_due_date: string | null
  target_amount: string
  target_transaction_original: string
  target_document_id: string | null
  target_document_number: string | null
  target_document_kind: string | null
  target_reference_number: string | null
}

export interface PaymentPayload {
  doc: Record<string, unknown>
  bankAccountId: string | null
  allocations: AllocationClient[]
  /** Live applications as the loader hands them; narrowed to
   *  PaymentAppliedRow for rendering below. */
  applied: Record<string, unknown>[]
}

/** The payment header: `documents` plus the loader's joins. Dates, uuids
 *  and numerics arrive from the driver as strings; left-join columns stay
 *  nullable. Column nullability per schema (documents / parties /
 *  journal_entries / accounts). */
export interface PaymentDoc extends Record<string, unknown> {
  id: string
  kind: string
  status: string
  currency: string
  total: string
  document_number: string | null
  party_id: string | null
  party_name: string | null
  document_date: string | null
  reference_number: string | null
  memo: string | null
  updated_at: string
  entry_id: string | null
  bank_account_number: string | null
  bank_account_name: string | null
}

function docText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Narrow the engine loader's untyped document row to the header fields
 *  this drawer reads. Non-string values fall back to null (or '' for the
 *  NOT NULL columns); loader rows always carry strings here, so valid
 *  payloads pass through unchanged. */
export function asPaymentDoc(raw: Record<string, unknown>): PaymentDoc {
  return {
    ...raw,
    id: docText(raw.id) ?? '',
    kind: docText(raw.kind) ?? '',
    status: docText(raw.status) ?? '',
    currency: docText(raw.currency) ?? '',
    total: docText(raw.total) ?? '0',
    document_number: docText(raw.document_number),
    party_id: docText(raw.party_id),
    party_name: docText(raw.party_name),
    document_date: docText(raw.document_date),
    reference_number: docText(raw.reference_number),
    memo: docText(raw.memo),
    updated_at: docText(raw.updated_at) ?? '',
    entry_id: docText(raw.entry_id),
    bank_account_number: docText(raw.bank_account_number),
    bank_account_name: docText(raw.bank_account_name),
  }
}

/** Narrow one live-application row from the loader. All `applications`
 *  columns are NOT NULL (amounts/dates arrive as strings); the
 *  target-document columns are null when the target line has no document. */
export function asPaymentAppliedRow(raw: Record<string, unknown>): PaymentAppliedRow {
  const req = (value: unknown): string => docText(value) ?? ''
  return {
    ...raw,
    id: req(raw.id),
    amount: req(raw.amount),
    source_amount: req(raw.source_amount),
    source_transaction_amount: req(raw.source_transaction_amount),
    source_transaction_currency: req(raw.source_transaction_currency),
    target_transaction_amount: req(raw.target_transaction_amount),
    target_transaction_currency: req(raw.target_transaction_currency),
    settlement_rate: req(raw.settlement_rate),
    settlement_rate_source: req(raw.settlement_rate_source),
    settlement_rate_reference: req(raw.settlement_rate_reference),
    applied_on: req(raw.applied_on),
    target_entry_number: req(raw.target_entry_number),
    target_posting_date: req(raw.target_posting_date),
    target_due_date: docText(raw.target_due_date),
    target_amount: req(raw.target_amount),
    target_transaction_original: req(raw.target_transaction_original),
    target_document_id: docText(raw.target_document_id),
    target_document_number: docText(raw.target_document_number),
    target_document_kind: docText(raw.target_document_kind),
    target_reference_number: docText(raw.target_reference_number),
  }
}

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  posted: 'success',
  approved: 'success',
  pending_approval: 'warning',
  draft: 'secondary',
  voided: 'outline',
}

// document kind enum → payments.drawer.kind.* message keys (fallback: 'entry').
const KIND_KEY: Record<string, string> = {
  vendor_bill: 'vendorBill',
  customer_invoice: 'customerInvoice',
  expense_report: 'expenseReport',
  journal: 'journal',
}

// documents.status enum → common.status.* message keys (fallback: raw value).
const STATUS_LABEL_KEY: Record<string, string> = {
  draft: 'draft',
  pending_approval: 'pendingApproval',
  approved: 'approved',
  rejected: 'rejected',
  posted: 'posted',
  paid: 'paid',
  partially_paid: 'partiallyPaid',
  voided: 'voided',
  reversed: 'reversed',
  cancelled: 'cancelled',
}

export function PaymentDrawer({
  payment,
  initialMode = 'view',
  initialOpenItems,
  parties,
  bankAccounts,
  side,
  basePath,
  layout,
  createMode = false,
  closeHref,
  createTitle,
}: {
  payment: PaymentPayload
  initialMode?: DrawerMode
  initialOpenItems: OpenItemClient[]
  parties: Opt[]
  bankAccounts: Opt[]
  side: 'ap' | 'ar'
  basePath: string
  layout?: FormLayoutConfig
  /** Unsaved-create: no persisted row exists. Cancel/close navigate away
   *  with zero writes; Save is the first write (one idempotent POST). */
  createMode?: boolean
  /** List return URL — Cancel/close land here, and a successful Save opens
   *  the created payment over it. */
  closeHref?: string
  /** Surface label for the unsaved title (no number exists yet). The section
   *  already translates it per surface — no new keys. */
  createTitle?: string
}) {
  const { money } = useMoney()
  const t = useTranslations('payments.drawer')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const doc = asPaymentDoc(payment.doc)
  const applied = payment.applied.map(asPaymentAppliedRow)
  const isDraft = doc.status === 'draft'
  // Existing records default to read-only; newly created drafts can explicitly
  // request edit mode. Only DRAFT payments
  // are editable (posting is terminal — applications become ledger state). Save
  // is EXPLICIT — one Save button, no per-field autosave.
  const canEditStatus = isDraft
  const [mode, setMode] = useState<DrawerMode>(
    createMode ? 'edit' : initialDrawerMode(initialMode, canEditStatus),
  )
  const editable = mode === 'edit' && canEditStatus
  const returnHref = closeHref ?? basePath
  const requestIdRef = useRef<string | null>(null)
  const partyLabel = side === 'ap' ? tCommon('labels.vendor') : tCommon('labels.customer')
  const kindLabel = (kind: string | null) => {
    const key = KIND_KEY[kind ?? '']
    return key ? t(`kind.${key}`) : t('kind.entry')
  }
  const statusLabel = (status: string) => {
    const key = STATUS_LABEL_KEY[status]
    return key ? tCommon(`status.${key}`) : status.replace('_', ' ')
  }

  const [partyId, setPartyId] = useState<string>(doc.party_id ?? '')
  const [bankAccountId, setBankAccountId] = useState<string>(payment.bankAccountId ?? '')
  const [documentDate, setDocumentDate] = useState<string>(doc.document_date ?? '')
  const [referenceNumber, setReferenceNumber] = useState<string>(doc.reference_number ?? '')
  // Optional target for Auto-apply (AR receipts); does not change the posting —
  // the payment total is always the sum of what's actually applied.
  const [receivedAmount, setReceivedAmount] = useState<string>('')
  const [memo, setMemo] = useState<string>(doc.memo ?? '')
  const [openItems, setOpenItems] = useState<OpenItemClient[]>(initialOpenItems)
  const [loadingItems, setLoadingItems] = useState(false)
  const [allocs, setAllocs] = useState<Record<string, AllocationClient>>(() =>
    Object.fromEntries(payment.allocations.map((a) => [a.openLineId, a])),
  )
  const [settlementRates, setSettlementRates] = useState<SettlementRateOption[]>([])
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  // A refused save/post must stay visible past its toast (F-t02-006): the
  // typed refusal pins as a record-level alert until the next action, and
  // busy always releases through the shared path's finally.
  const { busy, refusal, execute, clearRefusal } = useAppAction()

  // -- open items follow the selected party --------------------------------
  // Reset the allocations (and enter the loading state) when the party
  // selection changes, during render (same committed values, no extra
  // render). Keyed on the fetch inputs below.
  const [prevPartyKeys, setPrevPartyKeys] = useState(() => ({ partyId, side, isDraft }))
  if (prevPartyKeys.partyId !== partyId || prevPartyKeys.side !== side || prevPartyKeys.isDraft !== isDraft) {
    setPrevPartyKeys({ partyId, side, isDraft })
    if (isDraft) {
      setAllocs({})
      if (!partyId) setOpenItems([])
      else setLoadingItems(true)
    }
  }
  // Mount-skip mirror: the mount pass keeps the passed initialOpenItems; only
  // post-mount party changes fetch. (Ref write in an effect — no setState, so
  // no cascade and no extra dep subscription.)
  const partyFetchArmed = useRef(false)
  useEffect(() => {
    if (!isDraft) return
    if (!partyFetchArmed.current) {
      partyFetchArmed.current = true
      return
    }
    if (!partyId) return
    let cancelled = false
    fetch(`/api/payments/open-items?partyId=${partyId}&side=${side}`)
      .then(async (res) => {
        if (cancelled) return
        if (!res.ok) {
          toast.error(await readApiErrorMessage(res, t('toasts.loadOpenItemsFailed')))
          return
        }
        const data = await res.json()
        if (!cancelled) setOpenItems(data.items ?? [])
      })
      .catch(() => {
        if (!cancelled) toast.error(t('toasts.loadOpenItemsFailed'))
      })
      .finally(() => {
        if (!cancelled) setLoadingItems(false)
      })
    return () => {
      cancelled = true
    }
  }, [partyId, side, isDraft, t])

  // Clear stale settlement rates while their inputs change, during render
  // (same committed values, no extra render). Keyed on the fetch inputs
  // below.
  const [prevSettlementKeys, setPrevSettlementKeys] = useState(() => ({
    currency: doc.currency, documentDate, openItems, side,
  }))
  if (
    prevSettlementKeys.currency !== doc.currency || prevSettlementKeys.documentDate !== documentDate ||
    prevSettlementKeys.openItems !== openItems || prevSettlementKeys.side !== side
  ) {
    setPrevSettlementKeys({ currency: doc.currency, documentDate, openItems, side })
    const staleTargets = [...new Set(openItems.filter((item) => item.currency !== doc.currency).map((item) => item.currency))]
    if (!staleTargets.length || !documentDate) setSettlementRates([])
  }

  useEffect(() => {
    const targets = [...new Set(openItems.filter((item) => item.currency !== doc.currency).map((item) => item.currency))]
    if (!targets.length || !documentDate) return
    let cancelled = false
    const query = new URLSearchParams({
      side,
      from: doc.currency,
      to: targets.join(','),
      date: documentDate,
    })
    fetch(`/api/payments/settlement-rates?${query}`)
      .then(async (response) => {
        if (cancelled || !response.ok) return
        const data = await response.json()
        if (!cancelled) setSettlementRates(data.rates ?? [])
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [doc.currency, documentDate, openItems, side])

  // useCallback: validAllocations below depends on this; a bare closure would be
  // a fresh identity every render and defeat that memo.
  const rowValid = useCallback((item: OpenItemClient) => {
    const allocation = allocs[item.lineId]
    if (allocation === undefined) return true
    try {
      const source = normalizeMoney(allocation.sourceTransactionAmount)
      const target = normalizeMoney(allocation.targetTransactionAmount)
      if (cmp(source, '0') <= 0 || cmp(target, '0') <= 0 || cmp(target, item.transactionOpen) > 0) return false
      if (cmp(mulRate(source, allocation.settlementRate), target) !== 0) return false
      if (!allocation.settlementRateReference.trim()) return false
      if (item.currency === doc.currency) {
        return cmp(source, target) === 0 && cmp(allocation.settlementRate, '1') === 0 && allocation.settlementRateSource === 'same_currency'
      }
      return allocation.settlementRateSource !== 'same_currency' &&
        (allocation.settlementRateSource !== 'provider' || !!allocation.settlementFxRateId)
    } catch {
      return false
    }
  }, [allocs, doc.currency])
  const validAllocations = useMemo(
    () =>
      openItems
        .filter((i) => allocs[i.lineId] !== undefined && rowValid(i))
        .map((i) => {
          const allocation = allocs[i.lineId]!
          return {
            ...allocation,
            sourceTransactionAmount: normalizeMoney(allocation.sourceTransactionAmount),
            targetTransactionAmount: normalizeMoney(allocation.targetTransactionAmount),
          }
        }),
    [allocs, openItems, rowValid],
  )
  const hasInvalidRow = openItems.some((i) => !rowValid(i))
  const displayedOpenItems = editable
    ? openItems
    : openItems.filter((item) => allocs[item.lineId] !== undefined)
  const total = sum(validAllocations.map((allocation) => allocation.sourceTransactionAmount))

  // -- explicit save (no autosave) -----------------------------------------
  const payload = useMemo(
    () => ({
      expectedUpdatedAt: doc.updated_at,
      partyId: partyId || null,
      bankAccountId: bankAccountId || null,
      documentDate: documentDate || undefined,
      referenceNumber,
      memo,
      allocations: validAllocations,
    }),
    [partyId, bankAccountId, documentDate, referenceNumber, memo, validAllocations, doc.updated_at],
  )
  // Track unsaved edits (no autosave — Save is an explicit button). Adjusted
  // during render (same committed value, no extra render). `editable` is read
  // but deliberately NOT subscribed: the gate fires only when `payload`
  // changes identity, so merely entering edit mode with untouched fields never
  // marks the form dirty (same guarantee as the ref-mirrored gate this
  // replaces, without the effect-body setState).
  const [dirty, setDirty] = useState(false)
  const [prevPayload, setPrevPayload] = useState(payload)
  if (prevPayload !== payload) {
    setPrevPayload(payload)
    if (editable) setDirty(true)
  }

  /** Reset every field back to the loaded document (used by Cancel). */
  function resetForm() {
    setPartyId(doc.party_id ?? '')
    setBankAccountId(payment.bankAccountId ?? '')
    setDocumentDate(doc.document_date ?? '')
    setReferenceNumber(doc.reference_number ?? '')
    setMemo(doc.memo ?? '')
    setAllocs(Object.fromEntries(payment.allocations.map((a) => [a.openLineId, a])))
  }

  /**
   * Unsaved-create Save: one idempotent POST carrying the whole payment —
   * kind (fixed by the entry surface), header, and applications. The key is
   * minted once per drawer session, so a double-click or a retried request
   * returns the same payment instead of a duplicate. Cancel/close before
   * this point wrote nothing — this is the first and only write, and the
   * PAY-/RCPT- number is allocated inside it.
   */
  async function saveNew() {
    if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID()
    setSaveState('saving')
    // The create body carries the kind (fixed by the surface: vendor_payment
    // on /payments, customer_payment on /receipts), never the PATCH revision
    // token — there is no row to version against here.
    const createBody = {
      kind: side === 'ap' ? 'vendor_payment' : 'customer_payment',
      partyId: partyId || null,
      bankAccountId: bankAccountId || null,
      documentDate: documentDate || undefined,
      referenceNumber,
      memo,
      allocations: validAllocations,
    }
    const ok = await execute(
      () =>
        fetchAction('/api/payments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestIdRef.current! },
          body: JSON.stringify(createBody),
        }),
      {
        fallbackMessage: t('toasts.postFailed'),
        onOk: (data) => {
          const createdId = (data as { doc?: { id?: unknown } } | null)?.doc?.id
          setSaveState('saved')
          setDirty(false)
          if (typeof createdId === 'string' && createdId) {
            const separator = returnHref.includes('?') ? '&' : '?'
            router.replace(`${returnHref}${separator}payment=${createdId}` as never)
          } else {
            router.push(returnHref as never)
          }
          router.refresh()
        },
        onRefused: () => {
          // Stay in edit mode with the typed values intact: the form is
          // still dirty, nothing was persisted, the pin carries the reason.
          setSaveState('error')
        },
      },
    )
    if (ok) router.refresh()
  }

  async function save() {
    if (createMode) {
      await saveNew()
      return
    }
    setSaveState('saving')
    const ok = await execute(
      () =>
        fetchAction(`/api/payments/${doc.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      {
        fallbackMessage: t('toasts.postFailed'),
        onOk: () => {
          setSaveState('saved')
          setDirty(false)
          setMode('view')
        },
        onRefused: () => {
          setSaveState('error')
        },
      },
    )
    if (ok) router.refresh()
  }

  function cancel() {
    // Unsaved-create Cancel writes nothing: there is no persisted row to
    // restore, so leave the URL (and the database) exactly as found.
    if (createMode) {
      clearRefusal()
      router.push(returnHref as never)
      return
    }
    resetForm()
    setDirty(false)
    setSaveState('saved')
    clearRefusal()
    setMode('view')
  }

  async function post() {
    // A non-JSON refusal body must not throw past the toast and wedge the
    // button busy (F-t02-006 posted a 422 with zero UI feedback from the
    // bare res.json() here): the shared read cannot throw, and the busy
    // reset lives in its finally.
    await execute(
      () =>
        fetchAction('/api/payments/post-with-applications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Same revision evidence as the draft save: the route fences its
          // final allocation write on this token and 409s a stale drawer.
          body: JSON.stringify({ documentId: doc.id, expectedUpdatedAt: doc.updated_at, allocations: validAllocations }),
        }),
      {
        fallbackMessage: t('toasts.postFailed'),
        onOk: (data) => {
          const pendingApproval =
            (data as { pendingApproval?: unknown } | null)?.pendingApproval === true
          if (pendingApproval) toast.success(tCommon('actions.submitForApproval'))
          else toast.success(t('toasts.posted', { side }))
        },
      },
    )
    router.refresh()
  }

  async function remove() {
    if (
      !(await confirmDialog({
        title: t('deleteConfirmTitle'),
        message: t('deleteConfirmBody'),
        confirmLabel: t('deleteConfirmAction'),
        tone: 'danger',
      }))
    )
      return
    await execute(
      () => fetchAction(`/api/payments/${doc.id}`, { method: 'DELETE' }),
      {
        fallbackMessage: t('deleteFailed'),
        successMessage: t('deleted'),
        onOk: () => {
          router.push(basePath)
          router.refresh()
        },
      },
    )
  }

  async function voidPayment() {
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
          // The void API fences on the exact revision like every other document
          // write: without it every void answers 409 and the button is dead.
          body: JSON.stringify({ reason, expectedUpdatedAt: doc.updated_at }),
        }),
      {
        fallbackMessage: t('toasts.postFailed'),
        onOk: (data) => {
          // The void answers 202 with a status string when it lands as
          // pending approval — the body carries the same status, so branch
          // on the data, never on the transport.
          const status = (data as { status?: unknown } | null)?.status
          if (status === 'pending_approval') toast.success(tCommon('actions.submitForApproval'))
          else toast.success(tCommon('status.voided'))
        },
      },
    )
    router.refresh()
  }

  function updateAllocation(lineId: string, patch: Partial<AllocationClient>) {
    setAllocs((previous) => ({
      ...previous,
      [lineId]: { ...previous[lineId]!, ...patch },
    }))
  }

  function toggle(item: OpenItemClient) {
    setAllocs((prev) => {
      const next = { ...prev }
      if (next[item.lineId] === undefined) {
        const targetAmount = normalizeMoney(item.transactionOpen)
        if (item.currency === doc.currency) {
          next[item.lineId] = {
            openLineId: item.lineId,
            sourceTransactionAmount: targetAmount,
            targetTransactionAmount: targetAmount,
            settlementRate: '1',
            settlementRateSource: 'same_currency',
            settlementRateReference: 'same transaction currency',
          }
        } else {
          const evidence = settlementRates.find((rate) => rate.toCurrency === item.currency)
          next[item.lineId] = {
            openLineId: item.lineId,
            sourceTransactionAmount: evidence ? divRate(targetAmount, evidence.rate) : '',
            targetTransactionAmount: targetAmount,
            settlementRate: evidence?.rate ?? '',
            settlementRateSource: evidence ? 'provider' : 'manual',
            settlementRateReference: evidence ? `${evidence.source} · ${evidence.asOf}` : '',
            settlementFxRateId: evidence?.id ?? null,
          }
        }
      } else delete next[item.lineId]
      return next
    })
  }

  // Automated cash application: ask the engine to spread the received amount
  // across the party's open items (reference → exact → FIFO) and fill the rows.
  async function autoApply() {
    if (!partyId) return
    const sameCurrencyItems = openItems.filter((item) => item.currency === doc.currency)
    const amount = receivedAmount.trim() || formatMoney(sum(sameCurrencyItems.map((item) => item.transactionOpen)), 2)
    await execute(
      () =>
        fetchAction('/api/payments/suggest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ partyId, amount, side, currency: doc.currency, reference: referenceNumber || null }),
        }),
      {
        fallbackMessage: t('autoApplyFailed'),
        onOk: (data) => {
          const suggestion = data as { allocations?: AllocationClient[]; strategy?: unknown } | null
          if (!suggestion?.allocations?.length) {
            toast.info(t('autoApplyNone'))
            return
          }
          setAllocs(Object.fromEntries(suggestion.allocations.map((a: AllocationClient) => [a.openLineId, a])))
          toast.success(t('autoApplyDone', { count: suggestion.allocations.length, strategy: t(`autoApplyStrategy.${String(suggestion.strategy)}`) }))
        },
      },
    )
  }

  const field = 'space-y-1.5'
  const renderHeaderField = (placement: HeaderFieldPlacement, isEditable: boolean) => {
    const label = placement.labelOverride?.trim()
    switch (placement.key) {
      case 'party_id':
        return <><FieldLabel fieldName={label || partyLabel}>{label || partyLabel}{isEditable ? <span className="text-red-500"> *</span> : null}</FieldLabel>{isEditable ? <SearchSelect options={parties.map((party) => ({ value: party.id, label: party.display_name ?? '' }))} value={partyId} onChange={(value) => setPartyId(value ?? '')} placeholder={t('selectPartyPlaceholder', { side })} /> : <p className="text-sm">{doc.party_name}</p>}</>
      case 'bank_account_id':
        return <><FieldLabel fieldName={label || t('bankAccount')}>{label || t('bankAccount')}{isEditable ? <span className="text-red-500"> *</span> : null}</FieldLabel>{isEditable ? <SearchSelect options={bankAccounts.map((account) => ({ value: account.id, label: `${account.number ?? ''} ${account.name ?? ''}`.trim() }))} value={bankAccountId} onChange={(value) => setBankAccountId(value ?? '')} placeholder={t('selectBankAccountPlaceholder')} /> : <p className="text-sm">{`${doc.bank_account_number ?? ''} ${doc.bank_account_name ?? ''}`.trim() || '—'}</p>}</>
      case 'document_date':
        return <><FieldLabel fieldName={label || tCommon('labels.date')}>{label || tCommon('labels.date')}</FieldLabel>{isEditable ? <Input type="date" value={documentDate} onChange={(event) => setDocumentDate(event.target.value)} /> : <p className="text-sm">{doc.document_date}</p>}</>
      case 'reference_number':
        return <><FieldLabel fieldName={label || tCommon('labels.reference')}>{label || tCommon('labels.reference')}</FieldLabel>{isEditable ? <Input value={referenceNumber} onChange={(event) => setReferenceNumber(event.target.value)} placeholder={t('referencePlaceholder')} /> : <p className="text-sm">{doc.reference_number ?? '—'}</p>}</>
      case 'memo':
        return <><FieldLabel fieldName={label || tCommon('labels.memo')}>{label || tCommon('labels.memo')}</FieldLabel>{isEditable ? <Input value={memo} onChange={(event) => setMemo(event.target.value)} /> : <p className="text-sm">{doc.memo ?? '—'}</p>}</>
      default:
        return null
    }
  }
  const canPost =
    (isDraft || doc.status === 'approved') &&
    !busy &&
    !hasInvalidRow &&
    !dirty &&
    !!partyId &&
    !!bankAccountId &&
    validAllocations.length > 0 &&
    cmp(total, '0') > 0

  return (
    <TransactionDrawer
      closeHref={returnHref}
      recordId={String(doc.id)}
      // Unsaved-create hides the evidence tabs: both panels read the
      // persisted row the drawer has not written yet, so mounting them
      // would only probe the API with an empty record id.
      showEvidenceTabs={!createMode}
      canEditAttachments={canEditStatus}
      panelClassName={docTypeMeta(String(doc.kind ?? (side === 'ap' ? 'vendor_payment' : 'customer_payment'))).surfaceCls}
      title={
        <span className="flex items-center gap-2.5">
          <DocTypeBadge kind={String(doc.kind ?? (side === 'ap' ? 'vendor_payment' : 'customer_payment'))} />
          <span className="font-mono">{displayDocumentNumber(doc.document_number, doc.reference_number) || (createMode ? (createTitle ?? '') : '')}</span>
          <Badge variant={STATUS_VARIANT[doc.status] ?? 'secondary'}>
            {statusLabel(String(doc.status))}
          </Badge>
        </span>
      }
      description={mode === 'edit' ? tCommon('feedback.editingHint') : (doc.party_name ?? undefined)}
      primaryAction={
        canEditStatus ? (
          <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs" disabled={busy} onClick={() => mode === 'edit' ? cancel() : setMode('edit')}>
            {mode === 'edit' ? tCommon('actions.cancel') : tCommon('actions.edit')}
          </Button>
        ) : null
      }
      actions={
        <>
          {mode === 'edit' ? (
            <>
              <Button disabled={busy} onClick={save}>
                {busy ? tCommon('actions.saving') : tCommon('actions.save')}
              </Button>
            </>
          ) : (
            <>
              <PdfButton
                recordType={String(doc.kind ?? (side === 'ap' ? 'vendor_payment' : 'customer_payment'))}
                recordId={String(doc.id)}
              />
              <SendButton
                recordType={String(doc.kind ?? (side === 'ap' ? 'vendor_payment' : 'customer_payment'))}
                recordId={String(doc.id)}
              />
              <FlowManualButtons subjectKind={String(doc.kind)} subjectId={String(doc.id)} />
              <ApprovalActions subjectKind={String(doc.kind)} subjectId={String(doc.id)} />
              {isDraft || doc.status === 'approved' ? (
                <Button disabled={!canPost} onClick={post}>
                  {busy ? tCommon('actions.posting') : t('postAction', { side })}
                </Button>
              ) : null}
              {doc.entry_id ? (
                <Button variant="outline" asChild>
                  <JournalEntryLink entryId={doc.entry_id}>{t('viewGlImpact')}</JournalEntryLink>
                </Button>
              ) : null}
              {doc.status === 'approved' || doc.status === 'posted' ? (
                <Button variant="ghost" disabled={busy} onClick={voidPayment} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40">
                  {tCommon('actions.void')}
                </Button>
              ) : null}
              {doc.status === 'draft' ? (
                <Button variant="ghost" disabled={busy} onClick={remove} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40">
                  {tCommon('actions.delete')}
                </Button>
              ) : null}
            </>
          )}
        </>
      }
      // No approvals tab before the first Save: the history reads the
      // persisted row the drawer has not written yet.
      detailTabs={createMode ? [] : [
        {
          key: 'approvals',
          label: tCommon('approvalFlow.historyTitle'),
          content: <ApprovalHistory subjectKind={String(doc.kind)} subjectId={String(doc.id)} showEmptyState />,
        },
      ]}
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
                  ? t('saveState.error')
                  : dirty
                    ? t('saveState.dirty')
                    : null
              : null}
          </span>
          <span className="flex-1" />
          <span className="text-sm text-slate-600 tabular-nums dark:text-slate-300">
            {isDraft ? (
              t.rich('applyingSummary', {
                count: validAllocations.length,
                amount: money(total, { currency: doc.currency }),
                total: (chunks) => (
                  <strong className="text-slate-900 dark:text-slate-100">{chunks}</strong>
                ),
              })
            ) : (
              <strong className="text-slate-900 dark:text-slate-100">
                {t('totalAmount', { amount: money(doc.total, { currency: doc.currency }) })}
              </strong>
            )}
          </span>
        </div>
      }
    >
      <div className="space-y-6 p-1">
        <ActionAlert error={refusal} fallbackMessage={t('toasts.postFailed')} />
        {layout ? <HeaderFields layout={layout} editable={editable} renderField={renderHeaderField} /> : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={`${field} lg:col-span-2`}>
            <Label>
              {partyLabel}
              {editable ? <span className="text-red-500"> *</span> : null}
            </Label>
            {editable ? (
              <SearchSelect
                options={parties.map((p) => ({ value: p.id, label: p.display_name ?? '' }))}
                value={partyId}
                onChange={(v) => setPartyId(v ?? '')}
                placeholder={t('selectPartyPlaceholder', { side })}
              />
            ) : (
              <p className="text-sm">{doc.party_name}</p>
            )}
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>
              {t('bankAccount')}
              {editable ? <span className="text-red-500"> *</span> : null}
            </Label>
            {editable ? (
              <SearchSelect
                options={bankAccounts.map((a) => ({
                  value: a.id,
                  label: `${a.number ?? ''} ${a.name ?? ''}`.trim(),
                }))}
                value={bankAccountId}
                onChange={(v) => setBankAccountId(v ?? '')}
                placeholder={t('selectBankAccountPlaceholder')}
              />
            ) : (
              <p className="text-sm">
                {`${doc.bank_account_number ?? ''} ${doc.bank_account_name ?? ''}`.trim() || '—'}
              </p>
            )}
          </div>
          <div className={field}>
            <Label>{tCommon('labels.date')}</Label>
            {editable ? (
              <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.document_date}</p>
            )}
          </div>
          <div className={field}>
            <Label>{tCommon('labels.reference')}</Label>
            {editable ? (
              <Input
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                placeholder={t('referencePlaceholder')}
              />
            ) : (
              <p className="text-sm">{doc.reference_number ?? '—'}</p>
            )}
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>{tCommon('labels.memo')}</Label>
            {editable ? (
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.memo ?? '—'}</p>
            )}
          </div>
        </div>}

        {isDraft ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>{t('openItems', { side })}</Label>
              {editable && partyId && openItems.length > 0 ? (
                <div className="flex items-center gap-2">
                  {side === 'ar' ? (
                    <Input
                      inputMode="decimal"
                      value={receivedAmount}
                      onChange={(e) => setReceivedAmount(e.target.value)}
                      placeholder={t('amountReceived')}
                      className="h-8 w-32 text-right tabular-nums"
                    />
                  ) : null}
                  <Button variant="outline" size="sm" disabled={busy} onClick={autoApply}>
                    <Wand2 size={14} /> {t('autoApply')}
                  </Button>
                </div>
              ) : null}
            </div>
            {!partyId ? (
              <p className="rounded-md border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                {t('selectPartyHint', { side })}
              </p>
            ) : loadingItems ? (
              <p className="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400">{t('loadingOpenItems')}</p>
            ) : displayedOpenItems.length === 0 ? (
              <p className="rounded-md border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                {t('noOpenItems', { side })}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                      {editable ? <th className="w-10 px-3 py-2" aria-label={t('columns.apply')} /> : null}
                      <th className="px-3 py-2">{t('columns.document')}</th>
                      <th className="px-3 py-2">{t('columns.due')}</th>
                      <th className="px-3 py-2 text-right">{t('columns.original')}</th>
                      <th className="px-3 py-2 text-right">{t('columns.appliedToDate')}</th>
                      <th className="px-3 py-2 text-right">{t('columns.open')}</th>
                      <th className="min-w-56 px-3 py-2 text-right">{t('columns.apply')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedOpenItems.map((item) => {
                      const checked = allocs[item.lineId] !== undefined
                      const invalid = !rowValid(item)
                      return (
                        <tr
                          key={item.lineId}
                          className="border-b border-slate-100 last:border-0 dark:border-slate-800/60"
                        >
                          {editable ? <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-teal-600"
                              checked={checked}
                              onChange={() => toggle(item)}
                              aria-label={t('applyAriaLabel', { document: item.documentNumber ?? item.entryNumber })}
                            />
                          </td> : null}
                          <td className="px-3 py-2">
                            <span className="font-mono text-[13px] font-semibold">
                              {item.documentNumber ?? item.entryNumber}
                            </span>
                            <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                              {kindLabel(item.documentKind)}
                              {item.referenceNumber ? ` · ${item.referenceNumber}` : ''}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{item.dueDate ?? '—'}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(item.transactionAmount, { currency: item.currency })}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                            {money(item.transactionApplied, { currency: item.currency })}
                          </td>
                          <td className="px-3 py-2 text-right font-medium tabular-nums">{money(item.transactionOpen, { currency: item.currency })}</td>
                          <td className="px-3 py-2">
                            {checked ? (
                              editable ? <div className="space-y-2">
                                <div>
                                  <span className="mb-1 block text-[11px] text-slate-500">{t('targetAmount', { currency: item.currency })}</span>
                                  <Input
                                    inputMode="decimal"
                                    className={'h-8 text-right tabular-nums ' + (invalid ? 'border-red-400 focus-visible:ring-red-400 dark:border-red-600' : '')}
                                    value={allocs[item.lineId]!.targetTransactionAmount}
                                    onChange={(event) => updateAllocation(item.lineId, { targetTransactionAmount: event.target.value })}
                                    aria-invalid={invalid}
                                  />
                                </div>
                                {item.currency !== doc.currency ? (
                                  <div className="space-y-2 rounded-md bg-slate-50 p-2 dark:bg-slate-900/60">
                                    <div>
                                      <span className="mb-1 block text-[11px] text-slate-500">{t('sourceAmount', { currency: doc.currency })}</span>
                                      <Input inputMode="decimal" className="h-8 text-right tabular-nums" value={allocs[item.lineId]!.sourceTransactionAmount} onChange={(event) => updateAllocation(item.lineId, { sourceTransactionAmount: event.target.value })} />
                                    </div>
                                    <div>
                                      <span className="mb-1 block text-[11px] text-slate-500">{t('settlementRate', { target: item.currency, source: doc.currency })}</span>
                                      <Input inputMode="decimal" className="h-8 text-right tabular-nums" value={allocs[item.lineId]!.settlementRate} disabled={allocs[item.lineId]!.settlementRateSource === 'provider'} onChange={(event) => updateAllocation(item.lineId, { settlementRate: event.target.value })} />
                                    </div>
                                    <select
                                      className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-950"
                                      value={allocs[item.lineId]!.settlementRateSource}
                                      onChange={(event) => {
                                        const source = event.target.value as AllocationClient['settlementRateSource']
                                        if (source === 'provider') {
                                          const evidence = settlementRates.find((rate) => rate.toCurrency === item.currency)
                                          updateAllocation(item.lineId, evidence ? {
                                            settlementRateSource: 'provider', settlementRate: evidence.rate,
                                            sourceTransactionAmount: divRate(allocs[item.lineId]!.targetTransactionAmount, evidence.rate),
                                            settlementRateReference: `${evidence.source} · ${evidence.asOf}`,
                                            settlementFxRateId: evidence.id,
                                          } : { settlementRateSource: 'manual', settlementFxRateId: null })
                                        } else {
                                          updateAllocation(item.lineId, { settlementRateSource: source, settlementFxRateId: null })
                                        }
                                      }}
                                    >
                                      <option value="manual">{t('rateSource.manual')}</option>
                                      <option value="contractual">{t('rateSource.contractual')}</option>
                                      <option value="provider" disabled={!settlementRates.some((rate) => rate.toCurrency === item.currency)}>{t('rateSource.provider')}</option>
                                    </select>
                                    {allocs[item.lineId]!.settlementRateSource === 'provider' ? (
                                      <select
                                        className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-950"
                                        value={allocs[item.lineId]!.settlementFxRateId ?? ''}
                                        onChange={(event) => {
                                          const evidence = settlementRates.find((rate) => rate.id === event.target.value)
                                          if (evidence) updateAllocation(item.lineId, {
                                            settlementRate: evidence.rate,
                                            sourceTransactionAmount: divRate(allocs[item.lineId]!.targetTransactionAmount, evidence.rate),
                                            settlementRateReference: `${evidence.source} · ${evidence.asOf}`,
                                            settlementFxRateId: evidence.id,
                                          })
                                        }}
                                      >
                                        {settlementRates.filter((rate) => rate.toCurrency === item.currency).map((rate) => <option key={rate.id} value={rate.id}>{rate.asOf} · {rate.rate} · {rate.source}</option>)}
                                      </select>
                                    ) : (
                                      <Input className="h-8" value={allocs[item.lineId]!.settlementRateReference} placeholder={t('rateReferencePlaceholder')} onChange={(event) => updateAllocation(item.lineId, { settlementRateReference: event.target.value })} />
                                    )}
                                  </div>
                                ) : null}
                              </div> : (
                                <div className="space-y-1 text-right tabular-nums">
                                  <div>{money(allocs[item.lineId]!.targetTransactionAmount || '0', { currency: item.currency })}</div>
                                  {item.currency !== doc.currency ? (
                                    <>
                                      <div className="text-xs text-slate-500 dark:text-slate-400">{money(allocs[item.lineId]!.sourceTransactionAmount || '0', { currency: doc.currency })}</div>
                                      <div className="text-xs text-slate-500 dark:text-slate-400">{allocs[item.lineId]!.settlementRate} · {t(`rateSource.${allocs[item.lineId]!.settlementRateSource}`)}</div>
                                      {allocs[item.lineId]!.settlementRateReference ? <div className="text-xs text-slate-500 dark:text-slate-400">{allocs[item.lineId]!.settlementRateReference}</div> : null}
                                    </>
                                  ) : null}
                                </div>
                              )
                            ) : null}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {editable && hasInvalidRow ? (
              <p className="text-xs text-red-600 dark:text-red-400">{t('invalidAllocation')}</p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            <Label>{t('appliedTo')}</Label>
            {applied.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {doc.status === 'voided' ? t('voidedNote') : t('noLiveApplications')}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                      <th className="px-3 py-2">{t('columns.document')}</th>
                      <th className="px-3 py-2">{t('columns.due')}</th>
                      <th className="px-3 py-2">{t('columns.appliedOn')}</th>
                      <th className="px-3 py-2 text-right">{t('columns.original')}</th>
                      <th className="px-3 py-2 text-right">{t('columns.applied')}</th>
                      <th className="px-3 py-2">{t('columns.rateEvidence')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {applied.map((a) => (
                      <tr key={a.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                        <td className="px-3 py-2">
                          <span className="font-mono text-[13px] font-semibold">
                            {a.target_document_number ?? a.target_entry_number}
                          </span>
                          <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                            {kindLabel(a.target_document_kind)}
                            {a.target_reference_number ? ` · ${a.target_reference_number}` : ''}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{a.target_due_date ?? '—'}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{a.applied_on}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(a.target_transaction_original, { currency: a.target_transaction_currency })}</td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums">
                          <div>{money(a.target_transaction_amount, { currency: a.target_transaction_currency })}</div>
                          {a.source_transaction_currency !== a.target_transaction_currency ? <div className="text-xs font-normal text-slate-500">{money(a.source_transaction_amount, { currency: a.source_transaction_currency })}</div> : null}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-500">
                          <div className="font-mono">{a.settlement_rate}</div>
                          <div>{a.settlement_rate_reference}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

      </div>
    </TransactionDrawer>
  )
}
