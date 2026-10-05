import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { page, pageHeader, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { pickString } from '../../../../lib/list-params'
import { FANOUT_EVENT_TYPES } from '@openbooks/engine/webhooks'
import type { EndpointDelivery, WebhookEndpointDrawerProps } from './EndpointDrawer'

/**
 * Settings → Developers → Webhooks: subscriber endpoints for signed domain
 * events. The list is the universal entity list; the drawer slot holds the
 * endpoint flyout (settings, deliveries, security). Creation posts once
 * from the drawer and shows the signing secret once — the loader never
 * sees plaintext.
 */

export type WebhooksData = {
  title: string
  description: string
  canManage: boolean
  currentParams: Record<string, string | string[] | undefined>
  emptyTitle: string
  emptyDescription: string
  showNew: boolean
  drawer: {
    endpoint: WebhookEndpointDrawerProps['endpoint']
    closeHref: string
    canManage: boolean
    eventTypes: string[]
  } | null
}

async function loadEndpoint(orgId: string, id: string) {
  const rows = (await db.execute(sql`
    select e.id, e.key, e.url, e.description, e.events, e.status,
           e.consecutive_failures as "consecutiveFailures",
           e.auto_disable_after as "autoDisableAfter",
           e.disabled_at as "disabledAt", e.disabled_reason as "disabledReason",
           e.secret_rotated_at as "secretRotatedAt",
           e.last_delivery_at as "lastDeliveryAt",
           e.last_delivery_status as "lastDeliveryStatus",
           e.last_error as "lastError",
           (select count(*)::int from webhook_deliveries d where d.org_id = e.org_id and d.endpoint_id = e.id) as "deliveryCount",
           (select count(*)::int from webhook_deliveries d where d.org_id = e.org_id and d.endpoint_id = e.id and d.status = 'pending') as "pendingCount",
           (select count(*)::int from webhook_deliveries d where d.org_id = e.org_id and d.endpoint_id = e.id and d.status in ('failed', 'dead')) as "failedCount"
      from webhook_endpoints e
     where e.org_id = ${orgId} and e.id = ${id}::uuid limit 1
  `)).rows as WebhookEndpointDrawerProps['endpoint'][]
  return rows[0] ?? null
}

async function loadDeliveries(orgId: string, endpointId: string) {
  const rows = (await db.execute(sql`
    select d.id, d.status, d.attempt_count as "attemptCount",
           d.next_attempt_at as "nextAttemptAt", d.last_attempt_at as "lastAttemptAt",
           d.last_response_code as "lastResponseCode",
           d.last_response_excerpt as "lastResponseExcerpt",
           d.last_latency_ms as "lastLatencyMs", d.last_error as "lastError",
           d.delivered_at as "deliveredAt", d.created_at as "createdAt",
           e.event_type as "eventType", e.occurred_at as "occurredAt", e.payload as "payload"
      from webhook_deliveries d join webhook_events e on e.id = d.event_id and e.org_id = d.org_id
     where d.org_id = ${orgId} and d.endpoint_id = ${endpointId}::uuid
     order by d.created_at desc limit 50
  `)).rows as EndpointDelivery[]
  return rows
}

export async function loadWebhooks(
  sp: Record<string, string | string[] | undefined>,
): Promise<WebhooksData> {
  const t = await getTranslations('admin')
  const authz = await requirePermission('webhooks.read')
  await requireFeatureEnabled(authz.user.orgId, 'outboundWebhooks')
  const canManage = can(authz, 'webhooks.manage')
  const endpointParam = pickString(sp.endpoint)
  const creating = endpointParam === 'new'
  const endpoint = endpointParam && !creating ? await loadEndpoint(authz.user.orgId, endpointParam) : null
  return {
    title: t('webhooks.list.title'),
    description: t('webhooks.list.description'),
    canManage,
    currentParams: sp,
    emptyTitle: t('webhooks.list.emptyTitle'),
    emptyDescription: t('webhooks.list.emptyDescription'),
    showNew: creating && canManage,
    drawer: endpointParam && (!creating || canManage)
      ? {
          endpoint: creating
            ? null
            : endpoint
              ? { ...endpoint, deliveries: await loadDeliveries(authz.user.orgId, endpoint.id as string) }
              : null,
          closeHref: '/admin/webhooks',
          canManage,
          eventTypes: [...FANOUT_EVENT_TYPES],
        }
      : null,
  }
}

export function webhooksSpec(data: WebhooksData): PageSpec {
  const newEndpoint = { widget: 'new-webhook-endpoint', props: {} }
  return page({
    route: '/admin/webhooks',
    layout: 'list',
    header: [
      pageHeader({
        title: data.title,
        description: data.description,
        actions: data.canManage ? [widget(newEndpoint.widget, newEndpoint.props)] : [],
      }),
    ],
    body: [
      widgetBlock('entity-list-view', {
        recordType: 'webhook_endpoint',
        sp: data.currentParams,
        emptyAction: data.canManage ? newEndpoint : null,
        emptyTitle: data.emptyTitle,
        emptyDescription: data.emptyDescription,
        drawer: [
          data.showNew
            ? {
                widget: 'webhook-endpoint-drawer',
                props: {
                  drawer: { endpoint: null, closeHref: '/admin/webhooks', canManage: data.canManage, eventTypes: [...FANOUT_EVENT_TYPES] },
                },
              }
            : null,
          data.drawer ? { widget: 'webhook-endpoint-drawer', props: { drawer: data.drawer } } : null,
        ].filter(Boolean),
      }),
    ],
  })
}
