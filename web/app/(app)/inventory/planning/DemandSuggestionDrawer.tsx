'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, DisclosureSection, EmptyState, Input, Label, SearchSelect, Select, UrlDrawer } from '@openbooks/ui'
import { readApiErrorMessage } from '@/lib/api-error'
import { promptDialog } from '@/lib/prompt'
import { DemandForecastChart } from './DemandForecastChart'

interface SuggestionRow {
  id: string
  runId: string
  runNumber: string
  runStatus: string
  itemId: string
  itemCode: string
  itemName: string
  baseUnit: string
  stockLocationId: string
  stockLocationCode: string
  action: 'buy' | 'transfer'
  quantity: string
  dueDate: string
  forecastQty: string
  projectedSupply: string
  daysOfCover: string | null
  status: string
  supplierId: string | null
  supplierName: string | null
  policyChangedAfterRun: boolean
}

interface ForecastRow {
  itemId: string
  stockLocationId: string
  periodStart: string
  quantity: string
  lower: string
  upper: string
  method: string
  explanation: {
    method: string
    historyWeeks: number
    stockoutWeeksImputed?: string[]
    seasonalPeakMonth?: number | null
    promotionCode?: string | null
    promotionLiftFactor?: string | null
    policyDefaulted?: boolean
    residualSigma?: string
  } | null
}

interface HistoryPoint {
  itemId: string
  stockLocationId: string
  weekStart: string
  quantity: string
  stockout: boolean
}

interface RunDetail {
  run: { id: string; number: string; status: string; parameters: { policies?: Record<string, { leadTimeDays: number; reviewCycleDays: number; serviceLevel: string; forecastMethod: string; defaulted: boolean }> } }
  forecasts: ForecastRow[]
  history: HistoryPoint[]
}

const STATUS_VARIANT = {
  suggested: 'warning',
  confirmed: 'secondary',
  converted: 'success',
  dismissed: 'outline',
} as const

function liftPercent(factor: string): string {
  const parsed = Number(factor)
  if (!Number.isFinite(parsed)) return factor
  return `${Math.round((parsed - 1) * 100)}%`
}

function monthName(month: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { month: 'short' }).format(new Date(2026, month - 1, 1))
  } catch {
    return String(month)
  }
}

/**
 * One suggestion, end to end: what is asked, why the model asked for it,
 * and the confirm / dismiss / convert step in the same shell. The shell
 * stays mounted through loading, refusal and retry; only its body changes.
 */
