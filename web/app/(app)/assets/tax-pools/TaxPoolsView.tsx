'use client'

import { Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableHead as SharedTableHead, TableBody as SharedTableBody, TableCell as SharedTableCell } from "@openbooks/ui"
import { useRef, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Play, Settings2 } from 'lucide-react'
import { Button, Card, CardContent, Input, Label, Select } from '@openbooks/ui'
import { decimalCmp } from '../../../../lib/statement-format'
import { formatDecimal } from '../../../../lib/money-format'

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
type RunResult = { regime: string; taxYear: number; lines: Line[]; totals: { allowance: string; recapture: string; terminalLoss: string } }

export function formatTaxPoolAmount(value: string, locale: string): string {
  return formatDecimal(locale, value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

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
  const runId = useRef(0)

  const fmt = (v: string) => formatTaxPoolAmount(v, locale)

  async function run() {
    const id = ++runId.current
    const submittedRegime = regime
    const submittedTaxYear = taxYear
    setBusy(true)
    try {
      const res = await fetch('/api/assets/tax-pools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regime: submittedRegime, taxYear: submittedTaxYear }),
      })
      const d = (await res.json().catch(() => ({}))) as RunResult & { error?: string }
      if (!res.ok) throw new Error(d.error)
      if (id !== runId.current) return
      setResult({ ...d, regime: submittedRegime, taxYear: submittedTaxYear })
      toast.success(t('taxPools.done', { count: d.lines.length }))
    } catch (e) {
      if (id !== runId.current) return
      toast.error(e instanceof Error && e.message ? e.message : tCommon('feedback.saveFailed'))
    } finally {
      if (id === runId.current) setBusy(false)
    }
  }

  function changeRegime(value: string) {
    runId.current += 1
    setBusy(false)
    setResult(null)
    setRegime(value)
  }

  function changeTaxYear(value: number) {
    runId.current += 1
    setBusy(false)
    setResult(null)
    setTaxYear(value)
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
            <Select id="regime" className="w-64" value={regime} onChange={(e) => changeRegime(e.target.value)}>
              {regimes.map((r) => (
                <option key={r.code} value={r.code}>{r.name}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tax-year">{t('taxPools.taxYear')}</Label>
            <Input id="tax-year" type="number" className="w-32" value={taxYear}
              onChange={(e) => changeTaxYear(Number(e.target.value))} />
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
              <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
                {regimes.find((item) => item.code === result.regime)?.name ?? result.regime} · {result.taxYear}
              </p>
              <SharedTable className="w-full text-sm">
                <SharedTableHeader>
                  <SharedTableRow className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
                    <SharedTableHead className="px-3 py-2 text-left font-medium">{t('taxPools.columns.class')}</SharedTableHead>
                    <SharedTableHead className={col}>{t('taxPools.columns.opening')}</SharedTableHead>
                    <SharedTableHead className={col}>{t('taxPools.columns.additions')}</SharedTableHead>
                    <SharedTableHead className={col}>{t('taxPools.columns.dispositions')}</SharedTableHead>
                    <SharedTableHead className={col}>{t('taxPools.columns.allowance')}</SharedTableHead>
                    <SharedTableHead className={col}>{t('taxPools.columns.closing')}</SharedTableHead>
                    <SharedTableHead className={col}>{t('taxPools.columns.recapture')}</SharedTableHead>
                    <SharedTableHead className={col}>{t('taxPools.columns.terminalLoss')}</SharedTableHead>
                  </SharedTableRow>
                </SharedTableHeader>
                <SharedTableBody>
                  {result.lines.map((l) => (
                    <SharedTableRow key={l.classCode} className="border-b border-slate-100 dark:border-slate-900">
                      <SharedTableCell className="px-3 py-2">
                        <span className="font-medium">{l.classCode}</span>
                        <span className="ml-2 text-slate-500">{l.className}</span>
                      </SharedTableCell>
                      <SharedTableCell className={col}>{fmt(l.openingBalance)}</SharedTableCell>
                      <SharedTableCell className={col}>{fmt(l.additions)}</SharedTableCell>
                      <SharedTableCell className={col}>{fmt(l.dispositions)}</SharedTableCell>
                      <SharedTableCell className={`${col} font-semibold`}>{fmt(l.allowance)}</SharedTableCell>
                      <SharedTableCell className={col}>{fmt(l.closingBalance)}</SharedTableCell>
                      <SharedTableCell className={col}>{decimalCmp(l.recapture, '0') !== 0 ? fmt(l.recapture) : '—'}</SharedTableCell>
                      <SharedTableCell className={col}>{decimalCmp(l.terminalLoss, '0') !== 0 ? fmt(l.terminalLoss) : '—'}</SharedTableCell>
                    </SharedTableRow>
                  ))}
                  <SharedTableRow className="font-semibold text-slate-900 dark:text-slate-100">
                    <SharedTableCell className="px-3 py-2">{t('taxPools.totals')}</SharedTableCell>
                    <SharedTableCell className={col} colSpan={3}></SharedTableCell>
                    <SharedTableCell className={col}>{fmt(result.totals.allowance)}</SharedTableCell>
                    <SharedTableCell className={col}></SharedTableCell>
                    <SharedTableCell className={col}>{decimalCmp(result.totals.recapture, '0') !== 0 ? fmt(result.totals.recapture) : '—'}</SharedTableCell>
                    <SharedTableCell className={col}>{decimalCmp(result.totals.terminalLoss, '0') !== 0 ? fmt(result.totals.terminalLoss) : '—'}</SharedTableCell>
                  </SharedTableRow>
                </SharedTableBody>
              </SharedTable>
            </CardContent>
          </Card>
        )
      ) : null}
    </div>
  )
}
