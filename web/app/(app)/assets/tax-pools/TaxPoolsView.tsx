'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Play, Settings2 } from 'lucide-react'
import { Button, Card, CardContent, Label, Select } from '@openbooks/ui'
import { decimalCmp } from '../../../../lib/statement-format'

type Line = {
  classCode: string
  className: string
  openingBalance: string
  additions: string
  dispositions: string
  allowance: string
  closingBalance: string
  recapture: string
  terminalLoss: string
}
type RunResult = { taxYear: number; lines: Line[]; totals: { allowance: string; recapture: string; terminalLoss: string } }
type TaxWindow = { id: string; subsidiaryId: string; regime: string; yearStart: string; yearEnd: string; filingYear: number }

export function formatTaxPoolAmount(value: string, locale: string): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value as never)
}

export function TaxPoolsView({
  canRun,
  canConfigure,
  regimes,
  subsidiaries,
}: {
  canRun: boolean
  canConfigure: boolean
  regimes: { code: string; name: string }[]
  subsidiaries: { id: string; name: string }[]
}) {
  const t = useTranslations('assets')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const [regime, setRegime] = useState(regimes[0]?.code ?? '')
  const [subsidiaryId, setSubsidiaryId] = useState(subsidiaries[0]?.id ?? '')
  const [windows, setWindows] = useState<TaxWindow[]>([])
  const [taxYearWindowId, setTaxYearWindowId] = useState('')
  const [loadingWindows, setLoadingWindows] = useState(false)
  const [windowError, setWindowError] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [result, setResult] = useState<RunResult | null>(null)
  const [busy, setBusy] = useState(false)

  const fmt = (v: string) => formatTaxPoolAmount(v, locale)
  const selectedWindow = windows.find((window) => window.id === taxYearWindowId && window.regime === regime && window.subsidiaryId === subsidiaryId)

  useEffect(() => {
    const controller = new AbortController()
    setWindows([])
    setTaxYearWindowId('')
    setResult(null)
    setWindowError(null)
    setRunError(null)
    if (!regime || !subsidiaryId) { setLoadingWindows(false); return }
    setLoadingWindows(true)
    const params = new URLSearchParams({ view: 'windows', regime, subsidiaryId })
    void (async () => {
      try {
        const response = await fetch(`/api/assets/tax-pools?${params}`, { signal: controller.signal })
        if (!response.ok) {
          const error = await response.json().catch(() => null) as { error?: string } | null
          throw new Error(error?.error || t('taxPools.loadWindowsFailed'))
        }
        const data = await response.json() as { windows: TaxWindow[] }
        if (!controller.signal.aborted) setWindows(data.windows)
      } catch (error) {
        if (!controller.signal.aborted) setWindowError(error instanceof Error ? error.message : t('taxPools.loadWindowsFailed'))
      } finally {
        if (!controller.signal.aborted) setLoadingWindows(false)
      }
    })()
    return () => controller.abort()
  }, [regime, subsidiaryId, t])

  async function run() {
    if (!selectedWindow || busy || loadingWindows) return
    setBusy(true)
    setResult(null)
    setRunError(null)
    try {
      const res = await fetch('/api/assets/tax-pools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regime, subsidiaryId, taxYearWindowId: selectedWindow.id }),
      })
      if (!res.ok) {
        const error = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(error?.error || tCommon('feedback.saveFailed'))
      }
      const d = await res.json() as RunResult
      setResult(d)
      toast.success(t('taxPools.done', { count: d.lines.length }))
    } catch (e) {
      const message = e instanceof Error && e.message ? e.message : tCommon('feedback.saveFailed')
      setRunError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  const col = 'px-3 py-2 text-right tabular-nums'
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('taxPools.description')}</p>
        {canConfigure ? (
          <Button asChild variant="outline" size="sm" className="shrink-0">
            <Link href="/admin/setup/tax-depreciation"><Settings2 size={14} />{t('taxPools.configure')}</Link>
          </Button>
        ) : null}
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div className="space-y-1.5">
            <Label htmlFor="tax-subsidiary">{t('taxPools.legalEntity')}</Label>
            <Select id="tax-subsidiary" className="w-64" value={subsidiaryId} disabled={busy} onChange={(event) => {
              setSubsidiaryId(event.target.value); setTaxYearWindowId(''); setResult(null)
            }}>
              {subsidiaries.map((subsidiary) => <option key={subsidiary.id} value={subsidiary.id}>{subsidiary.name}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="regime">{t('taxPools.regime')}</Label>
            <Select id="regime" className="w-64" value={regime} disabled={busy} onChange={(event) => {
              setRegime(event.target.value); setTaxYearWindowId(''); setResult(null)
            }}>
              {regimes.map((r) => (
                <option key={r.code} value={r.code}>{r.name}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tax-year-window">{t('taxPools.window')}</Label>
            <Select id="tax-year-window" className="w-80" value={taxYearWindowId} disabled={busy || loadingWindows} required onChange={(event) => {
              setTaxYearWindowId(event.target.value); setResult(null); setRunError(null)
            }}>
              <option value="">{t('taxPools.chooseWindow')}</option>
              {windows.map((window) => <option key={window.id} value={window.id}>{t('taxPools.windowLabel', {
                filingYear: window.filingYear, start: window.yearStart, end: window.yearEnd,
              })}</option>)}
            </Select>
          </div>
          {canRun ? (
            <Button onClick={run} disabled={busy || loadingWindows || !selectedWindow}>
              <Play size={15} />
              {busy ? t('taxPools.running') : t('taxPools.run')}
            </Button>
          ) : null}
        </CardContent>
      </Card>
      {loadingWindows ? <p role="status">{t('taxPools.loadingWindows')}</p> : windowError ? <p role="alert">{windowError}</p> : windows.length === 0 ? (
        <div className="space-y-2 text-sm">
          <p>{t('taxPools.noWindows')}</p>
          {canConfigure ? <Link className="underline" href="/admin/setup/tax-depreciation?tab=years">{t('taxPools.configureYears')}</Link> : null}
        </div>
      ) : null}

      {runError ? <p role="alert">{runError}</p> : null}

      {result ? (
        result.lines.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('taxPools.empty')}</p>
        ) : (
          <Card>
            <CardContent className="overflow-x-auto pt-6">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
                    <th className="px-3 py-2 text-left font-medium">{t('taxPools.columns.class')}</th>
                    <th className={col}>{t('taxPools.columns.opening')}</th>
                    <th className={col}>{t('taxPools.columns.additions')}</th>
                    <th className={col}>{t('taxPools.columns.dispositions')}</th>
                    <th className={col}>{t('taxPools.columns.allowance')}</th>
                    <th className={col}>{t('taxPools.columns.closing')}</th>
                    <th className={col}>{t('taxPools.columns.recapture')}</th>
                    <th className={col}>{t('taxPools.columns.terminalLoss')}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.lines.map((l) => (
                    <tr key={l.classCode} className="border-b border-slate-100 dark:border-slate-900">
                      <td className="px-3 py-2">
                        <span className="font-medium">{l.classCode}</span>
                        <span className="ml-2 text-slate-500">{l.className}</span>
                      </td>
                      <td className={col}>{fmt(l.openingBalance)}</td>
                      <td className={col}>{fmt(l.additions)}</td>
                      <td className={col}>{fmt(l.dispositions)}</td>
                      <td className={`${col} font-semibold`}>{fmt(l.allowance)}</td>
                      <td className={col}>{fmt(l.closingBalance)}</td>
                      <td className={col}>{decimalCmp(l.recapture, '0') !== 0 ? fmt(l.recapture) : '—'}</td>
                      <td className={col}>{decimalCmp(l.terminalLoss, '0') !== 0 ? fmt(l.terminalLoss) : '—'}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold text-slate-900 dark:text-slate-100">
                    <td className="px-3 py-2">{t('taxPools.totals')}</td>
                    <td className={col} colSpan={3}></td>
                    <td className={col}>{fmt(result.totals.allowance)}</td>
                    <td className={col}></td>
                    <td className={col}>{decimalCmp(result.totals.recapture, '0') !== 0 ? fmt(result.totals.recapture) : '—'}</td>
                    <td className={col}>{decimalCmp(result.totals.terminalLoss, '0') !== 0 ? fmt(result.totals.terminalLoss) : '—'}</td>
                  </tr>
                </tbody>
              </table>
            </CardContent>
          </Card>
        )
      ) : null}
    </div>
  )
}
