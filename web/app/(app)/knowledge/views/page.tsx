import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { Pagination } from '../../../../components/pagination'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { dateTime } from '../../../../lib/format'
import { requirePermission } from '../../../../lib/authz'
import { loadViews } from '../../../../lib/views'
import { NewViewButton } from './NewViewButton'
import { ViewStudio } from './ViewStudio'

export const dynamic = 'force-dynamic'

const PER_PAGE = 25

const SCOPE_VARIANT: Record<string, 'secondary' | 'outline'> = {
  shared: 'secondary',
  private: 'outline',
}

export default async function ViewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations('knowledge.views')
  const tReports = await getTranslations('reports')
  const tNav = await getTranslations('nav')
  const tc = await getTranslations('common')
  const authz = await requirePermission('reports.read')
  const canCreate = authz.permissions.has('reports.create') || authz.permissions.has('*')
  const sp = await searchParams
  const params = parseListParams(sp, { sort: 'updated', dir: 'desc', perPage: PER_PAGE, allowedSorts: ['updated', 'name'] as const })
  const scopeFilter = pickString(sp.scope) ?? 'all'

  const all = await loadViews(authz.user.orgId, authz.user.id, authz.permissions)
  const q = params.q?.toLowerCase()
  const filtered = all.filter((s) => {
    if (scopeFilter !== 'all' && s.scope !== scopeFilter) return false
    if (q && !s.name.toLowerCase().includes(q) && !s.description?.toLowerCase().includes(q)) return false
    return true
  })
  const sorted = [...filtered].sort((a, b) => {
    if (params.sort === 'name') return params.dir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)
    return params.dir === 'asc'
      ? new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
      : new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  })
  const total = sorted.length
  const rows = sorted.slice((params.page - 1) * PER_PAGE, params.page * PER_PAGE)

  const openId = pickString(sp.view)
  const openView = openId ? all.find((s) => s.id === openId) ?? null : null

  const currentParams = Object.fromEntries(Object.entries(sp).filter(([, v]) => v !== undefined)) as Record<string, string>

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('list.title')}
            description={t('list.description')}
            back={{ href: '/dashboard', label: tNav('modules.dashboard') }}
            actions={canCreate ? <NewViewButton /> : null}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('list.searchPlaceholder')} />
            <FilterChips
              basePath="/knowledge/views"
              currentParams={currentParams}
              paramKey="scope"
              label={t('list.scopeLabel')}
              allLabel={t('list.scopeAll')}
              options={[
                { value: 'shared', label: t('list.scopeShared') },
                { value: 'private', label: t('list.scopePrivate') },
              ]}
            />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState title={t('list.emptyTitle')} description={t('list.emptyDescription')} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('list.columns.name')}</TableHead>
                <TableHead>{t('list.columns.source')}</TableHead>
                <TableHead>{t('list.columns.scope')}</TableHead>
                <TableHead>{t('list.columns.updated')}</TableHead>
                <TableHead className="w-24">{tc('labels.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    {/* Name RUNS the view (NetSuite behaviour); editing is the
                        explicit action on the right. */}
                    <Link href={`/knowledge/views/${s.id}`} className="font-medium text-teal-700 hover:underline dark:text-teal-300">
                      {s.name}
                    </Link>
                    {s.description ? (
                      <div className="text-xs text-slate-500 dark:text-slate-400">{s.description}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-slate-600 dark:text-slate-300">
                    {tReports.has(`catalog.entities.${s.query.entity}.label`)
                      ? tReports(`catalog.entities.${s.query.entity}.label`)
                      : s.query.entity}
                  </TableCell>
                  <TableCell>
                    <Badge variant={SCOPE_VARIANT[s.scope] ?? 'outline'}>
                      {t(`list.scope.${s.scope}` as never)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{dateTime(s.updated_at)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3 text-sm">
                      <Link href={`/knowledge/views/${s.id}`} className="text-teal-700 hover:underline dark:text-teal-300">
                        {t('list.runAction')}
                      </Link>
                      {authz.permissions.has('*') || s.owner_id === authz.user.id ? (
                        <Link href={`/knowledge/views?view=${s.id}`} className="text-slate-500 hover:text-slate-900 hover:underline dark:text-slate-400 dark:hover:text-slate-100">
                          {t('list.editAction')}
                        </Link>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pagination basePath="/knowledge/views" currentParams={currentParams} page={params.page} perPage={PER_PAGE} total={total} />

      {openView ? <ViewStudio view={openView} canCreate={canCreate} canAdmin={authz.permissions.has('*') || openView.owner_id === authz.user.id} /> : null}
    </ListPageLayout>
  )
}
