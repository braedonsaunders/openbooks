'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { addCalendarDays, addMonthsStart, calendarQuarterBounds, startOfMonth } from '@openbooks/engine/platform/civil-date'
import { useBusinessToday } from '@/components/business-date-provider'
import { ActionError, kindForStatus, transportError, type ActionResult } from '@braedonsaunders/appkit-errors'
import { Badge, Button, Card, CardContent, EmptyState, Input, Label, PageHeader, Select } from '@openbooks/ui'
import { RecordTabs } from '@/components/module-home/record-tabs'
import { KpiStrip } from '@/components/kpi-strip'
import { PagedTable, type PagedColumn } from '@/components/paged-table'
import { ListPageLayout } from '@/components/page-layout'
import { readApiErrorMessage } from '@/lib/api-error'
import { normalizeDecimal, roundMoney } from '@openbooks/engine/money'
import { formatExactPercent } from '@/lib/format'
import { formatDecimal } from '@/lib/money-format'
import { useAppAction } from '@/lib/use-app-action'

type Scheme = 'union' | 'non_union' | 'ioss'

type ExportFormat = 'generic' | 'DE' | 'FR' | 'NL' | 'IE'

interface SupplyConflict {
  documentId: string
  documentNumber: string
  kind: string
  documentDate: string
  countries: string[]
  evidence: { kind: string; country: string }[]
}

interface Turnover {
  year: number
  totalEur: string
  threshold: string
  crossed: boolean
  translated: { currency: string; baseAmount: string; rate: string; rateAsOf: string; rateSource: string }[]
  uncoveredCurrencies: string[]
}

interface FxEvidenceRow {
  currency: string
  rate: string
  rateAsOf: string
  rateSource: string
}

/** Document kinds that open in a record drawer; anything else renders as text. */
const DRAWER_PATH: Record<string, string> = {
  customer_invoice: '/ar/invoices',
  vendor_bill: '/ap/bills',
  cash_sale: '/cash-sales',
}

interface OssLine {
  consumptionCountry: string
  ratePercent: string
  baseAmount: string
  taxAmount: string
  kind: 'supply' | 'correction'
  correctionQuarter: string | null
}

interface OssResult {
  scheme: string
  identificationState: string
  registrationNumber: string
  from: string
  to: string
  currency: string
  lines: OssLine[]
  totalBase: string
  totalTax: string
}

function schemePeriod(scheme: Scheme, anchor: string): { from: string; to: string } {
  if (scheme === 'ioss') return { from: startOfMonth(anchor), to: addCalendarDays(addMonthsStart(anchor, 1), -1) }
  const quarter = calendarQuarterBounds(anchor)
  return { from: quarter.start, to: quarter.end }
}

/**
 * One-Stop-Shop returns workspace. Everyday: pick the scheme and period,
 * prepare the return, review per-state lines with corrections flagged, and
 * export the filing file. Configure: the OSS registration lives in Tax
 * setup — the empty and refusal states link straight there. Advanced: the
 * translation evidence, evidence conflicts and distance-sales threshold
 * each have a separate shared tab; the return retains its export controls.
 */
