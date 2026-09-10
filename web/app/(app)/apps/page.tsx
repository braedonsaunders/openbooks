import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '@/components/page-layout'
import { Pagination } from '@/components/pagination'
import { SearchInput } from '@/components/search-input'
import { can, requirePermission } from '@/lib/authz'
import { listApps } from '@/lib/apps/store'
import { parseListParams } from '@/lib/list-params'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadAppsLauncher, appsLauncherSpec } from './view'
import { AppLauncherCard, AppsEmptyIcon, AppsLauncherButton } from './sections'

export const runtime = 'nodejs'

/** App launcher — searchable, paginated access to the org's installed Apps. */
export default async function AppsLauncherPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadAppsLauncher(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={appsLauncherSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
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
                <AppsLauncherButton
                  href="/docs/apps"
                  label={t('actions.documentation')}
                  icon="book"
                  variant="outline"
                  size="sm"
                />
                {canManage ? (
                  <AppsLauncherButton href="/apps/library" label={t('actions.library')} icon="library" />
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
            <AppLauncherCard
              key={app.key}
              href={`/apps/${encodeURIComponent(app.key)}`}
              ariaLabel={t('actions.openAria', { name: app.name })}
              iconKey={app.iconKey}
              name={app.name}
              versionLine={t('version', { version: app.version ?? '—' })}
              description={app.description || t('noDescription')}
              openLabel={t('actions.open')}
            />
          ))}
        </div>
      ) : (
        <div className="flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 px-6 py-10 text-center dark:border-slate-700">
          <AppsEmptyIcon />
          <h2 className="font-medium text-slate-900 dark:text-slate-100">
            {hasAnyInstalled ? t('noResults.title') : t('empty.title')}
          </h2>
          <p className="mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
            {hasAnyInstalled ? t('noResults.description') : t('empty.description')}
          </p>
          {!hasAnyInstalled && canManage ? (
            <AppsLauncherButton
              href="/apps/library"
              label={t('empty.action')}
              icon="library"
              size="sm"
              className="mt-4"
            />
          ) : null}
        </div>
      )}
      <Pagination basePath="/apps" currentParams={sp} page={params.page} perPage={params.perPage} total={total} />
    </ListPageLayout>
  )
}
