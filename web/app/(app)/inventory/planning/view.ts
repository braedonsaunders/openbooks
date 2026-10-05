import 'server-only'

import { getLocale, getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { isUuid } from '@openbooks/engine/platform/identifiers'
import { db } from '@openbooks/engine/platform/database'
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { pickString } from '../../../../lib/list-params'
import { subsidiaryVisibleFilter } from '../../../../lib/subsidiaries'
import { partyOptions } from '../../../../lib/documents'

/**
 * Inventory planning, split into a loader and a spec.
 *
 * The everyday question — "what do I need to buy or move this week?" — is
 * the universal EntityListView over the demand_suggestion source, so search,
 * status filters, saved views and sorting arrive with the shared machinery.
 * The header's remedies (run the plan, confirm everything suggested, turn
 * confirmed purchases into grouped purchase orders) and the suggestion
 * drawer (chart, explanation, confirm / dismiss / convert, advanced
 * overrides) are client widgets over the planning API: the spec carries
 * only picker lists and ids, never an org id or a capability.
 */

export interface PlanningData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  subsidiaryId: string
  subsidiaries: { id: string; name: string }[]
  vendors: { id: string; name: string }[]
  locations: { id: string; code: string }[]
  suggestionId: string | null
  closeHref: string
  locale: string
  emptyTitle: string
  emptyDescription: string
}

export async function loadPlanning(
  sp: Record<string, string | string[] | undefined>,
): Promise<PlanningData> {
  const t = await getTranslations('planning')
  const authz = await requirePermission('inventory.plan')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'demandPlanning')

  const subsidiaries = (await db.execute<{ id: string; name: string }>(sql`
    select s.id, s.name from subsidiaries s
     where s.org_id = ${orgId} and s.is_active and not s.is_elimination
       ${subsidiaryVisibleFilter(sql`s.id`, authz.allowedSubsidiaryIds)}
     order by s.name`)).rows
  const requested = pickString(sp.subsidiaryId)
  const subsidiaryId = subsidiaries.some((entry) => entry.id === requested)
    ? requested!
    : (subsidiaries[0]?.id ?? '')
  const suggestionParam = pickString(sp.suggestion)
  const suggestionId = suggestionParam && isUuid(suggestionParam) ? suggestionParam : null
  const [vendors, locations] = await Promise.all([
    partyOptions('vendor', orgId, authz.allowedSubsidiaryIds).then((options) =>
      options.map((option) => ({ id: option.id, name: option.label ?? option.id })),
    ),
    db.execute<{ id: string; code: string }>(sql`
      select id, code from stock_locations where org_id = ${orgId} and is_active order by code`),
  ])
  const closeParams = new URLSearchParams()
  if (subsidiaryId) closeParams.set('subsidiaryId', subsidiaryId)
  const closeQuery = closeParams.toString()
  return {
    title: t('title'),
    description: t('description'),
    currentParams: sp,
    subsidiaryId,
    subsidiaries,
    vendors,
    locations: locations.rows,
    suggestionId,
    closeHref: closeQuery ? `/inventory/planning?${closeQuery}` : '/inventory/planning',
    locale: await getLocale(),
    emptyTitle: t('list.emptyTitle'),
    emptyDescription: t('list.emptyDescription'),
  }
}

const f = ref<PlanningData>()

export function planningSpec(data: PlanningData): PageSpec {
  return page({
    route: '/inventory/planning',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex items-center gap-3',
        actions: [
          widget('demand-plan-actions', {
            subsidiaryId: data.subsidiaryId,
            subsidiaries: data.subsidiaries,
          }),
        ],
      }),
    ],
    body: [
      widgetBlock('entity-list-view', {
        recordType: 'demand_suggestion',
        sp: data.currentParams,
        emptyTitle: data.emptyTitle,
        emptyDescription: data.emptyDescription,
        drawer: data.suggestionId
          ? {
              widget: 'demand-suggestion-drawer',
              props: {
                suggestionId: data.suggestionId,
                closeHref: data.closeHref,
                vendors: data.vendors,
                locations: data.locations,
                locale: data.locale,
              },
            }
          : null,
      }),
    ],
  })
}
