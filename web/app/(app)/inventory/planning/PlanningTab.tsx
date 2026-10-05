'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Alert, AlertDescription, Badge, Button, EmptyState, Input, Label, SearchSelect, Select } from '@openbooks/ui'
import { canonicalNonNegativeDecimal } from '@openbooks/engine/money/decimal'
import { readApiErrorMessage } from '@/lib/api-error'

interface Policy {
  itemId: string
  leadTimeDays: number | null
  reviewCycleDays: number | null
  serviceLevel: string | null
  moqQty: string | null
  casePackQty: string | null
  preferredSupplierId: string | null
  forecastMethod: string | null
  historyWeeks: number | null
}

interface OpenSuggestion {
  id: string
  itemId: string
  action: string
  quantity: string
  baseUnit: string
  stockLocationCode: string
  daysOfCover: string | null
  status: string
}

const METHOD_LABELS = {
  auto: 'policy.methodAuto',
  seasonal: 'policy.methodSeasonal',
  intermittent: 'policy.methodIntermittent',
  average: 'policy.methodAverage',
} as const

const SERVICE_LEVELS = ['0.8', '0.9', '0.95', '0.975', '0.99']
const METHODS = ['auto', 'seasonal', 'intermittent', 'average'] as const

/**
 * The selected item's policy and next suggestion share its planning context.
 * Editing begins only after both reads succeed, so a refused read cannot
 * turn existing configuration into an apparently empty default form.
 */
