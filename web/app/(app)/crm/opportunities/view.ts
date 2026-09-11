import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { crmSharedScope } from '../../../../lib/crm-scope'
import { can, requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid, pickString } from '../../../../lib/list-params'
import { loadOpportunity } from '../../../../lib/crm'
import type { OpportunityDrawer } from '../OpportunityDrawer'

/**
 * The opportunity list, split into a loader and a spec.
 *
 * Almost all of the page is the universal entity list; what is page-specific
 * is the header button and the drawer SLOT, which the native page fills with
 * the opportunity flyout (or nothing). The spec names widgets and the slot
 * resolves them, the same indirection the empty state uses for its action.
 *
 * Two things the native page settles, kept as-is:
 *
 * 1. There is no `?opportunity=new` redirect. A non-uuid `opportunity` param
 *    fails `isUuid` and renders no drawer; drafts are created by the header
 *    button's POST. So the drawer slot holds at most one widget.
 * 2. The native drawer carries no `key`, so neither does the spec's. Switching
 *    opportunities reuses the mounted flyout in both renders.
 */

type OpportunityDrawerProps = Parameters<typeof OpportunityDrawer>[0]
type ElementOf<T> = NonNullable<T> extends readonly (infer Item)[] ? Item : never

export interface OpportunitiesData {
  title: string
  description: string
  newLabel: string
  createFailed: string
  canManage: boolean
  currentParams: Record<string, string | string[] | undefined>
  drawer: OpportunityDrawerProps | null
}

export async function loadOpportunities(
  sp: Record<string, string | string[] | undefined>,
): Promise<OpportunitiesData> {
  const authz = await requirePermission('crm.opportunities.read')
  const manage = can(authz, 'crm.opportunities.manage')
  const t = await getTranslations('crm')
  const openId = pickString(sp.opportunity)

  let drawer: OpportunityDrawerProps | null = null
  if (openId && isUuid(openId)) {
    const [multiCurrency, inventoryEnabled, equipmentEnabled] = await Promise.all([
      isFeatureEnabled(authz.user.orgId, 'multiCurrency'),
      isFeatureEnabled(authz.user.orgId, 'inventory'),
      isFeatureEnabled(authz.user.orgId, 'equipment'),
    ])
    const [open, statuses, owners, accounts, contacts, teams, sources, items, currencies] = await Promise.all([
      loadOpportunity(openId, authz.user.orgId, authz.allowedSubsidiaryIds),
      (db.execute(sql`select * from crm_opportunity_statuses where org_id=${authz.user.orgId} and is_active order by sequence`)),
      (db.execute(sql`select id,name from users where org_id=${authz.user.orgId} and is_active order by name`)),
      (db.execute(sql`select p.id,p.display_name name from crm_account_profiles cp join parties p on p.id=cp.party_id and p.org_id=cp.org_id where cp.org_id=${authz.user.orgId} and cp.is_active${crmSharedScope(sql`p.subsidiary_id`,authz.allowedSubsidiaryIds)} order by p.display_name limit 2000`)),
      (db.execute(sql`select c.id,c.party_id,c.name from contacts c left join parties p on p.id=c.party_id and p.org_id=c.org_id where c.org_id=${authz.user.orgId} and c.is_active${crmSharedScope(sql`p.subsidiary_id`,authz.allowedSubsidiaryIds)} order by c.name limit 4000`)),
      (db.execute(sql`select id,name from crm_sales_teams where org_id=${authz.user.orgId} and is_active order by name`)),
      (db.execute(sql`select id,name from crm_lead_sources where org_id=${authz.user.orgId} and is_active order by name`)),
      (db.execute(sql`
        select id, concat_ws(' · ', code, name) name from items
         where org_id = ${authz.user.orgId} and is_active
           and (
             ${inventoryEnabled ? sql`true` : sql`kind not in ('inventory', 'assembly', 'kit')`}
             ${equipmentEnabled ? sql`` : sql`and kind <> 'equipment_charge'`}
             or id in (
               select item_id from crm_opportunity_lines
                where org_id = ${authz.user.orgId} and opportunity_id = ${openId} and item_id is not null
             )
           )
         order by name limit 2000`)),
      multiCurrency
        ? db.execute<ElementOf<OpportunityDrawerProps['currencies']>>(sql`select code,name from currencies order by code`)
        : Promise.resolve({ rows: [] }),
    ])
    const requestedReturn = pickString(sp.drawerReturn)
    const closeHref = requestedReturn?.startsWith('/crm/opportunities')
      ? requestedReturn
      : '/crm/opportunities'
    if (open) {
      drawer = {
        data: open as unknown as OpportunityDrawerProps['data'],
        statuses: statuses.rows as unknown as OpportunityDrawerProps['statuses'],
        owners: owners.rows as unknown as OpportunityDrawerProps['owners'],
        accounts: accounts.rows as unknown as OpportunityDrawerProps['accounts'],
        contacts: contacts.rows as unknown as OpportunityDrawerProps['contacts'],
        teams: teams.rows as unknown as OpportunityDrawerProps['teams'],
        sources: sources.rows as unknown as OpportunityDrawerProps['sources'],
        items: items.rows as unknown as OpportunityDrawerProps['items'],
        currencies: currencies.rows as unknown as OpportunityDrawerProps['currencies'],
        closeHref,
        canManage: manage,
        multiCurrency,
      }
    }
  }

  return {
    title: t('opportunities.title'),
    description: t('opportunities.description'),
    newLabel: t('opportunities.new'),
    createFailed: t('feedback.createFailed'),
    canManage: manage,
    currentParams: sp,
    drawer,
  }
}

const f = ref<OpportunitiesData>()

export function opportunitiesSpec(data: OpportunitiesData): PageSpec {
  // The native header action and the list empty action are the same
  // CrmNewButton element; the labels ride along as loader-resolved strings.
  const newOpportunity = {
    widget: 'crm-new-button',
    props: {
      apiPath: '/api/crm/opportunities/draft',
      basePath: '/crm/opportunities',
      param: 'opportunity',
      label: data.newLabel,
      failed: data.createFailed,
    },
  }
  return page({
    route: '/crm/opportunities',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget(newOpportunity.widget, newOpportunity.props, f('canManage'))],
      }),
    ],
    body: [
      widgetBlock('entity-list-view', {
        recordType: 'opportunity',
        sp: data.currentParams,
        emptyAction: data.canManage ? newOpportunity : null,
        drawer: data.drawer
          ? [{ widget: 'opportunity-drawer', props: { drawer: data.drawer } }]
          : [],
      }),
    ],
  })
}
