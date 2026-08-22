'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Play, Settings2 } from 'lucide-react'
import { Button, Card, CardContent, Input, Label, Select } from '@openbooks/ui'

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

export function TaxPoolsView({
  canRun,
  canConfigure,
  regimes,
  defaultTaxYear,
}: {
  canRun: boolean
  canConfigure: boolean
  regimes: { code: string; name: string }[]
  /** Last completed calendar year on the org business day — never browser UTC. */
  defaultTaxYear: number
}) {
  const t = useTranslations('assets')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const [taxYear, setTaxYear] = useState(defaultTaxYear)
  const [regime, setRegime] = useState(regimes.find((r) => r.code === 'ca_cca')?.code ?? regimes[0]?.code ?? 'ca_cca')
  const [result, setResult] = useState<RunResult | null>(null)
  const [busy, setBusy] = useState(false)

  const fmt = (v: string) => Number(v).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  async function run() {
    setBusy(true)
    try {
      const res = await fetch('/api/assets/tax-pools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regime, taxYear }),
      })
      const d = (await res.json().catch(() => ({}))) as RunResult & { error?: string }
      if (!res.ok) throw new Error(d.error)
      setResult(d)
      toast.success(t('taxPools.done', { count: d.lines.length }))
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : tCommon('feedback.saveFailed'))
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
            <Label htmlFor="regime">{t('taxPools.regime')}</Label>
            <Select id="regime" className="w-64" value={regime} onChange={(e) => setRegime(e.target.value)}>
              {regimes.map((r) => (
                <option key={r.code} value={r.code}>{r.name}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tax-year">{t('taxPools.taxYear')}</Label>
            <Input id="tax-year" type="number" className="w-32" value={taxYear}
              onChange={(e) => setTaxYear(Number(e.target.value))} />
          </div>
          {canRun ? (
            <Button onClick={run} disabled={busy}>
              <Play size={15} />
              {busy ? t('taxPools.running') : t('taxPools.run')}
            </Button>
          ) : null}
        </CardContent>
      </Card>

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
                      <td className={col}>{Number(l.recapture) ? fmt(l.recapture) : '—'}</td>
                      <td className={col}>{Number(l.terminalLoss) ? fmt(l.terminalLoss) : '—'}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold text-slate-900 dark:text-slate-100">
                    <td className="px-3 py-2">{t('taxPools.totals')}</td>
                    <td className={col} colSpan={3}></td>
                    <td className={col}>{fmt(result.totals.allowance)}</td>
                    <td className={col}></td>
                    <td className={col}>{Number(result.totals.recapture) ? fmt(result.totals.recapture) : '—'}</td>
                    <td className={col}>{Number(result.totals.terminalLoss) ? fmt(result.totals.terminalLoss) : '—'}</td>
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