export function PlanningTab({
  itemId,
  subsidiaryId,
  canManage,
  vendors,
}: {
  itemId: string
  subsidiaryId: string
  canManage: boolean
  vendors: { id: string; name: string }[]
}) {
  const t = useTranslations('planning')
  const tc = useTranslations('common')
  const requestKey = `${itemId}:${subsidiaryId}`
  const [readState, setReadState] = useState<{ key: string; error: string | null } | null>(null)
  const [reload, setReload] = useState(0)
  const ready = readState?.key === requestKey && readState.error === null
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [suggestion, setSuggestion] = useState<OpenSuggestion | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    leadTimeDays: '',
    reviewCycleDays: '',
    serviceLevel: '0.95',
    moqQty: '',
    casePackQty: '',
    preferredSupplierId: '',
    forecastMethod: 'auto',
    historyWeeks: '',
  })

  useEffect(() => {
    let live = true
    async function load() {
      try {
        const [policiesRes, suggestionsRes] = await Promise.all([
          fetch('/api/inventory/planning/policies', { credentials: 'same-origin' }),
          fetch(`/api/inventory/planning/suggestions?subsidiaryId=${subsidiaryId}&status=open`, {
            credentials: 'same-origin',
          }),
        ])
        if (!policiesRes.ok) throw new Error(await readApiErrorMessage(policiesRes, t('policy.loadFailed')))
        if (!suggestionsRes.ok) throw new Error(await readApiErrorMessage(suggestionsRes, t('policy.loadFailed')))
        const [policies, suggestions] = await Promise.all([
          policiesRes.json() as Promise<Policy[]>,
          suggestionsRes.json() as Promise<OpenSuggestion[]>,
        ])
        const found = policies.find((entry) => entry.itemId === itemId) ?? null
        const nextSuggestion = suggestions.find((entry) => entry.itemId === itemId) ?? null
        if (live) {
          setPolicy(found)
          setSuggestion(nextSuggestion)
          setForm({
            leadTimeDays: found?.leadTimeDays?.toString() ?? '',
            reviewCycleDays: found?.reviewCycleDays?.toString() ?? '',
            serviceLevel: found?.serviceLevel ?? '0.95',
            moqQty: found?.moqQty ?? '',
            casePackQty: found?.casePackQty ?? '',
            preferredSupplierId: found?.preferredSupplierId ?? '',
            forecastMethod: found?.forecastMethod ?? 'auto',
            historyWeeks: found?.historyWeeks?.toString() ?? '',
          })
          setReadState({ key: requestKey, error: null })
        }
      } catch (error) {
        if (live) setReadState({ key: requestKey, error: error instanceof Error ? error.message : t('policy.loadFailed') })
      }
    }
    void load()
    return () => {
      live = false
    }
  }, [itemId, subsidiaryId, requestKey, reload, t])

  function num(value: string, field: string): number | null {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const canonical = canonicalNonNegativeDecimal(trimmed, 0)
    const parsed = canonical === null ? Number.NaN : Number(canonical)
    if (!Number.isSafeInteger(parsed)) throw new Error(t('policy.integerInvalid', { field }))
    return parsed
  }

  async function save() {
    // A refused or unfinished read cannot authorize overwriting an unknown policy.
    if (!ready) return
    setBusy(true)
    try {
      const res = await fetch('/api/inventory/planning/policies', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          itemId,
          subsidiaryId,
          leadTimeDays: form.leadTimeDays.trim() === '' ? null : num(form.leadTimeDays, t('policy.leadTime')),
          reviewCycleDays: form.reviewCycleDays.trim() === '' ? null : num(form.reviewCycleDays, t('policy.reviewCycle')),
          serviceLevel: form.serviceLevel,
          moqQty: form.moqQty.trim() === '' ? null : form.moqQty.trim(),
          casePackQty: form.casePackQty.trim() === '' ? null : form.casePackQty.trim(),
          preferredSupplierId: form.preferredSupplierId === '' ? null : form.preferredSupplierId,
          forecastMethod: form.forecastMethod,
          historyWeeks: form.historyWeeks.trim() === '' ? null : num(form.historyWeeks, t('policy.history')),
        }),
      })
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t('policy.save')))
      setPolicy((await res.json()) as Policy)
      toast.success(t('policy.saved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('policy.save'))
    } finally {
      setBusy(false)
    }
  }

  if (!ready) {
    const error = readState?.key === requestKey ? readState.error : null
    return error ? (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
        <Button variant="outline" onClick={() => { setReadState(null); setReload((value) => value + 1) }}>
          {tc('actions.retry')}
        </Button>
      </Alert>
    ) : <p role="status" className="text-sm text-muted-foreground">{tc('actions.loading')}</p>
  }

  const field = 'space-y-1.5'
  return (
    <div className="space-y-5 p-1">
      {suggestion ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={suggestion.status === 'confirmed' ? 'secondary' : 'warning'}>
            {t(`status.${suggestion.status}`)}
          </Badge>
          <span className="text-sm">
            {t(`actions.${suggestion.action}`)} {suggestion.quantity} {suggestion.baseUnit} · {suggestion.stockLocationCode}
            {suggestion.daysOfCover !== null && ` · ${t('itemTab.cover')}: ${suggestion.daysOfCover}`}
          </span>
          <Link className="text-sm underline" href={`/inventory/planning?subsidiaryId=${subsidiaryId}`}>
            {t('itemTab.openPlanning')}
          </Link>
        </div>
      ) : (
        <EmptyState title={t('itemTab.none')} />
      )}
      {!policy && (
        <p className="text-sm text-slate-500">{t('policy.defaulted')}</p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className={field}>
          <Label>{t('policy.leadTime')}</Label>
          <Input inputMode="numeric" disabled={!canManage || busy} value={form.leadTimeDays} onChange={(event) => setForm({ ...form, leadTimeDays: event.target.value })} />
        </div>
        <div className={field}>
          <Label>{t('policy.reviewCycle')}</Label>
          <Input inputMode="numeric" disabled={!canManage || busy} value={form.reviewCycleDays} onChange={(event) => setForm({ ...form, reviewCycleDays: event.target.value })} />
        </div>
        <div className={field}>
          <Label>{t('policy.serviceLevel')}</Label>
          <Select disabled={!canManage || busy} value={form.serviceLevel} onChange={(event) => setForm({ ...form, serviceLevel: event.target.value })}>
            {SERVICE_LEVELS.map((level) => (
              <option key={level} value={level}>{`${Math.round(Number(level) * 100)}%`}</option>
            ))}
          </Select>
        </div>
        <div className={field}>
          <Label>{t('policy.method')}</Label>
          <Select disabled={!canManage || busy} value={form.forecastMethod} onChange={(event) => setForm({ ...form, forecastMethod: event.target.value })}>
            {METHODS.map((method) => (
              <option key={method} value={method}>
                {t(METHOD_LABELS[method])}
              </option>
            ))}
          </Select>
        </div>
        <div className={field}>
          <Label>{t('policy.moq')}</Label>
          <Input inputMode="decimal" disabled={!canManage || busy} value={form.moqQty} onChange={(event) => setForm({ ...form, moqQty: event.target.value })} />
        </div>
        <div className={field}>
          <Label>{t('policy.casePack')}</Label>
          <Input inputMode="decimal" disabled={!canManage || busy} value={form.casePackQty} onChange={(event) => setForm({ ...form, casePackQty: event.target.value })} />
        </div>
        <div className={field}>
          <Label>{t('policy.supplier')}</Label>
          <SearchSelect
            value={form.preferredSupplierId}
            onChange={(value) => setForm({ ...form, preferredSupplierId: value })}
            options={vendors.map((vendor) => ({ value: vendor.id, label: vendor.name }))}
            placeholder={t('policy.supplier')}
            ariaLabel={t('policy.supplier')}
            disabled={!canManage || busy}
            clearable
          />
        </div>
        <div className={field}>
          <Label>{t('policy.history')}</Label>
          <Input inputMode="numeric" disabled={!canManage || busy} value={form.historyWeeks} onChange={(event) => setForm({ ...form, historyWeeks: event.target.value })} />
        </div>
      </div>
      {canManage && (
        <Button disabled={busy} onClick={save}>{t('policy.save')}</Button>
      )}
    </div>
  )
}
