import { getMoneyFormatter } from '@/lib/money-server'
import { getTranslations } from 'next-intl/server'
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, UrlDrawer } from '@openbooks/ui'
import { SearchInput } from '../../../../components/search-input'
import { Pagination } from '../../../../components/pagination'
import { SortableTh } from '../../../../components/sortable-th'
import { mergeHref } from '../../../../lib/list-params'
const MATCH_VARIANT: Record<string, 'success' | 'secondary' | 'outline'> = {
  matched: 'success',
  unmatched: 'secondary',
  excluded: 'outline',
}

// Known match_status enum values — unknown values render verbatim.
const MATCH_STATUS_KEYS = ['matched', 'unmatched', 'excluded']

/**
 * Read-only flyout over the account view (?statement=<id>) showing an
 * imported statement's lines — the immutable bank-side truth.
 */
export async function StatementDrawer({
  basePath,
  currentParams,
  statement,
  lines,
  lineTotal,
  page,
  perPage,
  sort,
  dir,
}: {
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
  statement: {
    id: string
    source: string
    statement_date: string
    opening_balance: string | null
    closing_balance: string | null
    imported_at: string
  }
  lines: {
    id: string
    line_number: number
    posted_on: string
    amount: string
    description: string | null
    counterparty_ref: string | null
    match_status: string
  }[]
  lineTotal: number
  page: number
  perPage: number
  sort: string
  dir: 'asc' | 'desc'
}) {
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('banking')
  const tCommon = await getTranslations('common')
  const closeHref = mergeHref(basePath, currentParams, {
    statement: undefined,
    slQ: undefined,
    slSort: undefined,
    slDir: undefined,
    slPage: undefined,
    slPerPage: undefined,
  })
  const sortProps = {
    basePath,
    currentParams,
    sort,
    dir,
    sortParamKey: 'slSort',
    dirParamKey: 'slDir',
    pageParamKey: 'slPage',
  }

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="xl"
      title={
        <span className="flex items-center gap-2.5">
          {t('drawer.title', { date: statement.statement_date })}
          <Badge variant="outline">{statement.source}</Badge>
        </span>
      }
      description={t('drawer.description', {
        date: new Date(statement.imported_at).toLocaleDateString('en-CA'),
        opening: statement.opening_balance != null ? money(statement.opening_balance) : '—',
        closing: statement.closing_balance != null ? money(statement.closing_balance) : '—',
      })}
    >
      <div className="space-y-3">
        <SearchInput placeholder={t('drawer.searchLines')} paramKey="slQ" pageParamKey="slPage" />
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTh {...sortProps} column="line" active={sort === 'line'}>#</SortableTh>
              <SortableTh {...sortProps} column="date" active={sort === 'date'}>{tCommon('labels.date')}</SortableTh>
              <TableHead>{tCommon('labels.description')}</TableHead>
              <TableHead>{t('labels.ref')}</TableHead>
              <SortableTh {...sortProps} column="amount" active={sort === 'amount'} align="right">{tCommon('labels.amount')}</SortableTh>
              <TableHead>{t('drawer.matchColumn')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-slate-500 dark:text-slate-400">
                  {t('drawer.noLines')}
                </TableCell>
              </TableRow>
            ) : (
              lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="text-slate-500 tabular-nums dark:text-slate-400">{l.line_number}</TableCell>
                  <TableCell className="whitespace-nowrap">{l.posted_on}</TableCell>
                  <TableCell className="max-w-[20rem] truncate">{l.description ?? '—'}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{l.counterparty_ref ?? ''}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.amount)}</TableCell>
                  <TableCell>
                    <Badge variant={MATCH_VARIANT[l.match_status] ?? 'secondary'}>
                      {MATCH_STATUS_KEYS.includes(l.match_status) ? t(`matchStatus.${l.match_status}`) : l.match_status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <Pagination
          basePath={basePath}
          currentParams={currentParams}
          total={lineTotal}
          page={page}
          perPage={perPage}
          pageParamKey="slPage"
        />
      </div>
    </UrlDrawer>
  )
}
