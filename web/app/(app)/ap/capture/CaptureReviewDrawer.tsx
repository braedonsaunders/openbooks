'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { AlertTriangle, Check, FileText, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, SearchSelect, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, UrlDrawer } from '@openbooks/ui'
import type { CaptureIssue, NormalizedCapture } from '@openbooks/engine/src/payables/ap-capture.ts'
import { ReadOnlyValue } from '../../../../components/read-only-value'
import { readApiErrorMessage } from '../../../../lib/api-error'

type Evidence = { fieldKey: string; lineIndex: number | null; confidence: string | null; pageNumber: number | null; polygon: { points: number[]; width: number; height: number } | null }

export type CaptureDetail = {
  id: string
  status: string
  /** Opaque optimistic-concurrency token: the capture's canonical revision when read. */
  updatedAt: string
  file_id: string
  original_filename: string
  document_kind: 'vendor_bill' | 'vendor_credit'
  normalized: NormalizedCapture
  validation_issues: CaptureIssue[]
  overall_confidence: string | null
  vendor_candidate_id: string | null
  purchase_order_id: string | null
  document_id: string | null
  last_error: string | null
  contentType: string
  sizeBytes: number
  resolvedVendor: string | null
  purchaseOrderNumber: string | null
  evidence: Evidence[]
}

type Option = { id: string; label: string }

/** A failed capture save carrying the status so the drawer can tell a revision conflict (pause + remedy) from a transport failure. */
class CaptureSaveError extends Error {
  readonly status: number
  readonly code: string
  constructor(code: string, status: number) {
    super(code)
    this.name = 'CaptureSaveError'
    this.code = code
    this.status = status
  }
}

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'outline' | 'secondary'> = {
  ready: 'success', materialized: 'success', needs_review: 'warning', duplicate: 'warning', failed: 'destructive', extracting: 'secondary', queued: 'secondary', rejected: 'outline',
}