export function DemandSuggestionDrawer({
  suggestionId,
  closeHref,
  vendors,
  locations,
  locale,
}: {
  suggestionId: string
  closeHref: string
  vendors: { id: string; name: string }[]
  locations: { id: string; code: string }[]
  locale: string
}) {
  const [subsidiaryId, setSubsidiaryId] = useState<string | null>(null)
  const t = useTranslations('planning')
  const router = useRouter()
  const [row, setRow] = useState<SuggestionRow | null>(null)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [vendorId, setVendorId] = useState<string>('')
  const [sourceId, setSourceId] = useState<string>('')
  const [overrideQty, setOverrideQty] = useState('')
  const [overrideWeek, setOverrideWeek] = useState('')
  const [overrideReason, setOverrideReason] = useState('')

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body.
  const load = useCallback(() => {
    // load() sets no state synchronously — every update sits in a promise
    // continuation — so the mount effect below stays a pure fetch kickoff
    // (react-hooks/set-state-in-effect). Callers clear a shown error before
    // re-arming (the retry button), never here.
    const failTitle = t('drawer.title', { action: '', quantity: '', item: '' })
    return fetch(`/api/inventory/planning/suggestions/${suggestionId}`, {
      credentials: 'same-origin',
    })
      .then(async (oneRes) => {
        if (!oneRes.ok) throw new Error(await readApiErrorMessage(oneRes, failTitle))
        return (await oneRes.json()) as { suggestion: SuggestionRow | null; subsidiaryId: string }
      })
      .then((one) => {
        if (!one.suggestion) throw new Error(t('list.emptyTitle'))
        setSubsidiaryId(one.subsidiaryId)
        setRow(one.suggestion)
        setVendorId(one.suggestion.supplierId ?? '')
        return fetch(
          `/api/inventory/planning/runs/${one.suggestion.runId}?subsidiaryId=${one.subsidiaryId}`,
          { credentials: 'same-origin' },
        )
      })
      .then(async (runRes) => {
        if (!runRes.ok) throw new Error(await readApiErrorMessage(runRes, failTitle))
        setDetail((await runRes.json()) as RunDetail)
      })
      .catch((error: unknown) => {
        setFailed(error instanceof Error ? error.message : failTitle)
      })
  }, [suggestionId, t])

  // Fresh state per suggestion comes from the caller's key, so this effect
  // only loads: retry and resolution update state without remounting.
  useEffect(() => {
    void load()
  }, [load])

  const pair = useMemo(() => {
    if (!row || !detail) return null
    const forecasts = detail.forecasts.filter(
      (entry) => entry.itemId === row.itemId && entry.stockLocationId === row.stockLocationId,
    )
    const history = detail.history.filter(
      (entry) => entry.itemId === row.itemId && entry.stockLocationId === row.stockLocationId,
    )
    return { forecasts, history }
  }, [row, detail])

  const explanation = useMemo(() => {
    const first = pair?.forecasts.find((entry) => entry.explanation)?.explanation
    if (!first) return []
    const lines = [t('explanation.method', { method: t(`methods.${first.method}`), weeks: first.historyWeeks })]
    if (first.stockoutWeeksImputed && first.stockoutWeeksImputed.length > 0) {
      lines.push(t('explanation.stockouts', { count: first.stockoutWeeksImputed.length }))
    }
    if (first.promotionCode && first.promotionLiftFactor) {
      lines.push(t('explanation.promo', { code: first.promotionCode, lift: liftPercent(first.promotionLiftFactor) }))
    }
    if (first.seasonalPeakMonth) {
      lines.push(t('explanation.peak', { month: monthName(first.seasonalPeakMonth, locale) }))
    }
    if (first.policyDefaulted) lines.push(t('explanation.policyDefault'))
    return lines
  }, [pair, t, locale])

  async function mutate(path: string, body: unknown, action: string) {
    setBusy(action)
    try {
      const res = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(await readApiErrorMessage(res, action))
      await load()
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : action)
    } finally {
      setBusy(null)
    }
  }

  const confirm = () => mutate(`/api/inventory/planning/suggestions/${suggestionId}/confirm`, {}, t('actions.confirm'))

  async function dismiss() {
    const reason = await promptDialog({ title: t('actions.dismissTitle'), label: t('actions.dismissPrompt'), initialValue: '' })
    if (reason === null || reason.trim() === '') return
    await mutate(`/api/inventory/planning/suggestions/${suggestionId}/dismiss`, { reason: reason.trim() }, t('actions.dismiss'))
  }

  async function convert() {
    if (!row) return
    if (row.action === 'buy') {
      if (!vendorId) {
        toast.error(t('actions.noSupplier'))
        return
      }
      await mutate(`/api/inventory/planning/suggestions/${suggestionId}/convert`, { vendorId }, t('actions.convert'))
    } else {
      if (!sourceId) {
        toast.error(t('actions.chooseSource'))
        return
      }
      await mutate(
        `/api/inventory/planning/suggestions/${suggestionId}/convert`,
        { fromLocationId: sourceId },
        t('actions.convert'),
      )
    }
  }

  async function saveOverride() {
    if (!row || !subsidiaryId || !overrideWeek || !overrideQty || overrideReason.trim().length < 5) return
    setBusy('override')
    try {
      const res = await fetch('/api/inventory/planning/overrides', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          itemId: row.itemId,
          stockLocationId: row.stockLocationId,
          subsidiaryId,
          periodStart: overrideWeek,
          quantity: overrideQty,
          reason: overrideReason.trim(),
        }),
      })
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t('drawer.overrideSave')))
      toast.success(t('drawer.overrideSaved'))
      setOverrideQty('')
      setOverrideReason('')
      await load()
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('drawer.overrideSave'))
    } finally {
      setBusy(null)
    }
  }

  const title = row
    ? t('drawer.title', {
        action: t(`actions.${row.action}`),
        quantity: `${row.quantity} ${row.baseUnit}`,
        item: row.itemCode,
      })
    : t('drawer.title', { action: '', quantity: '', item: '' })

  return (
    <UrlDrawer open closeHref={closeHref} size="lg" title={title}>
      <div className="space-y-5 p-1">
        {failed ? (
          <EmptyState
            title={failed}
            action={<Button variant="outline" onClick={() => { setFailed(null); void load() }}>{t('list.emptyAction')}</Button>}
          />
        ) : !row || !detail || !pair ? (
          <p className="text-sm text-slate-500">{t('run.running')}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={STATUS_VARIANT[row.status as keyof typeof STATUS_VARIANT] ?? 'default'}>
                {t(`status.${row.status}`)}
              </Badge>
              <span className="text-sm text-slate-500">{t('drawer.runBy', { number: row.runNumber })}</span>
              {row.policyChangedAfterRun && <Badge variant="warning">{t('explanation.policyDefault')}</Badge>}
            </div>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t('drawer.forecast')}</h3>
              <DemandForecastChart
                history={pair.history.map((week) => ({ weekStart: week.weekStart, quantity: week.quantity, imputed: week.stockout }))}
                forecast={pair.forecasts.map((week) => ({ periodStart: week.periodStart, quantity: week.quantity, lower: week.lower, upper: week.upper }))}
              />
              <p className="text-xs text-slate-500">
                {t('drawer.band')} · {pair.forecasts.length > 0 && t(`methods.${pair.forecasts[0]!.method}`)}
              </p>
            </section>
            <section className="space-y-1">
              <h3 className="text-sm font-medium">{t('drawer.explanation')}</h3>
              {explanation.map((line) => (
                <p key={line} className="text-sm">{line}</p>
              ))}
              <p className="text-sm">
                {t('columns.forecast')}: {row.forecastQty} · {t('columns.supply')}: {row.projectedSupply}
                {row.daysOfCover !== null && ` · ${t('columns.cover')}: ${row.daysOfCover}`}
              </p>
            </section>
            {row.status === 'suggested' || row.status === 'confirmed' ? (
              <section className="space-y-3">
                {row.action === 'buy' ? (
                  <div className="space-y-1.5">
                    <Label>{t('actions.chooseVendor')}</Label>
                    <SearchSelect
                      value={vendorId}
                      onChange={setVendorId}
                      options={vendors.map((vendor) => ({ value: vendor.id, label: vendor.name }))}
                      placeholder={t('actions.chooseVendor')}
                      ariaLabel={t('actions.chooseVendor')}
                    />
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label>{t('actions.chooseSource')}</Label>
                    <SearchSelect
                      value={sourceId}
                      onChange={setSourceId}
                      options={locations
                        .filter((location) => location.id !== row.stockLocationId)
                        .map((location) => ({ value: location.id, label: location.code }))}
                      placeholder={t('actions.chooseSource')}
                      ariaLabel={t('actions.chooseSource')}
                    />
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {row.status === 'suggested' && (
                    <>
                      <Button disabled={busy !== null} onClick={confirm}>{t('actions.confirm')}</Button>
                      <Button variant="outline" disabled={busy !== null} onClick={dismiss}>{t('actions.dismiss')}</Button>
                    </>
                  )}
                  {row.status === 'confirmed' && (
                    <Button disabled={busy !== null} onClick={convert}>{t('actions.convert')}</Button>
                  )}
                </div>
              </section>
            ) : null}
            <DisclosureSection title={t('drawer.advanced')} summary={t('drawer.advancedSummary')}>
              <div className="space-y-3 pt-1">
                <div className="space-y-1.5">
                  <Label>{t('drawer.overrideTitle')}</Label>
                  <div className="flex flex-wrap gap-2">
                    <Select
                      value={overrideWeek}
                      onChange={(event) => setOverrideWeek(event.target.value)}
                      aria-label={t('drawer.forecast')}
                    >
                      <option value="">{t('drawer.forecast')}</option>
                      {pair.forecasts.map((week) => (
                        <option key={week.periodStart} value={week.periodStart}>{week.periodStart}</option>
                      ))}
                    </Select>
                    <Input
                      className="w-28"
                      inputMode="decimal"
                      value={overrideQty}
                      onChange={(event) => setOverrideQty(event.target.value)}
                      placeholder={t('drawer.overrideQuantity')}
                      aria-label={t('drawer.overrideQuantity')}
                    />
                  </div>
                  <Input
                    value={overrideReason}
                    onChange={(event) => setOverrideReason(event.target.value)}
                    placeholder={t('drawer.overrideReason')}
                    aria-label={t('drawer.overrideReason')}
                  />
                  <Button variant="outline" disabled={busy !== null} onClick={saveOverride}>
                    {t('drawer.overrideSave')}
                  </Button>
                </div>
              </div>
            </DisclosureSection>
          </>
        )}
      </div>
    </UrlDrawer>
  )
}
