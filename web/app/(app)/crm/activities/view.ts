import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { crmSharedScope, crmOpportunityScope } from '../../../../lib/crm-scope'
import { can, requirePermission } from '../../../../lib/authz'
import { isUuid, pickString } from '../../../../lib/list-params'
import { loadActivity } from '../../../../lib/crm'
import type { ActivityDrawer } from '../ActivityDrawer'

/**
 * The activity list, split into a loader and a spec.
 *
 * Almost all of the page is the universal entity list; what is page-specific
 * is the header button and the drawer SLOT, which the native page fills with
 * the activity flyout (or nothing). The spec names widgets and the slot
 * resolves them, the same indirection the empty state uses for its action.
 *
 * Two things the native page settles, kept as-is:
 *
 * 1. There is no `?activity=new` redirect. A non-uuid `activity` param fails
 *    `isUuid` and renders no drawer; drafts are created by the header
 *    button's POST. So the drawer slot holds at most one widget.
 * 2. The native drawer carries no `key`, so neither does the spec's.
 *    Switching activities reuses the mounted flyout in both renders.
 */

type ActivityDrawerProps = Parameters<typeof ActivityDrawer>[0]

export interface ActivitiesData {
  title: string
  description: string
  newLabel: string
  createFailed: string
  canManage: boolean
  currentParams: Record<string, string | string[] | undefined>
  drawer: ActivityDrawerProps | null
}

export async function loadActivities(
  sp: Record<string, string | string[] | undefined>,
): Promise<ActivitiesData> {
  const authz = await requirePermission('crm.activities.read')
  const manage = can(authz, 'crm.activities.manage')
  const t = await getTranslations('crm')
  const openId = pickString(sp.activity)

  let drawer: ActivityDrawerProps | null = null
  if (openId && isUuid(openId)) {
    const [open, owners, accounts, opportunities] = await Promise.all([
      loadActivity(openId, authz.user.orgId, authz.allowedSubsidiaryIds),
      (db.execute(sql`select id,name from users where org_id=${authz.user.orgId} and is_active order by name`)),
      (db.execute(sql`select p.id,p.display_name name from crm_account_profiles cp join parties p on p.id=cp.party_id and p.org_id=cp.org_id where cp.org_id=${authz.user.orgId} and cp.is_active${crmSharedScope(sql`p.subsidiary_id`,authz.allowedSubsidiaryIds)} order by p.display_name limit 2000`)),
      (db.execute(sql`select o.id,o.opportunity_number,o.title from crm_opportunities o where o.org_id=${authz.user.orgId} and o.is_active${crmOpportunityScope(authz.allowedSubsidiaryIds)} order by o.created_at desc limit 2000`)),
    ])
    if (open) {
      const requestedReturn = pickString(sp.drawerReturn)
      const closeHref = requestedReturn?.startsWith('/crm/activities') ? requestedReturn : '/crm/activities'
      drawer = {
        data: open as unknown as ActivityDrawerProps['data'],
        owners: owners.rows as unknown as ActivityDrawerProps['owners'],
        accounts: accounts.rows as unknown as ActivityDrawerProps['accounts'],
        opportunities: opportunities.rows as unknown as ActivityDrawerProps['opportunities'],
        closeHref,
        canManage: manage,
      }
    }
  }

  return {
    title: t('activities.title'),
    description: t('activities.description'),
    newLabel: t('activities.new'),
    createFailed: t('feedback.createFailed'),
    canManage: manage,
    currentParams: sp,
    drawer,
  }
}

const f = ref<ActivitiesData>()

export function activitiesSpec(data: ActivitiesData): PageSpec {
  // The native header action and the list empty action are the same
  // CrmNewButton element; the labels ride along as loader-resolved strings.
  const newActivity = {
    widget: 'crm-new-button',
    props: {
      apiPath: '/api/crm/activities/draft',
      basePath: '/crm/activities',
      param: 'activity',
      label: data.newLabel,
      failed: data.createFailed,
    },
  }
  return page({
    route: '/crm/activities',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget(newActivity.widget, newActivity.props, f('canManage'))],
      }),
    ],
    body: [
      widgetBlock('entity-list-view', {
        recordType: 'activity',
        sp: data.currentParams,
        emptyAction: data.canManage ? newActivity : null,
        drawer: data.drawer
          ? [{ widget: 'activity-drawer', props: { drawer: data.drawer } }]
          : [],
      }),
    ],
  })
}
