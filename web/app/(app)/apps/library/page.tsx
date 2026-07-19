import Link from 'next/link'
import { BookOpen, Library } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '@/components/page-layout'
import { Pagination } from '@/components/pagination'
import { SearchInput } from '@/components/search-input'
import { requirePermission } from '@/lib/authz'
import { listApps, listListings } from '@/lib/apps/store'
import { parseListParams } from '@/lib/list-params'
import { InstallListingButton } from './InstallListingButton'

export const runtime = 'nodejs'

export default async function AppLibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
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
              <Card key={listing.id} className="flex h-full flex-col">
                <CardHeader className="p-4 pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
                      <Library size={20} aria-hidden />
                    </span>
                    <Badge variant="secondary">{t('version', { version: listing.version })}</Badge>
                  </div>
                  <CardTitle className="mt-2 text-base">{listing.name}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col px-4 pb-4">
                  <CardDescription className="line-clamp-3 min-h-[3.75rem]">
                    {listing.description || t('noDescription')}
                  </CardDescription>
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <code className="truncate text-xs text-slate-400 dark:text-slate-500">{listing.key}</code>
                    <InstallListingButton
                      listingId={listing.id}
                      name={listing.name}
                      installed={Boolean(installed)}
                      current={current}
                    />
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      ) : (
        <div className="flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 px-6 py-10 text-center dark:border-slate-700">
          <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <Library size={21} aria-hidden />
          </span>
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
