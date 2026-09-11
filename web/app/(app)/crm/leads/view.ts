import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { isUuid, pickString } from '../../../../lib/list-params'
import { loadParty } from '../../../api/parties/_lib'
import { loadCrmAccount } from '../../../../lib/crm'
import type { AccountDrawer } from '../AccountDrawer'

/**
 * The lead list, split into a loader and a spec.
 *
 * Almost all of the page is the universal entity list; what is page-specific
 * is the header button and the drawer SLOT, which the native page fills with
 * the account flyout (or nothing). The spec names widgets and the slot
 * resolves them, the same indirection the empty state uses for its action.
 *
 * Two things the native page settles, kept as-is:
 *
 * 1. There is no `?account=new` redirect. A non-uuid `account` param fails
 *    `isUuid` and renders no drawer; drafts are created by the header
 *    button's POST. So the drawer slot holds at most one widget.
 * 2. The native drawer carries no `key`, so neither does the spec's.
 *    Switching accounts reuses the mounted flyout in both renders.
 *
 * The header button is gated on `crm.accounts.create` while the drawer's save
 * control is gated on `crm.accounts.manage` — two different permissions, so
 * both ride the loader separately. The entity list's own `canManage`
 * (`admin.customization.manage`) is re-derived by the slot, never shipped.
 */

type AccountDrawerProps = Parameters<typeof AccountDrawer>[0]

export interface LeadsData {
  title: string
  description: string
  newLabel: string
  createFailed: string
  canCreate: boolean
  currentParams: Record<string, string | string[] | undefined>
  drawer: AccountDrawerProps | null
}

export async function loadLeads(
  sp: Record<string, string | string[] | undefined>,
): Promise<LeadsData> {
  const authz = await requirePermission('crm.accounts.read')
  const canManage = can(authz, 'crm.accounts.manage')
  const canCreate = can(authz, 'crm.accounts.create')
  const t = await getTranslations('crm')
  const basePath = '/crm/leads'
  const openId = pickString(sp.account)

  let drawer: AccountDrawerProps | null = null
  if (openId && isUuid(openId)) {
    const [party, account, statuses, owners, territories, sources] = await Promise.all([
      loadParty(openId, authz.user.orgId, authz.allowedSubsidiaryIds),
      loadCrmAccount(openId, authz.user.orgId, authz.allowedSubsidiaryIds),
      db.execute(sql`select id,name,lifecycle_stage from crm_account_statuses where org_id=${authz.user.orgId} and is_active order by lifecycle_stage,sequence`) as any,
      db.execute(sql`select id,name from users where org_id=${authz.user.orgId} and is_active order by name`) as any,
      db.execute(sql`select id,name from crm_sales_territories where org_id=${authz.user.orgId} and is_active order by priority,name`) as any,
      db.execute(sql`select id,name from crm_lead_sources where org_id=${authz.user.orgId} and is_active order by name`) as any,
    ])
    if (party && account) {
      const requestedReturn = pickString(sp.drawerReturn)
      drawer = {
        data: { ...party, crm: account } as unknown as AccountDrawerProps['data'],
        statuses: statuses.rows as unknown as AccountDrawerProps['statuses'],
        owners: owners.rows as unknown as AccountDrawerProps['owners'],
        territories: territories.rows as unknown as AccountDrawerProps['territories'],
        sources: sources.rows as unknown as AccountDrawerProps['sources'],
        basePath: requestedReturn?.startsWith(basePath) ? requestedReturn : basePath,
        canManage,
      }
    }
  }

  return {
    title: t('accounts.lead.title'),
    description: t('accounts.lead.description'),
    newLabel: t('accounts.lead.new'),
    createFailed: t('feedback.createFailed'),
    canCreate,
    currentParams: sp,
    drawer,
  }
}

const f = ref<LeadsData>()

export function leadsSpec(data: LeadsData): PageSpec {
  // The native header action and the list empty action are the same
  // CrmNewButton element; the labels ride along as loader-resolved strings.
  const newLead = {
    widget: 'crm-new-button',
    props: {
      apiPath: '/api/crm/accounts/draft',
      basePath: '/crm/leads',
      param: 'account',
      label: data.newLabel,
      failed: data.createFailed,
    },
  }
  return page({
    route: '/crm/leads',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget(newLead.widget, newLead.props, f('canCreate'))],
      }),
    ],
    body: [
      widgetBlock('entity-list-view', {
        recordType: 'lead',
        sp: data.currentParams,
        emptyAction: data.canCreate ? newLead : null,
        drawer: data.drawer
          ? [{ widget: 'crm-account-drawer', props: { drawer: data.drawer } }]
          : [],
      }),
    ],
  })
}
