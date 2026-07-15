import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { getSource } from '@openbooks/analytics'
import { db } from '@openbooks/engine/src/db.ts'
import {
  Badge,
  EmptyState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { SortTh } from '../../../components/sortable-th'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, parseListParams, pickString } from '../../../lib/list-params'
import { loadCard } from '../../api/insights/_lib'
import { InsightsTabs } from './InsightsTabs'
import { NewCardButton } from './NewCardButton'
import { CardStudio } from './CardStudio'
import { VIZ_META } from './viz-meta'

export const dynamic = 'force-dynamic'

const SORT_COLUMNS = {
  name: sql`name`,
  updated: sql`updated_at`,
} as const

export default async function InsightsCards({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [t, tCommon] = await Promise.all([getTranslations('insights'), getTranslations('common')])
  const authz = await requirePermission('insights.read')
  const canCreate = can(authz, 'insights.create')
  const canPublish = can(authz, 'insights.publish')
  const orgId = authz.user.orgId

  const sp = await searchParams
  const cardId = typeof sp.card === 'string' ? sp.card : undefined
  const params = parseListParams(sp, {
    sort: 'updated',
    dir: 'desc',
    perPage: 25,
    allowedSorts: ['name', 'updated'] as const,
  })
  const statusParam = pickString(sp.status)
  const status = statusParam === 'draft' || statusParam === 'published' ? statusParam : undefined

  const where = sql`org_id = ${orgId}
    ${params.q ? sql` and name ilike ${'%' + params.q + '%'}` : sql``}
    ${status ? sql` and status = ${status}` : sql``}`

  const [cards, counts] = await Promise.all([
    db.execute(sql`
      select id, name, description, viz_type, status, query, updated_at
        from insight_cards
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`
      select count(*) as total,
             count(*) filter (where status = 'draft') as drafts,
             count(*) filter (where status = 'published') as published
        from insight_cards where org_id = ${orgId}
    `) as any,
  ])
  const c = counts.rows[0]
  const total = Number(c.total)
  const filteredTotal =
    params.q || status
      ? Number(((await db.execute(sql`select count(*) as n from insight_cards where ${where}`)) as any).rows[0].n)
      : total

  const openCard = cardId && cardId !== 'new' && isUuid(cardId) ? await loadCard(cardId, orgId) : null

  const statusOptions = [
    { value: 'draft', label: tCommon('status.draft'), count: Number(c.drafts) },
    { value: 'published', label: t('status.published'), count: Number(c.published) },
  ]

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('title')}
            description={t('cards.description')}
            actions={canCreate ? <NewCardButton /> : undefined}
          />
          <InsightsTabs active="cards" />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('cards.searchPlaceholder')} />
            <FilterChips basePath="/insights" currentParams={sp} paramKey="status" label={tCommon('labels.status')} options={statusOptions} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title={t('cards.emptyTitle')}
          description={t('cards.emptyDescription')}
          action={canCreate ? <NewCardButton /> : undefined}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath="/insights" currentParams={sp} column="name" sort={params.sort} dir={params.dir}>
                  {tCommon('labels.name')}
                </SortTh>
                <TableHead>{t('cards.sourceColumn')}</TableHead>
                <TableHead>{t('cards.chartColumn')}</TableHead>
                <TableHead>{tCommon('labels.status')}</TableHead>
                <SortTh basePath="/insights" currentParams={sp} column="updated" sort={params.sort} dir={params.dir}>
                  {tCommon('labels.updated')}
                </SortTh>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cards.rows.map((row: any) => {
                const source = getSource(row.query?.source)
                const viz = VIZ_META.find((v) => v.value === row.viz_type)
                return (
                  <TableRow key={row.id}>
                    <TableCell className="font-semibold">
                      <Link href={`/insights?card=${row.id}`} className="text-teal-700 hover:underline dark:text-teal-300">
                        {row.name}
                      </Link>
                      {row.description ? (
                        <div className="text-xs font-normal text-slate-500 dark:text-slate-400">{row.description}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-slate-500 dark:text-slate-400">
                      {source ? t(`catalog.sources.${source.key}.label`) : '—'}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                        {viz ? <viz.Icon size={15} /> : null}
                        {viz ? t(viz.labelKey) : row.viz_type}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.status === 'published' ? 'success' : 'outline'}>
                        {row.status === 'published' ? t('status.published') : tCommon('status.draft')}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-slate-500 dark:text-slate-400">
                      {new Date(row.updated_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath="/insights" currentParams={sp} total={filteredTotal} page={params.page} perPage={params.perPage} />
          </div>
        </>
      )}
      {openCard ? (
        <CardStudio key={openCard.id} card={openCard} canCreate={canCreate} canPublish={canPublish} />
      ) : null}
    </ListPageLayout>
  )
}
