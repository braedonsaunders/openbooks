'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { AlertTriangle, Check, FileText, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, SearchSelect, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, UrlDrawer } from '@openbooks/ui'
import type { CaptureIssue, NormalizedCapture } from '@openbooks/engine/src/ap-capture.ts'
import { ReadOnlyValue } from '../../../../components/read-only-value'

type Evidence = { fieldKey: string; lineIndex: number | null; confidence: string | null; pageNumber: number | null; polygon: { points: number[]; width: number; height: number } | null }

export type CaptureDetail = {
  id: string
  status: string
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

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'outline' | 'secondary'> = {
  ready: 'success', materialized: 'success', needs_review: 'warning', duplicate: 'warning', failed: 'destructive', extracting: 'secondary', queued: 'secondary', rejected: 'outline',
}

export function CaptureReviewDrawer({ initial, vendors, accounts, purchaseOrders, canCreate }: { initial: CaptureDetail; vendors: Option[]; accounts: Option[]; purchaseOrders: Option[]; canCreate: boolean }) {
  const t = useTranslations('ap.capture')
  const tc = useTranslations('common')
  const router = useRouter()
  const [form, setForm] = useState(initial.normalized)
  const [vendorId, setVendorId] = useState(initial.vendor_candidate_id ?? '')
  const [purchaseOrderId, setPurchaseOrderId] = useState(initial.purchase_order_id ?? '')
  const [documentKind, setDocumentKind] = useState(initial.document_kind)
  const [status, setStatus] = useState(initial.status)
  const [issues, setIssues] = useState<CaptureIssue[]>(Array.isArray(initial.validation_issues) ? initial.validation_issues : [])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [acting, setActing] = useState<string | null>(null)
  const [activeEvidence, setActiveEvidence] = useState<Evidence | null>(null)
  const saveSequence = useRef(0)
  const editable = canCreate && !['queued', 'extracting', 'materialized', 'rejected'].includes(status)
  const options = (values: Option[]) => values.map((value) => ({ value: value.id, label: value.label }))
  const optionLabel = (values: Option[], id: string | null | undefined) => values.find((value) => value.id === id)?.label ?? ''
  const evidence = useMemo(() => new Map(initial.evidence.map((value) => [`${value.fieldKey}:${value.lineIndex ?? ''}`, value])), [initial.evidence])

  function update(next: NormalizedCapture) {
    setForm(next)
    setDirty(true)
  }

  const save = useCallback(async (): Promise<boolean> => {
    if (!dirty || !editable) return true
    const sequence = ++saveSequence.current
    setSaving(true)
    try {
      const response = await fetch(`/api/ap-capture/${initial.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ normalized: form, vendorId: vendorId || null, purchaseOrderId: purchaseOrderId || null, documentKind }),
      })
      const body = (await response.json()) as { normalized?: NormalizedCapture; validationIssues?: CaptureIssue[]; vendorId?: string | null; purchaseOrderId?: string | null; status?: string; error?: string }
      if (!response.ok) throw new Error(body.error ?? 'save_failed')
      if (sequence !== saveSequence.current) return true
      if (body.normalized) setForm(body.normalized)
      setIssues(body.validationIssues ?? [])
      setVendorId(body.vendorId ?? '')
      setPurchaseOrderId(body.purchaseOrderId ?? '')
      setStatus(body.status ?? status)
      setDirty(false)
      return true
    } catch {
      toast.error(t('saveFailed'))
      return false
    } finally {
      if (sequence === saveSequence.current) setSaving(false)
    }
  }, [dirty, documentKind, editable, form, initial.id, purchaseOrderId, status, t, vendorId])

  useEffect(() => {
    if (!dirty || !editable) return
    const timer = window.setTimeout(() => void save(), 800)
    return () => window.clearTimeout(timer)
  }, [dirty, editable, save])

  async function action(kind: 'reprocess' | 'reject') {
    setActing(kind)
    try {
      const response = await fetch('/api/ap-capture/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: kind, ids: [initial.id] }) })
      const body = (await response.json()) as { results?: Array<{ ok: boolean; error?: string }> }
      if (!response.ok || !body.results?.[0]?.ok) throw new Error(body.results?.[0]?.error ?? 'action_failed')
      toast.success(t(kind === 'reject' ? 'rejected' : 'reprocessQueued'))
      router.push('/ap/capture')
      router.refresh()
    } catch {
      toast.error(t('actionFailed'))
    } finally {
      setActing(null)
    }
  }

  async function createDraft() {
    if (dirty && !(await save())) return
    setActing('materialize')
    try {
      const response = await fetch(`/api/ap-capture/${initial.id}/materialize`, { method: 'POST' })
      const body = (await response.json()) as { documentId?: string; error?: string }
      if (!response.ok || !body.documentId) throw new Error(body.error ?? 'create_failed')
      toast.success(t('draftCreated'))
      router.push(`/ap/bills?doc=${body.documentId}&mode=edit`)
    } catch {
      toast.error(t('actionFailed'))
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
            // eslint-disable-next-line @next/next/no-img-element
            <div className="relative h-full w-full">
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
              {issues.length ? <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">{issues.map((value, index) => <div key={`${value.code}-${value.lineIndex ?? ''}-${index}`} className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-200"><AlertTriangle size={15} className="mt-0.5 shrink-0" /><span>{t(`issues.${value.code}`, { line: (value.lineIndex ?? 0) + 1, expected: value.expected ?? '', actual: value.actual ?? '' })}</span></div>)}</div> : null}
              {initial.document_id ? <Button variant="outline" asChild><Link href={`/ap?doc=${initial.document_id}`}>{t('openDraft')}</Link></Button> : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5"><Label>{t('fields.kind')}</Label>{editable ? <Select value={documentKind} onChange={(event) => { setDocumentKind(event.target.value === 'vendor_credit' ? 'vendor_credit' : 'vendor_bill'); setDirty(true) }}><option value="vendor_bill">{t('bill')}</option><option value="vendor_credit">{t('credit')}</option></Select> : <ReadOnlyValue value={documentKind === 'vendor_credit' ? t('credit') : t('bill')} />}</div>
                <div className="space-y-1.5"><div className="flex items-center justify-between"><Label>{t('fields.vendor')}</Label>{confidence('vendorName')}</div>{editable ? <SearchSelect value={vendorId} onChange={(value) => { setVendorId(value); setDirty(true) }} options={options(vendors)} clearable placeholder={t('fields.vendorPlaceholder')} sheetTitle={t('fields.vendor')} ariaLabel={t('fields.vendor')} /> : <ReadOnlyValue value={optionLabel(vendors, vendorId) || initial.resolvedVendor} />}</div>
                <Field label={t('fields.invoiceNumber')} badge={confidence('invoiceNumber')}>{editable ? <Input value={form.invoiceNumber ?? ''} onChange={(event) => update({ ...form, invoiceNumber: event.target.value })} /> : <ReadOnlyValue value={form.invoiceNumber} className="font-mono" />}</Field>
                <Field label={t('fields.invoiceDate')} badge={confidence('invoiceDate')}>{editable ? <Input type="date" value={form.invoiceDate ?? ''} onChange={(event) => update({ ...form, invoiceDate: event.target.value })} /> : <ReadOnlyValue value={form.invoiceDate} />}</Field>
                <Field label={t('fields.dueDate')} badge={confidence('dueDate')}>{editable ? <Input type="date" value={form.dueDate ?? ''} onChange={(event) => update({ ...form, dueDate: event.target.value || null })} /> : <ReadOnlyValue value={form.dueDate} />}</Field>
                <Field label={t('fields.currency')} badge={confidence('currency')}>{editable ? <Input value={form.currency ?? ''} maxLength={3} onChange={(event) => update({ ...form, currency: event.target.value.toUpperCase() })} /> : <ReadOnlyValue value={form.currency} className="font-mono" />}</Field>
                <div className="space-y-1.5 sm:col-span-2"><div className="flex items-center justify-between"><Label>{t('fields.purchaseOrder')}</Label>{confidence('purchaseOrderNumber')}</div>{editable ? <SearchSelect value={purchaseOrderId} onChange={(value) => { setPurchaseOrderId(value); setDirty(true) }} options={options(purchaseOrders)} clearable placeholder={t('fields.purchaseOrderPlaceholder')} sheetTitle={t('fields.purchaseOrder')} ariaLabel={t('fields.purchaseOrder')} /> : <ReadOnlyValue value={optionLabel(purchaseOrders, purchaseOrderId) || initial.purchaseOrderNumber} />}</div>
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
