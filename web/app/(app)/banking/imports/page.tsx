import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { EntityListView } from '../../../../components/entity-list-view'
import { ListPageLayout } from '../../../../components/page-layout'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { can, requirePermission } from '../../../../lib/authz'
import { featureEnabled, resolvedFeatureState } from '../../../../lib/features'
import { BankFeedPanel, mapBankFeedRows } from './sections'
import { bankingImportsSpec, loadBankingImports } from './view'

export const dynamic = 'force-dynamic'

interface FeedRow extends Record<string, unknown> {
  name: string
  provider: string
  status: string
  last_sync_at: string | null
  last_attempt_at: string | null
  last_error: string | null
  is_active: boolean
  account_number: string | null
  account_name: string
}

export async function generateMetadata() {
  const t = await getTranslations('banking')
  return { title: t('imports.title') }
}

export default async function BankingImports({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadBankingImports(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={bankingImportsSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const authz = await requirePermission('banking.read')
  const t = await getTranslations('banking')
  const sp = await searchParams

  // Live bank-feed connections stay a read-only operational panel above the
  // standardized statement-history list. Connection management remains in setup.
  const features = await resolvedFeatureState(authz.user.orgId)
  const feedsEnabled = featureEnabled(features, 'bankFeeds')
  const feeds = feedsEnabled
    ? ((await db.execute<FeedRow>(sql`
        select c.name, c.provider, c.status, c.last_sync_at, c.last_attempt_at, c.last_error, c.is_active,
               a.number as account_number, a.name as account_name
          from bank_feed_connections c
          join accounts a on a.id = c.account_id and a.org_id = c.org_id
         where c.org_id = ${authz.user.orgId} and c.provider in ('plaid','gocardless','truelayer')
         order by c.created_at desc
      `))).rows
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
        <BankFeedPanel
          title={t('bankFeeds.operational.title')}
          manageLabel={t('bankFeeds.operational.manage')}
          emptyMessage={t('bankFeeds.operational.none')}
          lastSyncLabel={t('bankFeeds.operational.lastSync')}
          lastAttemptLabel={t('bankFeeds.operational.lastAttempt')}
          neverLabel={t('bankFeeds.operational.never')}
          feeds={mapBankFeedRows(feeds)}
        />
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
