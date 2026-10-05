'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { ActionError, kindForStatus, transportError, type ActionResult } from '@braedonsaunders/appkit-errors'
import { Badge, Button, EmptyState, Input, Label, PageHeader, Select } from '@openbooks/ui'
import { KpiStrip } from '@/components/kpi-strip'
import { PagedTable, type PagedColumn } from '@/components/paged-table'
import { ListPageLayout } from '@/components/page-layout'
import { readApiErrorMessage } from '@/lib/api-error'
import { formatExactPercent } from '@/lib/format'
import { formatDecimal } from '@/lib/money-format'
import { useAppAction } from '@/lib/use-app-action'

type Scheme = 'union' | 'non_union' | 'ioss'

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

function currentQuarter(): { from: string; to: string } {
  const now = new Date()
  const quarter = Math.floor(now.getMonth() / 3)
  const year = now.getFullYear()
  const from = new Date(Date.UTC(year, quarter * 3, 1))
  const to = new Date(Date.UTC(year, quarter * 3 + 3, 0))
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
}

/**
 * One-Stop-Shop returns workspace. Everyday: pick the scheme and period,
 * prepare the return, review per-state lines with corrections flagged, and
 * export the filing CSV. Configure: the OSS registration lives in Tax
 * setup — the empty and refusal states link straight there.
 */
export function OssConsole({ setupHref }: { setupHref: string }) {
  const t = useTranslations('tax.oss')
  const locale = useLocale()
  const router = useRouter()
  const defaults = useMemo(() => currentQuarter(), [])
  const [scheme, setScheme] = useState<Scheme>('union')
  const [from, setFrom] = useState(defaults.from)
  const [to, setTo] = useState(defaults.to)
  const [result, setResult] = useState<OssResult | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const { busy, execute } = useAppAction()

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
      onOk: (data) => setResult(data),
    })
  }

  const columns: PagedColumn<OssLine>[] = [
    { key: 'record', header: t('columns.record'), cell: (row) => (
      row.kind === 'correction'
        ? <Badge variant="warning">{t('correction', { quarter: row.correctionQuarter ?? '' })}</Badge>
        : <Badge variant="secondary">{t('current')}</Badge>
    ) },
    { key: 'country', header: t('columns.country'), cell: (row) => row.consumptionCountry, search: (row) => row.consumptionCountry },
    { key: 'rate', header: t('columns.rate'), align: 'right', cell: (row) => formatExactPercent(row.ratePercent, locale, 2) },
    { key: 'base', header: t('columns.base'), align: 'right', cell: (row) => formatDecimal(locale, row.baseAmount, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
    { key: 'vat', header: t('columns.vat'), align: 'right', cell: (row) => formatDecimal(locale, row.taxAmount, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
  ]

  return (
    <ListPageLayout header={<PageHeader title={t('title')} description={t('description')} />}>
      <div className="grid grid-cols-[12rem_10rem_10rem_auto] items-end gap-3">
        <div className="space-y-1.5">
          <Label>{t('scheme')}</Label>
          <Select value={scheme} onChange={(event) => setScheme(event.target.value as Scheme)}>
            <option value="union">{t('schemes.union')}</option>
            <option value="non_union">{t('schemes.nonUnion')}</option>
            <option value="ioss">{t('schemes.ioss')}</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>{t('from')}</Label>
          <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t('to')}</Label>
          <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
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
        <div className="space-y-4">
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
          <div>
            <Button
              variant="outline"
              asChild
            >
              <a href={`/api/tax/oss-returns/export?${new URLSearchParams({ scheme, from, to }).toString()}`} download>
                {t('exportCsv')}
              </a>
            </Button>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('exportNote')}</p>
          </div>
        </div>
      ) : null}
    </ListPageLayout>
  )
}