export function OssConsole({ setupHref }: { setupHref: string }) {
  const t = useTranslations('tax.oss')
  const tc = useTranslations('common')
  const locale = useLocale()
  const router = useRouter()
  const today = useBusinessToday()
  const defaults = useMemo(() => schemePeriod('union', today), [today])
  const [activeTab, setActiveTab] = useState<'return' | 'conflicts' | 'fx' | 'threshold'>('return')
  const [scheme, setScheme] = useState<Scheme>('union')
  const [from, setFrom] = useState(defaults.from)
  const [to, setTo] = useState(defaults.to)
  const [result, setResult] = useState<OssResult | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [format, setFormat] = useState<ExportFormat>('generic')
  const [conflicts, setConflicts] = useState<SupplyConflict[] | null>(null)
  const [turnover, setTurnover] = useState<Turnover | null>(null)
  const [contextErrors, setContextErrors] = useState<Partial<Record<'conflicts' | 'fx' | 'threshold', string>>>({})
  const [evidence, setEvidence] = useState<FxEvidenceRow[] | null>(null)
  const { busy, execute } = useAppAction()

  async function readJson<T>(url: string): Promise<T> {
    const res = await fetch(url)
    if (!res.ok) throw new Error(await readApiErrorMessage(res, t('contextUnavailable')))
    return (await res.json()) as T
  }

  async function refreshContext(next: OssResult) {
    const params = new URLSearchParams({ scheme, from, to })
    const year = Number(next.to.slice(0, 4))
    setConflicts(null)
    setTurnover(null)
    setEvidence(null)
    setContextErrors({})
    const [conflictBody, turnoverBody, evidenceBody] = await Promise.allSettled([
      readJson<{ conflicts: SupplyConflict[] }>('/api/tax/oss-returns/conflicts'),
      readJson<Turnover>(`/api/tax/oss-returns/turnover?year=${year}`),
      readJson<{ rows: FxEvidenceRow[] }>(`/api/tax/oss-returns/fx-evidence?${params.toString()}`),
    ])
    const errors: Partial<Record<'conflicts' | 'fx' | 'threshold', string>> = {}
    const message = (error: unknown) => error instanceof Error ? error.message : t('contextUnavailable')
    if (conflictBody.status === 'fulfilled') setConflicts(conflictBody.value.conflicts)
    else errors.conflicts = message(conflictBody.reason)
    if (turnoverBody.status === 'fulfilled') setTurnover(turnoverBody.value)
    else errors.threshold = message(turnoverBody.reason)
    if (evidenceBody.status === 'fulfilled') setEvidence(evidenceBody.value.rows)
    else errors.fx = message(evidenceBody.reason)
    setContextErrors(errors)
  }

  async function runPrepare(): Promise<ActionResult<OssResult>> {
    try {
      const params = new URLSearchParams({ scheme, from, to })
      const res = await fetch(`/api/tax/oss-returns?${params.toString()}`)
      if (!res.ok) {
        return {
          ok: false as const,
          error: new ActionError({
            kind: kindForStatus(res.status),
            status: res.status,
            code: 'prepare',
            serverMessage: await readApiErrorMessage(res, t('prepareFailed')),
          }),
        }
      }
      return { ok: true as const, status: res.status, data: (await res.json()) as OssResult }
    } catch (error) {
      return { ok: false as const, error: transportError(error instanceof Error ? error.message : String(error)) }
    }
  }

  async function prepare() {
    setFailure(null)
    const fallback = t('prepareFailed')
    await execute(() => runPrepare(), {
      fallbackMessage: fallback,
      onRefused: (error) => {
        setFailure(error.displayMessage(fallback))
        setResult(null)
      },
      onOk: (data) => {
        setResult(data)
        void refreshContext(data)
      },
    })
  }

  const columns: PagedColumn<OssLine>[] = [
    { key: 'record', header: t('columns.record'), cell: (row) => (
      row.kind === 'correction'
        ? <Badge variant="warning">{t('correction', { quarter: row.correctionQuarter ?? '' })}</Badge>
        : <Badge variant="secondary">{t('current')}</Badge>
    ) },
    { key: 'country', header: t('columns.country'), cell: (row) => row.consumptionCountry, search: (row) => row.consumptionCountry },
    { key: 'rate', header: t('columns.rate'), align: 'right', cell: (row) => formatExactPercent(normalizeDecimal(roundMoney(row.ratePercent, 2), 2), locale, 2) },
    { key: 'base', header: t('columns.base'), align: 'right', cell: (row) => formatDecimal(locale, row.baseAmount, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
    { key: 'vat', header: t('columns.vat'), align: 'right', cell: (row) => formatDecimal(locale, row.taxAmount, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
  ]

  const evidenceColumns: PagedColumn<FxEvidenceRow>[] = [
    { key: 'currency', header: t('fx.columns.currency'), cell: (row) => row.currency },
    { key: 'rate', header: t('fx.columns.rate'), align: 'right', cell: (row) => formatDecimal(locale, row.rate, { minimumFractionDigits: 4, maximumFractionDigits: 4 }) },
    { key: 'asOf', header: t('fx.columns.asOf'), cell: (row) => row.rateAsOf },
    { key: 'source', header: t('fx.columns.source'), cell: (row) => row.rateSource },
  ]

  return (
    <ListPageLayout header={<PageHeader title={t('title')} description={t('description')} />}>
      <div className="grid grid-cols-[12rem_10rem_10rem_auto] items-end gap-3">
        <div className="space-y-1.5">
          <Label>{t('scheme')}</Label>
          <Select value={scheme} disabled={busy} onChange={(event) => {
            const next = event.target.value as Scheme
            const period = schemePeriod(next, /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : today)
            setScheme(next)
            setFrom(period.from)
            setTo(period.to)
            setResult(null)
            setFailure(null)
          }}>
            <option value="union">{t('schemes.union')}</option>
            <option value="non_union">{t('schemes.nonUnion')}</option>
            <option value="ioss">{t('schemes.ioss')}</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>{t('from')}</Label>
          <Input type="date" value={from} disabled={busy} onChange={(event) => { setFrom(event.target.value); setResult(null); setFailure(null) }} />
        </div>
        <div className="space-y-1.5">
          <Label>{t('to')}</Label>
          <Input type="date" value={to} disabled={busy} onChange={(event) => { setTo(event.target.value); setResult(null); setFailure(null) }} />
        </div>
        <Button disabled={busy} onClick={() => void prepare()}>
          {busy ? t('preparing') : t('prepare')}
        </Button>
      </div>
      {failure ? <p className="text-sm text-red-600 dark:text-red-400">{failure}</p> : null}
      {!result && !failure ? (
        <EmptyState
          title={t('emptyTitle')}
          description={t('emptyDescription')}
          action={<Button variant="outline" onClick={() => router.push(setupHref)}>{t('setupAction')}</Button>}
        />
      ) : null}
      {result ? (
        <RecordTabs
          label={t('title')}
          active={activeTab}
          onChange={setActiveTab}
          tabs={[
            { key: 'return', label: t('tabs.return') },
            { key: 'conflicts', label: t('tabs.conflicts'), count: conflicts?.length },
            { key: 'fx', label: t('tabs.fx') },
            { key: 'threshold', label: t('tabs.threshold') },
          ]}
        >
          {contextErrors[activeTab as 'conflicts' | 'fx' | 'threshold'] ? (
            <div role="alert" className="space-y-2">
              <p>{contextErrors[activeTab as 'conflicts' | 'fx' | 'threshold']}</p>
              <Button variant="outline" size="sm" onClick={() => void refreshContext(result)}>{tc('actions.retry')}</Button>
            </div>
          ) : null}
          {activeTab === 'return' ? <div className="space-y-4">
          <KpiStrip
            items={[
              { label: t('totalBase'), value: formatDecimal(locale, result.totalBase, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
              { label: t('totalVat'), value: formatDecimal(locale, result.totalTax, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
              { label: t('registration'), value: `${result.identificationState} · ${result.registrationNumber}` },
            ]}
          />
          <PagedTable
            rows={result.lines}
            columns={columns}
            rowKey={(row, index) => `${row.kind}-${row.consumptionCountry}-${row.ratePercent}-${index}`}
            empty={<EmptyState title={t('noLinesTitle')} description={t('noLinesDescription')} />}
          />
          <div className="flex items-end gap-3">
            <div className="space-y-1.5">
              <Label>{t('format')}</Label>
              <Select value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}>
                <option value="generic">{t('formats.generic')}</option>
                <option value="DE">{t('formats.DE')}</option>
                <option value="FR">{t('formats.FR')}</option>
                <option value="NL">{t('formats.NL')}</option>
                <option value="IE">{t('formats.IE')}</option>
              </Select>
            </div>
            <Button variant="outline" asChild>
              <a
                href={`/api/tax/oss-returns/export?${new URLSearchParams({ scheme, from, to, format }).toString()}`}
                download
              >
                {t('export')}
              </a>
            </Button>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t(`exportNotes.${format}`)}</p>
          </div> : null}
          {activeTab === 'conflicts' && !contextErrors.conflicts ? (
            (conflicts?.length ?? 0) > 0 ? (
            <Card>
              <CardContent className="space-y-2 py-4">
                <div className="flex items-center gap-2">
                  <Badge variant="warning">{t('conflicts.badge', { count: conflicts!.length })}</Badge>
                  <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('conflicts.title')}</p>
                </div>
                <p className="text-sm text-slate-500 dark:text-slate-400">{t('conflicts.description')}</p>
                <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                  {conflicts!.map((conflict) => {
                    const drawer = DRAWER_PATH[conflict.kind]
                    return (
                      <li key={conflict.documentId} className="flex items-center justify-between gap-3 py-2">
                        <div className="text-sm">
                          <span className="font-medium text-slate-900 dark:text-slate-100">{conflict.documentNumber}</span>
                          <span className="ml-2 text-slate-500 dark:text-slate-400">
                            {t('conflicts.countries', { countries: conflict.countries.join(', ') })}
                          </span>
                          <span className="ml-2 text-xs text-slate-400 dark:text-slate-500">
                            {conflict.evidence.map((signal) => `${signal.kind} ${signal.country}`).join(' · ')}
                          </span>
                        </div>
                        {drawer ? (
                          <Button variant="outline" size="sm" asChild>
                            <a href={`${drawer}?doc=${conflict.documentId}`}>{t('conflicts.fix')}</a>
                          </Button>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              </CardContent>
            </Card>
          ) : conflicts === null ? <p role="status">{tc('feedback.loading')}</p> : <EmptyState title={t('conflicts.clearTitle')} description={t('conflicts.clearDescription')} />
          ) : null}
          {activeTab === 'fx' && !contextErrors.fx ? (
              <div className="space-y-2">
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('fx.title')}</p>
                {(evidence?.length ?? 0) > 0 ? (
                  <PagedTable
                    rows={evidence!}
                    columns={evidenceColumns}
                    rowKey={(row) => row.currency}
                    empty={<EmptyState title={t('noLinesTitle')} description={t('noLinesDescription')} />}
                  />
                ) : (
                  <p role="status" className="text-sm text-slate-500 dark:text-slate-400">{evidence === null ? tc('feedback.loading') : t('fx.pending')}</p>
                )}
              </div>
            ) : null}
          {activeTab === 'threshold' && !contextErrors.threshold ? (turnover ? (
              <div className="space-y-2">
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('threshold.title')}</p>
                <div className="flex items-center gap-2">
                  <Badge variant={turnover.crossed ? 'destructive' : 'success'}>
                    {turnover.crossed ? t('threshold.crossed') : t('threshold.within')}
                  </Badge>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {t('threshold.status', {
                      total: formatDecimal(locale, turnover.totalEur, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                      threshold: formatDecimal(locale, turnover.threshold, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                      year: turnover.year,
                    })}
                  </p>
                </div>
                {turnover.translated.length > 0 ? (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {turnover.translated
                      .map((line) => t('threshold.translated', {
                        currency: line.currency,
                        base: formatDecimal(locale, line.baseAmount, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                        rate: formatDecimal(locale, line.rate, { minimumFractionDigits: 4, maximumFractionDigits: 4 }),
                        asOf: line.rateAsOf,
                      }))
                      .join(' · ')}
                  </p>
                ) : null}
                {turnover.uncoveredCurrencies.length > 0 ? (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    {t('threshold.uncovered', { currencies: turnover.uncoveredCurrencies.join(', ') })}
                  </p>
                ) : null}
              </div>
            ) : <p role="status" className="text-sm text-slate-500">{tc('feedback.loading')}</p>) : null}
        </RecordTabs>
      ) : null}
    </ListPageLayout>
  )
}
