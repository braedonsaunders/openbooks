import Link from 'next/link'
import { Plus } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { Pagination } from '../../../../../components/pagination'
import { SearchInput } from '../../../../../components/search-input'
import { mergeHref } from '../../../../../lib/list-params'

export interface TaxRateRow {
  id: string
  rate_percent: string
  effective_from: string
  effective_to: string | null
}

interface Props {
  taxCode: string
  rows: TaxRateRow[]
  total: number
  page: number
  perPage: number
  currentParams: Record<string, string | string[] | undefined>
}

/** The effective-dated rates owned by an open Tax Code drawer. */
export async function TaxRatesTab({
  taxCode,
  rows,
  total,
  page,
  perPage,
  currentParams,
}: Props) {
  const t = await getTranslations('admin.setup')
  const createHref = mergeHref('/admin/setup/tax-codes', currentParams, {
    setupTab: 'tax-rates',
    rateRow: 'new',
  })

  return (
    <div className="space-y-4 p-1">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {t('taxRates.description', { code: taxCode })}
          </p>
          <Link
            href="/docs/tax-configuration"
            className="mt-1 inline-block text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
          >
            {t('learnMore')}
          </Link>
        </div>
        <Button asChild size="sm">
          <Link href={(createHref)}>
            <Plus size={14} />
            {t('taxRates.new')}
          </Link>
        </Button>
      </div>

      <SearchInput
        placeholder={t('taxRates.searchPlaceholder')}
        paramKey="taxRateQ"
        pageParamKey="taxRatePage"
        className="sm:w-full"
      />

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('fields.ratePercent')}</TableHead>
              <TableHead>{t('fields.effectiveFrom')}</TableHead>
              <TableHead>{t('fields.effectiveTo')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="text-slate-500 dark:text-slate-400">
                  {t('taxRates.empty')}
                </TableCell>
              </TableRow>
            ) : null}
            {rows.map((row) => {
              const editHref = mergeHref('/admin/setup/tax-codes', currentParams, {
                setupTab: 'tax-rates',
                rateRow: row.id,
              })
              return (
                <TableRow key={row.id}>
                  <TableCell className="text-right tabular-nums">
                    <Link
                      href={(editHref)}
                      className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                    >
                      {Number(row.rate_percent)}%
                    </Link>
                  </TableCell>
                  <TableCell>{row.effective_from}</TableCell>
                  <TableCell>{row.effective_to ?? '—'}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        <Pagination
          basePath="/admin/setup/tax-codes"
          currentParams={currentParams}
          total={total}
          page={page}
          perPage={perPage}
          pageParamKey="taxRatePage"
        />
      </div>
    </div>
  )
}