export function CaptureReviewDrawer({ initial, vendors, accounts, purchaseOrders, canLookupPurchaseOrders = true, canCreate }: { initial: CaptureDetail; vendors: Option[]; accounts: Option[]; purchaseOrders: Option[]; canLookupPurchaseOrders?: boolean; canCreate: boolean }) {
  const t = useTranslations('ap.capture')
  const tc = useTranslations('common')
  const router = useRouter()
  const [form, setForm] = useState(initial.normalized)
  const [vendorId, setVendorId] = useState(initial.vendor_candidate_id ?? '')
  const [purchaseOrderId, setPurchaseOrderId] = useState(initial.purchase_order_id ?? '')
  const [documentKind, setDocumentKind] = useState(initial.document_kind)
  const [status, setStatus] = useState(initial.status)
  const [revision, setRevision] = useState(initial.updatedAt)
  const [issues, setIssues] = useState<CaptureIssue[]>(Array.isArray(initial.validation_issues) ? initial.validation_issues : [])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [acting, setActing] = useState<string | null>(null)
  const [activeEvidence, setActiveEvidence] = useState<Evidence | null>(null)
  const editable = canCreate && !['queued', 'extracting', 'materialized', 'rejected'].includes(status)
  const options = (values: Option[]) => values.map((value) => ({ value: value.id, label: value.label }))
  const optionLabel = (values: Option[], id: string | null | undefined) => values.find((value) => value.id === id)?.label ?? ''
  const evidence = useMemo(() => new Map(initial.evidence.map((value) => [`${value.fieldKey}:${value.lineIndex ?? ''}`, value])), [initial.evidence])

  /**
   * Autosave races it must survive: the operator keeps typing while a PATCH
   * is in flight, and a PATCH can take longer than the 800 ms debounce, so
   * a second save must never run concurrently with the first.
   *
   * Discipline: saves serialize through one `flight` promise. A save started
   * while another is in flight joins it instead of sending a stale revision
   * (which the server would 409). Every successful response's revision is
   * adopted — even a superseded one — so the next save never 409s against
   * the save that just succeeded. The server-normalized form is adopted only
   * when nothing was typed after the request was sent; otherwise the
   * operator's newer keystrokes are kept and the loop persists them.
   */
  const editVersion = useRef(0)
  const flight = useRef<Promise<boolean> | null>(null)
  const saveQueued = useRef(false)
  // A revision conflict (another session changed the capture) pauses the
  // debounce until the operator edits again: retrying the same stale write
  // every 800 ms would 409 forever and toast-spam the whole time.
  const conflictAtVersion = useRef<number | null>(null)
  // Latest-render mirrors so the serialized loop always sends current values
  // even though it was entered from a stale closure.
  const formRef = useRef(form)
  const vendorRef = useRef(vendorId)
  const purchaseOrderRef = useRef(purchaseOrderId)
  const kindRef = useRef(documentKind)
  const revisionRef = useRef(revision)
  const dirtyRef = useRef(dirty)
  const statusRef = useRef(status)
  useEffect(() => { formRef.current = form }, [form])
  useEffect(() => { vendorRef.current = vendorId }, [vendorId])
  useEffect(() => { purchaseOrderRef.current = purchaseOrderId }, [purchaseOrderId])
  useEffect(() => { kindRef.current = documentKind }, [documentKind])
  useEffect(() => { revisionRef.current = revision }, [revision])
  useEffect(() => { dirtyRef.current = dirty }, [dirty])
  useEffect(() => { statusRef.current = status }, [status])

  /** Every local edit path runs through here: it versions the change the save loop compares against. */
  function markEdited() {
    editVersion.current += 1
    conflictAtVersion.current = null
    setDirty(true)
  }

  function update(next: NormalizedCapture) {
    setForm(next)
    markEdited()
  }

  const save = useCallback((): Promise<boolean> => {
    if (!editable) return Promise.resolve(true)
    if (flight.current) {
      // Join the active flight: it persists whatever is latest when its
      // in-flight request returns, so sending now would only 409.
      saveQueued.current = true
      return flight.current
    }
    const run = (async (): Promise<boolean> => {
      setSaving(true)
      try {
        for (;;) {
          saveQueued.current = false
          if (!dirtyRef.current) return true
          const sentVersion = editVersion.current
          const response = await fetch(`/api/ap-capture/${initial.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ normalized: formRef.current, vendorId: vendorRef.current || null, purchaseOrderId: purchaseOrderRef.current || null, documentKind: kindRef.current, expectedUpdatedAt: revisionRef.current }),
          })
          // The status is checked before the body is parsed: a proxy 502/504
          // HTML page is not JSON, and parsing first would turn the refusal
          // into a syntax error. The named refusal (or the translated
          // fallback with the status) rides in the error, never a
          // SyntaxError.
          if (!response.ok) {
            throw new CaptureSaveError(await readApiErrorMessage(response, t('saveFailed')), response.status)
          }
          let body: { normalized?: NormalizedCapture; validationIssues?: CaptureIssue[]; vendorId?: string | null; purchaseOrderId?: string | null; status?: string; updatedAt?: string }
          try {
            body = (await response.json()) as typeof body
          } catch {
            throw new CaptureSaveError(t('saveFailed'), response.status)
          }
          // Always adopt the newest revision — even when the operator typed
          // meanwhile. Dropping it here is what wedged every later autosave
          // on 409 after one slow response.
          if (body.updatedAt) {
            revisionRef.current = body.updatedAt
            setRevision(body.updatedAt)
          }
          if (editVersion.current !== sentVersion || saveQueued.current) continue
          // Quiet period: nothing newer exists, so the server-normalized
          // form (and only then) replaces the local one.
          if (body.normalized) {
            formRef.current = body.normalized
            setForm(body.normalized)
          }
          setIssues(body.validationIssues ?? [])
          if (body.vendorId !== undefined) {
            vendorRef.current = body.vendorId ?? ''
            setVendorId(body.vendorId ?? '')
          }
          if (body.purchaseOrderId !== undefined) {
            purchaseOrderRef.current = body.purchaseOrderId ?? ''
            setPurchaseOrderId(body.purchaseOrderId ?? '')
          }
          if (body.status !== undefined) {
            statusRef.current = body.status
            setStatus(body.status)
          }
          setDirty(false)
          return true
        }
      } catch (error) {
        if (error instanceof CaptureSaveError && error.status === 409) {
          // Someone else (or another tab) changed the capture: pause the
          // debounce at this version and say so once, with the server's
          // own remedy, instead of 409ing every 800 ms until reload.
          conflictAtVersion.current = editVersion.current
        }
        const message = error instanceof CaptureSaveError && error.code !== 'save_failed' ? error.code : t('saveFailed')
        toast.error(message)
        return false
      } finally {
        flight.current = null
        setSaving(false)
      }
    })()
    flight.current = run
    return run
  }, [editable, initial.id, t])

  useEffect(() => {
    if (!dirty || !editable) return
    if (conflictAtVersion.current === editVersion.current) return
    const timer = window.setTimeout(() => void save(), 800)
    return () => window.clearTimeout(timer)
  }, [dirty, editable, save, form, vendorId, purchaseOrderId, documentKind])

  async function action(kind: 'reprocess' | 'reject') {
    setActing(kind)
    try {
      const response = await fetch('/api/ap-capture/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: kind, ids: [initial.id] }) })
      // The status is checked before the body parses, and the single
      // item's named refusal is toasted — never a SyntaxError, never the
      // generic fallback that hides which document failed and why.
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t('actionFailed')))
      const body = (await response.json()) as { results?: Array<{ ok: boolean; error?: string }> }
      if (!body?.results?.[0]?.ok) throw new Error(body?.results?.[0]?.error ?? t('actionFailed'))
      toast.success(t(kind === 'reject' ? 'rejected' : 'reprocessQueued'))
      router.push('/ap/capture')
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('actionFailed'))
    } finally {
      setActing(null)
    }
  }

  async function createDraft() {
    if (dirty && !(await save())) return
    setActing('materialize')
    try {
      const response = await fetch(`/api/ap-capture/${initial.id}/materialize`, { method: 'POST' })
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t('actionFailed')))
      const body = (await response.json()) as { documentId?: string }
      if (!body?.documentId) throw new Error(t('actionFailed'))
      toast.success(t('draftCreated'))
      router.push(`/ap/bills?doc=${body.documentId}&mode=edit`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('actionFailed'))
    } finally {
      setActing(null)
    }
  }

  const confidence = (fieldKey: string, lineIndex: number | null = null) => {
    const fieldEvidence = evidence.get(`${fieldKey}:${lineIndex ?? ''}`)
    const value = fieldEvidence?.confidence
    if (!value) return null
    const percent = Math.round(Number(value) * 100)
    const badge = <Badge variant={percent >= 90 ? 'success' : percent >= 70 ? 'warning' : 'destructive'}>{t('confidencePercent', { percent })}</Badge>
    const canHighlight = initial.contentType.startsWith('image/') && initial.contentType !== 'image/tiff'
      && fieldEvidence?.pageNumber === 1 && fieldEvidence.polygon
    return canHighlight ? (
      <button type="button" title={t('highlightEvidence')} aria-label={t('highlightEvidence')} onClick={() => setActiveEvidence(fieldEvidence)} className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500">
        {badge}
      </button>
    ) : badge
  }
  const headerActions = canCreate ? (
    <div className="flex items-center gap-2">
      {['failed', 'needs_review', 'ready', 'duplicate'].includes(status) ? <Button variant="outline" size="sm" disabled={acting !== null} onClick={() => void action('reprocess')}>{acting === 'reprocess' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}{t('reprocess')}</Button> : null}
      {!['materialized', 'rejected', 'queued', 'extracting'].includes(status) ? <Button variant="outline" size="sm" disabled={acting !== null} onClick={() => void action('reject')}><X size={13} />{t('reject')}</Button> : null}
      {['ready', 'needs_review'].includes(status) && !issues.some((value) => value.severity === 'blocking') ? <Button size="sm" disabled={acting !== null || saving || dirty} onClick={() => void createDraft()}>{acting === 'materialize' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}{t('createDraft')}</Button> : null}
    </div>
  ) : undefined

  return (
    <UrlDrawer open closeHref="/ap/capture" size="full" initialFullscreen title={<span className="flex items-center gap-2"><FileText size={17} />{initial.original_filename}<Badge variant={STATUS_VARIANT[status] ?? 'outline'}>{t(`status.${status}`)}</Badge></span>} description={saving ? t('saving') : dirty ? t('unsaved') : t('saved')} headerActions={headerActions} bodyClassName="overflow-hidden p-0">
      <div className="grid h-full min-h-0 lg:grid-cols-[minmax(0,1.05fr)_minmax(32rem,.95fr)]">
        <section className="min-h-[38vh] border-b border-slate-200 bg-slate-100 lg:min-h-0 lg:border-r lg:border-b-0 dark:border-slate-800 dark:bg-slate-950">
          {initial.contentType.startsWith('image/') && initial.contentType !== 'image/tiff' ? (
            <div className="relative h-full w-full">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/ap-capture/${initial.id}/file`} alt={t('sourcePreviewAlt', { name: initial.original_filename })} className="h-full w-full object-contain" />
              {activeEvidence?.polygon ? (
                <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${activeEvidence.polygon.width} ${activeEvidence.polygon.height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
                  <polygon points={activeEvidence.polygon.points.reduce<string[]>((points, value, index, values) => index % 2 === 0 ? [...points, `${value},${values[index + 1]}`] : points, []).join(' ')} className="fill-teal-400/25 stroke-teal-500" strokeWidth={Math.max(activeEvidence.polygon.width, activeEvidence.polygon.height) / 250} />
                </svg>
              ) : null}
            </div>
          ) : (
            <iframe src={`/api/ap-capture/${initial.id}/file`} title={t('sourcePreview')} className="h-full min-h-[38vh] w-full border-0" />
          )}
        </section>
        <section className="app-scroll min-h-0 overflow-y-auto p-4 sm:p-5">
          {['queued', 'extracting'].includes(status) ? <div className="flex h-full min-h-72 items-center justify-center gap-3 text-slate-500"><Loader2 className="animate-spin" />{t('processing')}</div> : status === 'failed' ? <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{t('processingFailed')}</div> : (
            <div className="space-y-5">
              {issues.length ? <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">{issues.map((value, index) => <div key={`${value.code}-${value.lineIndex ?? ''}-${index}`} className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-200"><AlertTriangle size={15} className="mt-0.5 shrink-0" /><span>{value.message ?? t(`issues.${value.code}`, { line: (value.lineIndex ?? 0) + 1, expected: value.expected ?? '', actual: value.actual ?? '' })}</span></div>)}</div> : null}
              {initial.document_id ? <Button variant="outline" asChild><Link href={`/ap/bills?doc=${initial.document_id}`}>{t('openDraft')}</Link></Button> : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5"><Label>{t('fields.kind')}</Label>{editable ? <Select value={documentKind} onChange={(event) => { setDocumentKind(event.target.value === 'vendor_credit' ? 'vendor_credit' : 'vendor_bill'); markEdited() }}><option value="vendor_bill">{t('bill')}</option><option value="vendor_credit">{t('credit')}</option></Select> : <ReadOnlyValue value={documentKind === 'vendor_credit' ? t('credit') : t('bill')} />}</div>
                <div className="space-y-1.5"><div className="flex items-center justify-between"><Label>{t('fields.vendor')}</Label>{confidence('vendorName')}</div>{editable ? <SearchSelect value={vendorId} onChange={(value) => { setVendorId(value); markEdited() }} options={options(vendors)} clearable placeholder={t('fields.vendorPlaceholder')} sheetTitle={t('fields.vendor')} ariaLabel={t('fields.vendor')} /> : <ReadOnlyValue value={optionLabel(vendors, vendorId) || initial.resolvedVendor} />}</div>
                <Field label={t('fields.invoiceNumber')} badge={confidence('invoiceNumber')}>{editable ? <Input value={form.invoiceNumber ?? ''} onChange={(event) => update({ ...form, invoiceNumber: event.target.value })} /> : <ReadOnlyValue value={form.invoiceNumber} className="font-mono" />}</Field>
                <Field label={t('fields.invoiceDate')} badge={confidence('invoiceDate')}>{editable ? <Input type="date" value={form.invoiceDate ?? ''} onChange={(event) => update({ ...form, invoiceDate: event.target.value })} /> : <ReadOnlyValue value={form.invoiceDate} />}</Field>
                <Field label={t('fields.dueDate')} badge={confidence('dueDate')}>{editable ? <Input type="date" value={form.dueDate ?? ''} onChange={(event) => update({ ...form, dueDate: event.target.value || null })} /> : <ReadOnlyValue value={form.dueDate} />}</Field>
                <Field label={t('fields.currency')} badge={confidence('currency')}>{editable ? <Input value={form.currency ?? ''} maxLength={3} onChange={(event) => update({ ...form, currency: event.target.value.toUpperCase() })} /> : <ReadOnlyValue value={form.currency} className="font-mono" />}</Field>
                <div className="space-y-1.5 sm:col-span-2"><div className="flex items-center justify-between"><Label>{t('fields.purchaseOrder')}</Label>{confidence('purchaseOrderNumber')}</div>{editable && canLookupPurchaseOrders ? <SearchSelect value={purchaseOrderId} onChange={(value) => { setPurchaseOrderId(value); markEdited() }} options={options(purchaseOrders)} clearable placeholder={t('fields.purchaseOrderPlaceholder')} sheetTitle={t('fields.purchaseOrder')} ariaLabel={t('fields.purchaseOrder')} /> : <ReadOnlyValue value={optionLabel(purchaseOrders, purchaseOrderId) || initial.purchaseOrderNumber} />}</div>
                <div className="space-y-1.5 sm:col-span-2"><Label>{t('fields.memo')}</Label>{editable ? <Textarea value={form.memo ?? ''} onChange={(event) => update({ ...form, memo: event.target.value || null })} rows={2} /> : <ReadOnlyValue value={form.memo} className="whitespace-pre-wrap" />}</div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">{t('lines.title')}</h3>{editable ? <Button size="sm" variant="outline" onClick={() => update({ ...form, lines: [...form.lines, { description: '', productCode: null, quantity: '1.0000', unit: null, unitPrice: '0.0000', amount: '0.0000', taxAmount: '0.0000', accountId: null, itemId: null, purchaseOrderLineId: null, confidence: null }] })}><Plus size={13} />{t('lines.add')}</Button> : null}</div>
                <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800"><Table><TableHeader><TableRow><TableHead>{t('lines.description')}</TableHead><TableHead>{t('lines.account')}</TableHead><TableHead className="w-24">{t('lines.quantity')}</TableHead><TableHead className="w-28">{t('lines.unitPrice')}</TableHead><TableHead className="w-28">{t('lines.amount')}</TableHead><TableHead className="w-24">{t('lines.tax')}</TableHead>{editable ? <TableHead className="w-10"><span className="sr-only">{tc('actions.delete')}</span></TableHead> : null}</TableRow></TableHeader><TableBody>{form.lines.map((line, lineIndex) => <TableRow key={lineIndex}><TableCell className="min-w-44"><div className="mb-1 flex justify-end">{confidence('lines.description', lineIndex) ?? confidence('lines.amount', lineIndex)}</div>{editable ? <Input value={line.description} onChange={(event) => update({ ...form, lines: form.lines.map((value, index) => index === lineIndex ? { ...value, description: event.target.value } : value) })} /> : line.description || '—'}</TableCell><TableCell className="min-w-48">{editable ? <SearchSelect value={line.accountId ?? ''} onChange={(value) => update({ ...form, lines: form.lines.map((current, index) => index === lineIndex ? { ...current, accountId: value || null, itemId: value ? null : current.itemId } : current) })} options={options(accounts)} disabled={Boolean(line.purchaseOrderLineId)} clearable placeholder={t('lines.accountPlaceholder')} sheetTitle={t('lines.account')} ariaLabel={t('lines.account')} /> : optionLabel(accounts, line.accountId) || '—'}</TableCell>{(['quantity', 'unitPrice', 'amount', 'taxAmount'] as const).map((key) => <TableCell key={key} className="text-right tabular-nums">{editable ? <Input inputMode="decimal" value={line[key]} onChange={(event) => update({ ...form, lines: form.lines.map((current, index) => index === lineIndex ? { ...current, [key]: event.target.value } : current) })} className="text-right tabular-nums" /> : line[key] || '—'}</TableCell>)}{editable ? <TableCell><Button size="icon" variant="ghost" aria-label={t('lines.remove', { line: lineIndex + 1 })} onClick={() => update({ ...form, lines: form.lines.filter((_, index) => index !== lineIndex) })}><Trash2 size={14} /></Button></TableCell> : null}</TableRow>)}</TableBody></Table></div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3"><Field label={t('fields.subtotal')} badge={confidence('subtotal')}>{editable ? <Input inputMode="decimal" value={form.subtotal ?? ''} onChange={(event) => update({ ...form, subtotal: event.target.value })} className="text-right tabular-nums" /> : <ReadOnlyValue value={form.subtotal} className="text-right tabular-nums" />}</Field><Field label={t('fields.taxTotal')} badge={confidence('taxTotal')}>{editable ? <Input inputMode="decimal" value={form.taxTotal ?? ''} onChange={(event) => update({ ...form, taxTotal: event.target.value })} className="text-right tabular-nums" /> : <ReadOnlyValue value={form.taxTotal} className="text-right tabular-nums" />}</Field><Field label={t('fields.total')} badge={confidence('total')}>{editable ? <Input inputMode="decimal" value={form.total ?? ''} onChange={(event) => update({ ...form, total: event.target.value })} className="text-right font-semibold tabular-nums" /> : <ReadOnlyValue value={form.total} className="text-right font-semibold tabular-nums" />}</Field></div>
            </div>
          )}
        </section>
      </div>
    </UrlDrawer>
  )
}

function Field({ label, badge, children }: { label: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return <div className="space-y-1.5"><div className="flex items-center justify-between gap-2"><Label>{label}</Label>{badge}</div>{children}</div>
}
