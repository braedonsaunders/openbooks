'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, DisclosureSection, SearchSelect } from '@openbooks/ui'
import { DrawerTabStrip } from '../../../components/drawer-tab-strip'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'
import { useMoney } from '@/components/money-provider'
import { confirmDialog } from '../../../lib/confirm'

/**
 * The Subscription tab on a quote drawer (quote-to-cash). Everyday: the
 * ramp-priced total, signature state, and the single next action. Configure:
 * terms with ramp steps on the tab itself — one focused term at a time
 * behind the shared strip, so sibling schedules never stack; the editing
 * draft lives outside the selection and survives switching. Advanced:
 * start rules and billing timing inside a collapsed DisclosureSection.
 * The section hides itself when the feature is off (the terms endpoint
 * 404s behind the gate).
 */

interface RampRow extends Record<string, unknown> {
  startsAfterMonths: string
  unitPrice: string
  quantity: string
  escalatorPercent: string
}

interface PreviewTerm {
  term: {
    id: string
    quoteLineId: string
    planId: string
    planName: string
    termMonths: number
    startRule: string
    billingTiming: string
    steps: Array<{ periodIndex: number; startsAfterMonths: number; unitPrice: string; quantity: string; escalatorPercent: string | null }>
  }
  schedule: {
    periods: Array<{ periodIndex: number; unitPrice: string; quantity: string; periodAmount: string; arr: string }>
    tcv: string
  }
  listTcv: string
  floorBreaches: number[]
}

interface Preview {
  quote: { id: string; documentNumber: string; status: string; currency: string }
  terms: PreviewTerm[]
  tcv: string
  listTcv: string
  discountPct: string
  floorBreached: boolean
  signature: {
    id: string
    status: string
    signerName: string
    signerEmail: string
    expiresAt: string
  } | null
  settings: { maxDiscountPercent: string; autoActivateOnSign: boolean }
  advancedSubscriptions: boolean
  revenueContracts: boolean
}

interface Plan {
  id: string
  name: string
  amount: string
  currency: string | null
  interval: string
  interval_count: number
}

async function readJson(res: Response): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    return { ok: false, body: body ?? {} }
  }
  return { ok: true, body: (await res.json()) as Record<string, unknown> }
}

function errorMessage(body: Record<string, unknown>): string {
  const error = body.error
  return typeof error === 'string' && error ? error : 'This action failed.'
}

const STATUS_KEYS = ['sent', 'viewed', 'signed', 'declined', 'expired', 'voided'] as const

function statusKey(status: string): string {
  const key = (STATUS_KEYS as readonly string[]).includes(status) ? status : 'sent'
  return `quoteCash.status.${key}`
}

