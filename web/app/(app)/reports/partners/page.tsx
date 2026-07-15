import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Badge, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { Pagination } from '../../../../components/pagination'
import { parseListParams } from '../../../../lib/list-params'
import { partnerBalances } from '../../../../lib/reports'
import { money } from '../../../../lib/format'
import { StatementExport } from '../StatementExport'

export const dynamic = 'force-dynamic'
const PER_PAGE = 50

export default async function Partners({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations('reports.partners')
  const tr = await getTranslations('reports')
  const tc = await getTranslations('common')
  const sp = await searchParams
  const k = sp.kind === 'receivable' ? 'receivable' : 'payable'
  const params = parseListParams(sp, { sort: 'balance', allowedSorts: ['balance'] as const, perPage: PER_PAGE })
  const flip = k === 'payable' ? -1 : 1
  const all = await partnerBalances(k)
  const q = params.q?.toLowerCase()
  const filtered = q ? all.filter((r) => (r.display_name ?? '').toLowerCase().includes(q)) : all
  const total = filtered.reduce((a, r) => a + Number(r.balance), 0)
  const rows = filtered.slice((params.page - 1) * PER_PAGE, params.page * PER_PAGE)

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={k === 'payable' ? t('payablesTitle') : t('receivablesTitle')}
            description={t('description')}
            back={{ href: '/reports', label: tr('hub.title') }}
            actions={<StatementExport kind="partners" params={{ side: k }} />}
          />
          <div className="flex items-center gap-2">
            <Link href="/reports/partners?kind=payable">
              <Badge variant={k === 'payable' ? 'default' : 'outline'}>{t('payables')}</Badge>
            </Link>
            <Link href="/reports/partners?kind=receivable">
              <Badge variant={k === 'receivable' ? 'default' : 'outline'}>{t('receivables')}</Badge>
            </Link>
          </div>
          <SearchInput placeholder={t('searchPlaceholder')} />
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('totalOutstanding')}: <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200">{money(flip * total)}</span>
          </p>
        </>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{tc('labels.party')}</TableHead>
            <TableHead className="text-right">{t('columns.outstanding')}</TableHead>
            <TableHead className="text-right">{t('columns.glLines')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={r.id ?? `none-${i}`}>
              <TableCell>
                {r.display_name ?? <span className="text-slate-400 italic">{t('noPartyOnLines')}</span>}
              </TableCell>
              <TableCell
                className={cn('text-right tabular-nums', flip * Number(r.balance) < 0 && 'text-red-600 dark:text-red-400')}
              >
                {money(flip * Number(r.balance))}
              </TableCell>
              <TableCell className="text-right tabular-nums">{r.line_count}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="mt-3">
        <Pagination basePath="/reports/partners" currentParams={sp} total={filtered.length} page={params.page} perPage={PER_PAGE} />
      </div>
    </ListPageLayout>
  )
}
