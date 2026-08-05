import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, PageHeader } from '@openbooks/ui'
import { EntityListView } from '../../../../components/entity-list-view'
import { ListPageLayout } from '../../../../components/page-layout'
import { can, requirePermission } from '../../../../lib/authz'
import { featureEnabled, resolvedFeatureState } from '../../../../lib/features'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('banking')
  return { title: t('imports.title') }
}

export default async function BankingImports({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('banking.read')
  const t = await getTranslations('banking')
  const sp = await searchParams

  // Live bank-feed connections stay a read-only operational panel above the
  // standardized statement-history list. Connection management remains in setup.
  const features = await resolvedFeatureState(authz.user.orgId)
  const feedsEnabled = featureEnabled(features, 'bankFeeds')
  const feeds = feedsEnabled
    ? ((await db.execute(sql`
        select c.name, c.provider, c.status, c.last_sync_at, c.last_error, c.is_active,
               a.number as account_number, a.name as account_name
          from bank_feed_connections c
          join accounts a on a.id = c.account_id and a.org_id = c.org_id
         where c.org_id = ${authz.user.orgId} and c.provider in ('plaid','gocardless','truelayer')
         order by c.created_at desc
      `)) as unknown as { rows: any[] }).rows
    : []

  return (
    <ListPageLayout
      header={
        <PageHeader
          back={{ href: '/banking', label: t('home.title') }}
          title={t('imports.title')}
          description={t('imports.description')}
        />
      }
    >
      {feedsEnabled ? (
        <section className="mb-4 rounded-lg border border-slate-200 dark:border-slate-800">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-slate-800">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('bankFeeds.operational.title')}</h3>
            <Link href={'/admin/setup/bank-feeds' as any} className="text-sm text-teal-700 hover:underline dark:text-teal-300">
              {t('bankFeeds.operational.manage')}
            </Link>
          </div>
          {feeds.length === 0 ? (
            <p className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">{t('bankFeeds.operational.none')}</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {feeds.map((feed: any, index: number) => (
                <li key={index} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                  <span className="font-medium text-slate-900 dark:text-slate-100">{feed.name}</span>
                  <Badge variant="outline">{feed.provider}</Badge>
                  <span className="text-slate-500 dark:text-slate-400">
                    <span className="font-mono text-[13px] font-semibold">{feed.account_number}</span> {feed.account_name}
                  </span>
                  <Badge variant={feed.status === 'connected' ? 'default' : 'secondary'}>{feed.status}</Badge>
                  {!feed.is_active ? <span className="text-xs text-slate-400">(paused)</span> : null}
                  <span className="ml-auto text-slate-500 dark:text-slate-400">
                    {t('bankFeeds.operational.lastSync')}:{' '}
                    {feed.last_sync_at ? new Date(feed.last_sync_at).toLocaleDateString('en-CA') : t('bankFeeds.operational.never')}
                  </span>
                  {feed.last_error ? <span className="w-full text-xs text-red-600" title={feed.last_error}>⚠ {feed.last_error}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <EntityListView
        recordType="bank_statement"
        orgId={authz.user.orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
      />
    </ListPageLayout>
  )
}
