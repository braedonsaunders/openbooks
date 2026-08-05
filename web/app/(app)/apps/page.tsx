import Link from 'next/link'
import { ArrowUpRight, BookOpen, Boxes, Library } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '@/components/page-layout'
import { Pagination } from '@/components/pagination'
import { SearchInput } from '@/components/search-input'
import { can, requirePermission } from '@/lib/authz'
import { listApps } from '@/lib/apps/store'
import { parseListParams } from '@/lib/list-params'
import { NavIcon } from '@/components/sidebar-nav'

export const runtime = 'nodejs'

/** App launcher — searchable, paginated access to the org's installed Apps. */
export default async function AppsLauncherPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('apps.use')
  const t = await getTranslations('apps')
  const sp = await searchParams
  const params = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 12,
    allowedSorts: ['name'] as const,
  })
  const query = params.q?.toLocaleLowerCase()
  const allApps = await listApps(authz.user.orgId)
  const availableApps = allApps.filter((app) => app.status === 'installed' && app.activeVersionId)
  const installed = availableApps
    .filter((app) => !query || `${app.name} ${app.key} ${app.description ?? ''}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name))
  const total = installed.length
  const apps = installed.slice((params.page - 1) * params.perPage, params.page * params.perPage)
  const hasAnyInstalled = availableApps.length > 0
  const canManage = can(authz, 'apps.manage')

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('title')}
            description={t('description')}
            actions={
              <>
                <Button variant="outline" size="sm" asChild>
                  <Link href="/docs/apps">
                    <BookOpen size={15} /> {t('actions.documentation')}
                  </Link>
                </Button>
                {canManage ? (
                  <Button asChild>
                    <Link href="/apps/library">
                      <Library size={15} /> {t('actions.library')}
                    </Link>
                  </Button>
                ) : null}
              </>
            }
          />
          <SearchInput placeholder={t('searchPlaceholder')} />
        </>
      }
    >
      {apps.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {apps.map((app) => (
            <Link
              key={app.key}
              href={`/apps/${encodeURIComponent(app.key)}`}
              aria-label={t('actions.openAria', { name: app.name })}
            >
              <Card interactive className="h-full">
                <CardHeader className="flex-row items-start gap-3 p-4 pb-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">
                    <NavIcon iconKey={app.iconKey} size={20} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <CardTitle className="truncate text-base">{app.name}</CardTitle>
                    <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                      {t('version', { version: app.version ?? '—' })}
                    </p>
                  </div>
                </CardHeader>
                <CardContent className="flex h-[calc(100%-4rem)] flex-col px-4 pb-4">
                  <CardDescription className="line-clamp-2 min-h-10">
                    {app.description || t('noDescription')}
                  </CardDescription>
                  <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-teal-700 dark:text-teal-300">
                    {t('actions.open')} <ArrowUpRight size={14} aria-hidden />
                  </span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <div className="flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 px-6 py-10 text-center dark:border-slate-700">
          <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <Boxes size={21} aria-hidden />
          </span>
          <h2 className="font-medium text-slate-900 dark:text-slate-100">
            {hasAnyInstalled ? t('noResults.title') : t('empty.title')}
          </h2>
          <p className="mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
            {hasAnyInstalled ? t('noResults.description') : t('empty.description')}
          </p>
          {!hasAnyInstalled && canManage ? (
            <Button className="mt-4" size="sm" asChild>
              <Link href="/apps/library">
                <Library size={15} /> {t('empty.action')}
              </Link>
            </Button>
          ) : null}
        </div>
      )}
      <Pagination basePath="/apps" currentParams={sp} page={params.page} perPage={params.perPage} total={total} />
    </ListPageLayout>
  )
}
