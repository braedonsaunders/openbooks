'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, EmptyState, Input, Label, SearchSelect, Select } from '@openbooks/ui'
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
 * The item drawer's Planning tab: this item's planning policy next to its
 * current cover and next suggestion. Everyday state (cover + next action)
 * stays visible; the policy form configures; the method override and
 * history window sit one disclosure... (flat here — seven fields are the
 * whole configuration, and hiding two of them would strand them).
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
        if (policiesRes.ok) {
          const policies = (await policiesRes.json()) as Policy[]
          const found = policies.find((entry) => entry.itemId === itemId) ?? null
          if (live) {
            setPolicy(found)
            if (found) {
              setForm({
                leadTimeDays: found.leadTimeDays?.toString() ?? '',
                reviewCycleDays: found.reviewCycleDays?.toString() ?? '',
                serviceLevel: found.serviceLevel ?? '0.95',
                moqQty: found.moqQty ?? '',
                casePackQty: found.casePackQty ?? '',
                preferredSupplierId: found.preferredSupplierId ?? '',
                forecastMethod: found.forecastMethod ?? 'auto',
                historyWeeks: found.historyWeeks?.toString() ?? '',
              })
            }
          }
        }
        if (suggestionsRes.ok && live) {
          const rows = (await suggestionsRes.json()) as OpenSuggestion[]
          setSuggestion(rows.find((entry) => entry.itemId === itemId) ?? null)
        }
      } catch {
        // The tab degrades to its form: a failed load never blocks saving.
      }
    }
    void load()
    return () => {
      live = false
    }
  }, [itemId, subsidiaryId])

  function num(value: string): number | null {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const parsed = Number(trimmed)
    return Number.isInteger(parsed) ? parsed : null
  }

  async function save() {
    setBusy(true)
    try {
      const res = await fetch('/api/inventory/planning/policies', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          itemId,
          subsidiaryId,
          leadTimeDays: form.leadTimeDays.trim() === '' ? null : num(form.leadTimeDays),
          reviewCycleDays: form.reviewCycleDays.trim() === '' ? null : num(form.reviewCycleDays),
          serviceLevel: form.serviceLevel,
          moqQty: form.moqQty.trim() === '' ? null : form.moqQty.trim(),
          casePackQty: form.casePackQty.trim() === '' ? null : form.casePackQty.trim(),
          preferredSupplierId: form.preferredSupplierId === '' ? null : form.preferredSupplierId,
          forecastMethod: form.forecastMethod,
          historyWeeks: form.historyWeeks.trim() === '' ? null : num(form.historyWeeks),
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
