import Link from 'next/link'
import { BookOpen } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { Button, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '@/components/page-layout'
import { Pagination } from '@/components/pagination'
import { SearchInput } from '@/components/search-input'
import { requirePermission } from '@/lib/authz'
import { listApps, listListings } from '@/lib/apps/store'
import { parseListParams } from '@/lib/list-params'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadAppsLibrary, appsLibrarySpec } from './view'
import { ListingCard, LibraryEmptyIcon } from './sections'

export const runtime = 'nodejs'

export default async function AppLibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadAppsLibrary(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={appsLibrarySpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const authz = await requirePermission('apps.manage')
  const t = await getTranslations('apps')
  const sp = await searchParams
  const params = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 12,
    allowedSorts: ['name'] as const,
  })
  const [{ listings, total }, installedApps] = await Promise.all([
    listListings({
      query: params.q,
      page: params.page,
      perPage: params.perPage,
    }),
    listApps(authz.user.orgId),
  ])
  const installedByKey = new Map(installedApps.map((app) => [app.key, app]))

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            back={{ href: '/apps', label: t('title') }}
            title={t('library.title')}
            description={t('library.description')}
            actions={
              <Button variant="outline" size="sm" asChild>
                <Link href="/docs/apps">
                  <BookOpen size={15} /> {t('actions.documentation')}
                </Link>
              </Button>
            }
          />
          <SearchInput placeholder={t('library.searchPlaceholder')} />
        </>
      }
    >
      {listings.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {listings.map((listing) => {
            const installed = installedByKey.get(listing.key)
            const current = installed?.version === listing.version
            return (
              <ListingCard
                key={listing.id}
                listingId={listing.id}
                listingKey={listing.key}
                name={listing.name}
                versionLine={t('version', { version: listing.version })}
                description={listing.description || t('noDescription')}
                installed={Boolean(installed)}
                current={current}
              />
            )
          })}
        </div>
      ) : (
        <div className="flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 px-6 py-10 text-center dark:border-slate-700">
          <LibraryEmptyIcon />
          <h2 className="font-medium text-slate-900 dark:text-slate-100">
            {params.q ? t('library.noResults.title') : t('library.empty.title')}
          </h2>
          <p className="mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
            {params.q ? t('library.noResults.description') : t('library.empty.description')}
          </p>
        </div>
      )}
      <Pagination
        basePath="/apps/library"
        currentParams={sp}
        page={params.page}
        perPage={params.perPage}
        total={total}
      />
    </ListPageLayout>
  )
}
