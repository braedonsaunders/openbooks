import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  page,
  pageHeader,
  ref,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { featureEnabled, resolvedFeatureState } from '../../../../lib/features'
import { mapBankFeedRows } from './sections'

/**
 * Statement import history, split into a loader and a spec.
 *
 * A conditional live-feed panel above the universal statement-history list.
 * The bank_statement list itself arrives through the shared `entity-list-view`
 * widget — the slot re-derives orgId/userId/permissions from the session, so
 * the spec carries only the record type and the current params, never an org
 * id. The imports page passes no drawer and no emptyAction, and the spec
 * preserves that: the slot renders nothing in either position.
 *
 * The feeds panel cannot be a table or a repeat: its rows are conditional
 * pairs (an error line vs nothing; a paused marker vs nothing; a last-attempt
 * date vs nothing), so it is one `bank-feed-panel` widget backed by the
 * shared BankFeedPanel component in ./sections — exactly like the
 * account-stats widget on the sibling account page.
 */

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

export interface BankingImportsData {
  title: string
  description: string
  homeTitle: string
  currentParams: Record<string, string | string[] | undefined>
  feedsEnabled: boolean
  panelTitle: string
  manageLabel: string
  panelEmpty: string
  lastSyncLabel: string
  lastAttemptLabel: string
  neverLabel: string
  feeds: ReturnType<typeof mapBankFeedRows>
}

export async function loadBankingImports(
  sp: Record<string, string | string[] | undefined>,
): Promise<BankingImportsData> {
  const authz = await requirePermission('banking.read')
  const t = await getTranslations('banking')

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

  const neverLabel = t('bankFeeds.operational.never')
  return {
    title: t('imports.title'),
    description: t('imports.description'),
    homeTitle: t('home.title'),
    currentParams: sp,
    feedsEnabled,
    panelTitle: t('bankFeeds.operational.title'),
    manageLabel: t('bankFeeds.operational.manage'),
    panelEmpty: t('bankFeeds.operational.none'),
    lastSyncLabel: t('bankFeeds.operational.lastSync'),
    lastAttemptLabel: t('bankFeeds.operational.lastAttempt'),
    neverLabel,
    feeds: mapBankFeedRows(feeds),
  }
}

const f = ref<BankingImportsData>()

export function bankingImportsSpec(data: BankingImportsData): PageSpec {
  return page({
    route: '/banking/imports',
    layout: 'list',
    header: [
      pageHeader({
        back: { href: '/banking', label: f('homeTitle') },
        title: f('title'),
        description: f('description'),
      }),
    ],
    body: [
      {
        ...widgetBlock('bank-feed-panel', {
          title: data.panelTitle,
          manageLabel: data.manageLabel,
          emptyMessage: data.panelEmpty,
          neverLabel: data.neverLabel,
          lastSyncLabel: data.lastSyncLabel,
          lastAttemptLabel: data.lastAttemptLabel,
          feeds: data.feeds,
        }),
        when: f('feedsEnabled'),
      },
      widgetBlock('entity-list-view', {
        recordType: 'bank_statement',
        sp: data.currentParams,
      }),
    ],
  })
}