export function QuoteCashSection(props: {
  quoteId: string
  currency: string
  canManage: boolean
  docStatus: string
  lines: Array<{ id: string; description: string | null }>
}) {
  const t = useTranslations('estimates')
  const { money } = useMoney(props.currency)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [hidden, setHidden] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [plans, setPlans] = useState<Plan[]>([])
  const [editing, setEditing] = useState<null | {
    termId: string | null
    quoteLineId: string
    planId: string
    termMonths: string
    startRule: string
    billingTiming: string
    steps: RampRow[]
  }>(null)
  const [sending, setSending] = useState(false)
  const [signerName, setSignerName] = useState('')
  const [signerEmail, setSignerEmail] = useState('')
  const [activated, setActivated] = useState<string[] | null>(null)
  // Multi-term quotes focus one term at a time behind the shared strip, so
  // sibling schedules never stack. The editing draft lives outside the
  // selection and survives switching.
  const [selectedTermId, setSelectedTermId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch(`/api/estimates/${encodeURIComponent(props.quoteId)}/terms`)
    if (res.status === 404) {
      setHidden(true)
      setLoading(false)
      return
    }
    const { ok, body } = await readJson(res)
    if (!ok) {
      toast.error(errorMessage(body))
      setLoading(false)
      return
    }
    setPreview(body as unknown as Preview)
    setLoading(false)
  }, [props.quoteId])

  useEffect(() => {
    queueMicrotask(() => { void load() })
  }, [load])

  useEffect(() => {
    if (hidden || !editing) return
    void (async () => {
      const res = await fetch('/api/quote-to-cash/plans')
      const { ok, body } = await readJson(res)
      if (ok) setPlans((body.plans as Plan[]) ?? [])
    })()
  }, [hidden, editing])

  if (hidden) return null
  if (loading || !preview) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">{t('quoteCash.loading')}</p>
  }

  const draft = preview.quote.status === 'draft'
  const canEdit = props.canManage && draft && !busy
  const openSignature = preview.signature && (preview.signature.status === 'sent' || preview.signature.status === 'viewed')
  const signed = preview.signature?.status === 'signed'
  const stepColumns: LineGridColumn<RampRow>[] = [
    { key: 'startsAfterMonths', label: t('quoteCash.colStartMonth'), width: '90px', type: 'decimal', decimalScale: 0, align: 'right' },
    { key: 'unitPrice', label: t('quoteCash.colUnitPrice'), width: '130px', type: 'amount', align: 'right' },
    { key: 'quantity', label: t('quoteCash.colQuantity'), width: '100px', type: 'decimal', decimalScale: 4, align: 'right' },
    { key: 'escalatorPercent', label: t('quoteCash.colEscalator'), width: '110px', type: 'decimal', decimalScale: 4, align: 'right', secondary: true },
  ]

  async function saveTerm() {
    if (!editing) return
    if (!editing.quoteLineId || !editing.planId) {
      toast.error(t('quoteCash.termNeedsLineAndPlan'))
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/estimates/${encodeURIComponent(props.quoteId)}/terms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          termId: editing.termId,
          quoteLineId: editing.quoteLineId,
          planId: editing.planId,
          termMonths: Number(editing.termMonths),
          startRule: editing.startRule,
          billingTiming: editing.billingTiming,
          steps: editing.steps.map((s) => ({
            startsAfterMonths: Number(s.startsAfterMonths),
            unitPrice: s.unitPrice,
            quantity: s.quantity,
            escalatorPercent: s.escalatorPercent || null,
          })),
        }),
      })
      const { ok, body } = await readJson(res)
      if (!ok) {
        toast.error(errorMessage(body))
        return
      }
      setEditing(null)
      await load()
      if ((body as { voided?: number }).voided) toast.success(t('quoteCash.termsSavedVoided'))
      else toast.success(t('quoteCash.termsSaved'))
    } finally {
      setBusy(false)
    }
  }

  async function deleteTerm(termId: string) {
    if (!(await confirmDialog(t('quoteCash.deleteTermConfirm')))) return
    setBusy(true)
    try {
      const res = await fetch(
        `/api/estimates/${encodeURIComponent(props.quoteId)}/terms?termId=${encodeURIComponent(termId)}`,
        { method: 'DELETE' },
      )
      const { ok, body } = await readJson(res)
      if (!ok) {
        toast.error(errorMessage(body))
        return
      }
      await load()
      toast.success(t('quoteCash.termDeleted'))
    } finally {
      setBusy(false)
    }
  }

  async function sendForSignature() {
    if (!signerName.trim() || !signerEmail.trim()) {
      toast.error(t('quoteCash.signerRequired'))
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/estimates/${encodeURIComponent(props.quoteId)}/signature`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signerName: signerName.trim(), signerEmail: signerEmail.trim() }),
      })
      const { ok, body } = await readJson(res)
      if (!ok) {
        toast.error(errorMessage(body))
        return
      }
      const record = body as { signUrl?: string; emailed?: boolean; emailSkippedReason?: string | null }
      setSending(false)
      await load()
      if (record.emailed) toast.success(t('quoteCash.sentEmailed'))
      else toast.success(t('quoteCash.sentLink', { reason: record.emailSkippedReason ?? '' }))
    } finally {
      setBusy(false)
    }
  }

  async function voidSignature() {
    if (!(await confirmDialog(t('quoteCash.voidConfirm')))) return
    setBusy(true)
    try {
      const res = await fetch(`/api/estimates/${encodeURIComponent(props.quoteId)}/signature`, { method: 'DELETE' })
      const { ok, body } = await readJson(res)
      if (!ok) {
        toast.error(errorMessage(body))
        return
      }
      await load()
      toast.success(t('quoteCash.voided'))
    } finally {
      setBusy(false)
    }
  }

  async function activate() {
    const lines = preview!.terms.map(
      (term) => `${term.term.planName}: ${term.term.termMonths} months`,
    )
    const consequence = t('quoteCash.activateConfirm', {
      count: preview!.terms.length,
      lines: lines.join('; '),
      contract: preview!.revenueContracts ? t('quoteCash.activateContractYes') : t('quoteCash.activateContractNo'),
    })
    if (!(await confirmDialog(consequence))) return
    setBusy(true)
    try {
      const res = await fetch(`/api/estimates/${encodeURIComponent(props.quoteId)}/activation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const { ok, body } = await readJson(res)
      if (!ok) {
        toast.error(errorMessage(body))
        return
      }
      const record = body as { subscriptionIds?: string[] }
      setActivated(record.subscriptionIds ?? [])
      toast.success(t('quoteCash.activated'))
    } finally {
      setBusy(false)
    }
  }

  const focusedTerm =
    preview.terms.find((term) => term.term.id === selectedTermId) ??
    preview.terms[0] ??
    null

  function termCard(term: PreviewTerm) {
    return (
      <li key={term.term.id} className="rounded-lg border p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{term.term.planName}</span>
          <span className="text-slate-500 dark:text-slate-400">
            {t('quoteCash.termMonths', { count: term.term.termMonths })}
          </span>
          <strong className="tabular-nums">{money(term.schedule.tcv, { currency: preview.quote.currency })}</strong>
          <span className="flex-1" />
          {canEdit ? (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => startEditing(term)}>
                {t('quoteCash.editTerm')}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void deleteTerm(term.term.id)}>
                {t('quoteCash.deleteTerm')}
              </Button>
            </>
          ) : null}
        </div>
        <div className="mt-2 text-xs tabular-nums text-slate-500 dark:text-slate-400">
          {term.schedule.periods.map((p) => (
            <span key={p.periodIndex} className="mr-3">
              {t('quoteCash.periodLine', {
                price: money(p.unitPrice, { currency: preview.quote.currency }),
                qty: p.quantity,
                amount: money(p.periodAmount, { currency: preview.quote.currency }),
              })}
            </span>
          ))}
        </div>
      </li>
    )
  }

  function startEditing(term?: PreviewTerm) {
    setActivated(null)
    setEditing({
      termId: term?.term.id ?? null,
      quoteLineId: term?.term.quoteLineId ?? props.lines[0]?.id ?? '',
      planId: term?.term.planId ?? '',
      termMonths: String(term?.term.termMonths ?? 12),
      startRule: term?.term.startRule ?? 'quote_date',
      billingTiming: term?.term.billingTiming ?? 'advance',
      steps: term
        ? term.term.steps.map((s) => ({
            startsAfterMonths: String(s.startsAfterMonths),
            unitPrice: s.unitPrice,
            quantity: s.quantity,
            escalatorPercent: s.escalatorPercent ?? '',
          }))
        : [{ startsAfterMonths: '0', unitPrice: '', quantity: '1', escalatorPercent: '' }],
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t('quoteCash.totalContractValue')}</span>
        <strong className="text-base tabular-nums">{money(preview.tcv, { currency: preview.quote.currency })}</strong>
        {!preview.discountPct.startsWith('-') && preview.discountPct !== '0.00' ? (
          <Badge variant={preview.floorBreached ? 'warning' : 'secondary'}>
            {t('quoteCash.discount', { pct: preview.discountPct })}
          </Badge>
        ) : null}
        {preview.floorBreached ? <Badge variant="warning">{t('quoteCash.belowFloor')}</Badge> : null}
        {signed ? <Badge variant="success">{t('quoteCash.signed')}</Badge> : null}
        {openSignature ? (
          <Badge variant="secondary">{t(statusKey(preview.signature!.status))}</Badge>
        ) : null}
      </div>

      {preview.terms.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4 text-sm">
          <p className="font-medium">{t('quoteCash.emptyTitle')}</p>
          <p className="mt-1 text-slate-500 dark:text-slate-400">{t('quoteCash.emptyDescription')}</p>
          {canEdit ? (
            <Button className="mt-3" size="sm" disabled={busy} onClick={() => startEditing()}>
              {t('quoteCash.addTerm')}
            </Button>
          ) : null}
        </div>
      ) : preview.terms.length === 1 ? (
        <ul className="space-y-2">
          {preview.terms.map((term) => termCard(term))}
        </ul>
      ) : (
        <>
          <DrawerTabStrip
            tabs={preview.terms.map((term) => ({
              key: term.term.id,
              label: term.term.planName,
              count: term.schedule.periods.length,
            }))}
            activeKey={focusedTerm?.term.id ?? ''}
            onSelect={(key) => setSelectedTermId(key)}
            ariaLabel={t('quoteCash.termsLabel')}
          />
          <ul className="space-y-2">
            {focusedTerm ? termCard(focusedTerm) : null}
          </ul>
        </>
      )}

      {editing ? (
        <div className="space-y-3 rounded-lg border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block font-medium">{t('quoteCash.quoteLine')}</span>
              <SearchSelect
                options={props.lines.map((l) => ({ value: l.id, label: l.description ?? l.id }))}
                value={editing.quoteLineId}
                onChange={(value) => setEditing({ ...editing, quoteLineId: value })}
                placeholder={t('quoteCash.quoteLine')}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">{t('quoteCash.plan')}</span>
              <SearchSelect
                options={plans.map((p) => ({ value: p.id, label: `${p.name} · ${p.amount}` }))}
                value={editing.planId}
                onChange={(value) => setEditing({ ...editing, planId: value })}
                placeholder={t('quoteCash.plan')}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">{t('quoteCash.termMonthsLabel')}</span>
              <input
                className="w-full rounded-md border px-2 py-1.5"
                inputMode="numeric"
                value={editing.termMonths}
                onChange={(e) => setEditing({ ...editing, termMonths: e.target.value })}
              />
            </label>
          </div>
          <LineGrid
            columns={stepColumns}
            rows={editing.steps}
            onRowsChange={(steps) => setEditing({ ...editing, steps })}
            emptyRow={() => ({ startsAfterMonths: '0', unitPrice: '', quantity: '1', escalatorPercent: '' })}
            addLabel={t('quoteCash.addTerm')}
          />
          <DisclosureSection
            title={t('quoteCash.advanced')}
            summary={t('quoteCash.advancedSummary', {
              start: editing.startRule,
              timing: editing.billingTiming,
            })}
          >
            <div className="grid gap-3 pt-2 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1 block font-medium">{t('quoteCash.startRule')}</span>
                <select
                  className="w-full rounded-md border px-2 py-1.5"
                  value={editing.startRule}
                  onChange={(e) => setEditing({ ...editing, startRule: e.target.value })}
                >
                  <option value="quote_date">{t('quoteCash.startQuoteDate')}</option>
                  <option value="first_of_next_month">{t('quoteCash.startNextMonth')}</option>
                  <option value="custom">{t('quoteCash.startCustom')}</option>
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium">{t('quoteCash.billingTiming')}</span>
                <select
                  className="w-full rounded-md border px-2 py-1.5"
                  value={editing.billingTiming}
                  onChange={(e) => setEditing({ ...editing, billingTiming: e.target.value })}
                >
                  <option value="advance">{t('quoteCash.timingAdvance')}</option>
                  <option value="arrears">{t('quoteCash.timingArrears')}</option>
                </select>
              </label>
            </div>
          </DisclosureSection>
          {!preview.advancedSubscriptions && preview.terms.length > 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('quoteCash.singlePeriodNote')}</p>
          ) : null}
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void saveTerm()}>
              {t('quoteCash.saveTerm')}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing(null)}>
              {t('quoteCash.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {preview.terms.length > 0 && (preview.discountPct !== '0.00' || preview.floorBreached) && !signed ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t('quoteCash.approvalHint', { threshold: preview.settings.maxDiscountPercent })}
        </p>
      ) : null}

      {canEdit && !openSignature && !signed ? (
        <div className="space-y-2 rounded-lg border p-3">
          {!sending ? (
            <Button size="sm" disabled={busy || preview.terms.length === 0} onClick={() => setSending(true)}>
              {t('quoteCash.sendForSignature')}
            </Button>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1 block font-medium">{t('quoteCash.signerName')}</span>
                <input
                  className="w-full rounded-md border px-2 py-1.5"
                  value={signerName}
                  onChange={(e) => setSignerName(e.target.value)}
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium">{t('quoteCash.signerEmail')}</span>
                <input
                  className="w-full rounded-md border px-2 py-1.5"
                  inputMode="email"
                  value={signerEmail}
                  onChange={(e) => setSignerEmail(e.target.value)}
                />
              </label>
              <div className="flex gap-2 sm:col-span-2">
                <Button size="sm" disabled={busy} onClick={() => void sendForSignature()}>
                  {t('quoteCash.sendLink')}
                </Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setSending(false)}>
                  {t('quoteCash.cancel')}
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {openSignature && preview.signature ? (
        <div className="space-y-1 rounded-lg border p-3 text-sm">
          <div>
            <Badge variant="secondary">{t(statusKey(preview.signature.status))}</Badge>{' '}
            {t('quoteCash.sentTo', {
              name: preview.signature.signerName,
              email: preview.signature.signerEmail,
            })}
          </div>
          <p className="text-slate-500 dark:text-slate-400">
            {t('quoteCash.expiresOn', {
              date: preview.signature.expiresAt.slice(0, 10),
            })}
          </p>
          {canEdit ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void voidSignature()}>
              {t('quoteCash.voidRequest')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {signed && !activated ? (
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <div>
            <Badge variant="success">{t('quoteCash.signed')}</Badge>{' '}
            {t('quoteCash.signedHint')}
          </div>
          {canEdit ? (
            <Button size="sm" disabled={busy || preview.terms.length === 0} onClick={() => void activate()}>
              {t('quoteCash.activate')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {activated ? (
        <div className="text-sm">
          <Badge variant="success">{t('quoteCash.activatedCount', { count: activated.length })}</Badge>
        </div>
      ) : null}
    </div>
  )
}
