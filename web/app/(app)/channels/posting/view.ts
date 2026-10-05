import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { listChannels } from '@openbooks/engine/commerce'
import {
  getPostingPolicy,
  listPostingPolicies,
  type ChannelPostingPolicy,
} from '@openbooks/engine/commerce'
import { isoDateOf } from '@openbooks/engine/platform/civil-date'
import { page, pageHeader, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { channelTabs } from '../orders/view'
import type { ChannelTab } from '../ChannelWidgets'

/**
 * Channel Posting: how each channel turns storefront orders into accounting.
 * Everyday depth is the current effective policy per channel; the form writes
 * a new effective-dated row (posted history never reinterprets); the history
 * list shows what changes from which date.
 */
export interface ChannelPostingPolicyView extends ChannelPostingPolicy {
  guestCustomerName: string | null
}

export interface ChannelPostingData {
  title: string
  description: string
  tabs: ChannelTab[]
  canManage: boolean
  today: string
  channels: { id: string; name: string; kind: string; currency: string }[]
  policies: Record<string, ChannelPostingPolicyView | null>
  history: Record<string, ChannelPostingPolicyView[]>
  customers: { value: string; label: string }[]
}

async function policyView(orgId: string, policy: ChannelPostingPolicy): Promise<ChannelPostingPolicyView> {
  const guest = policy.guestCustomerPartyId
    ? (
        await db.execute<{ display_name: string }>(
          sql`select display_name from parties where org_id = ${orgId} and id = ${policy.guestCustomerPartyId}`,
        )
      ).rows[0]
    : null
  return { ...policy, guestCustomerName: guest?.display_name ?? null }
}

export async function loadChannelPosting(): Promise<ChannelPostingData> {
  const authz = await requirePermission('channels.read')
  await requireFeatureEnabled(authz.user.orgId, 'salesChannels')
  const t = await getTranslations('channels')
  const orgId = authz.user.orgId
  const today = isoDateOf(new Date())

  const [channels, customers, exceptionCount] = await Promise.all([
    listChannels(orgId),
    db.execute<{ value: string; label: string }>(sql`
      select p.id as value, p.display_name as label from parties p
        join customer_roles c on c.party_id = p.id and c.org_id = p.org_id and c.is_active
       where p.org_id = ${orgId} and p.is_active order by p.display_name`),
    db.execute<{ count: string }>(
      sql`select count(*)::text as count from channel_orders where org_id = ${orgId} and posting_status = 'exception'`,
    ),
  ])

  const policies: Record<string, ChannelPostingPolicyView | null> = {}
  const history: Record<string, ChannelPostingPolicyView[]> = {}
  for (const channel of channels) {
    const [current, rows] = await Promise.all([
      getPostingPolicy(orgId, channel.id, today).catch(() => null),
      listPostingPolicies(orgId, channel.id),
    ])
    policies[channel.id] = current ? await policyView(orgId, current) : null
    history[channel.id] = []
    for (const row of rows) history[channel.id]!.push(await policyView(orgId, row))
  }

  return {
    title: t('postingTitle'),
    description: t('postingDescription'),
    tabs: channelTabs(t, 'posting', Number(exceptionCount.rows[0]?.count ?? '0')),
    canManage: can(authz, 'channels.manage'),
    today,
    channels: channels.map((channel) => ({ id: channel.id, name: channel.name, kind: channel.kind, currency: channel.currency })),
    policies,
    history,
    customers: customers.rows,
  }
}

export function channelPostingSpec(data: ChannelPostingData): PageSpec {
  return page({
    route: '/channels/posting',
    layout: 'list',
    header: [
      pageHeader({
        title: data.title,
        description: data.description,
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      widgetBlock('channel-posting-form', {
        canManage: data.canManage,
        today: data.today,
        channels: data.channels,
        policies: data.policies,
        history: data.history,
        customers: data.customers,
      }),
    ],
  })
}
