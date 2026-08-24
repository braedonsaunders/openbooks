import Link from 'next/link'
import { Plus } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import {
  Badge,
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

export interface TaxReturnBoxRow {
  id: string
  report_code: string
  line_code: string
  label: string
  basis: string | null
  formula: string | null
  tax_code_id: string | null
}

interface Props {
  returnCode: string
  rows: TaxReturnBoxRow[]
  total: number
  page: number
  perPage: number
  currentParams: Record<string, string | string[] | undefined>
}

const BASIS_KEYS: Record<string, string> = {
  tax_collected: 'collected',
  tax_paid: 'paid',
  tax_amount: 'tax',
  taxable_base: 'net',
}

/** The box definitions owned by an open Tax Return drawer. */
export async function TaxReturnBoxesTab({
  returnCode,
  rows,
  total,
  page,
  perPage,
  currentParams,
}: Props) {
  const t = await getTranslations('admin.setup')
  const createHref = mergeHref('/admin/setup/tax-return-forms', currentParams, {
    setupTab: 'tax-return-boxes',
    boxRow: 'new',
  })

  return (
    <div className="space-y-4 p-1">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {t('taxBoxes.description', { code: returnCode })}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {t('taxBoxes.calculatedNote')}{' '}
            <Link
              href="/docs/tax-configuration"
              className="font-medium text-teal-700 hover:underline dark:text-teal-300"
            >
              {t('learnMore')}
            </Link>
          </p>
        </div>
        <Button asChild size="sm">
          <Link href={(createHref)}>
            <Plus size={14} />
            {t('taxBoxes.new')}
          </Link>
        </Button>
      </div>

      <SearchInput
        placeholder={t('taxBoxes.searchPlaceholder')}
        paramKey="taxBoxQ"
        pageParamKey="taxBoxPage"
        className="sm:w-full"
      />

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('fields.lineCode')}</TableHead>
              <TableHead>{t('fields.label')}</TableHead>
              <TableHead>{t('taxBoxes.source')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="text-slate-500 dark:text-slate-400">
                  {t('taxBoxes.empty')}
                </TableCell>
              </TableRow>
            ) : null}
            {rows.map((row) => {
              const editHref = mergeHref('/admin/setup/tax-return-forms', currentParams, {
                setupTab: 'tax-return-boxes',
                boxRow: row.id,
              })
              const basisKey = row.basis ? BASIS_KEYS[row.basis] : undefined
              return (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link
                      href={(editHref)}
                      className="font-mono text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
                    >
                      {row.line_code}
                    </Link>
                  </TableCell>
                  <TableCell>{row.label}</TableCell>
                  <TableCell>
                    {row.tax_code_id ? (
                      <Badge variant="outline">
                        {basisKey ? t(`options.basis.${basisKey}`) : t('taxBoxes.mapped')}
                      </Badge>
                    ) : (
                      <Badge variant={row.formula ? 'secondary' : 'outline'}>
                        {t(row.formula ? 'taxBoxes.calculated' : 'taxBoxes.manual')}
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        <Pagination
          basePath="/admin/setup/tax-return-forms"
          currentParams={currentParams}
          total={total}
          page={page}
          perPage={perPage}
          pageParamKey="taxBoxPage"
        />
      </div>
    </div>
  )
}
