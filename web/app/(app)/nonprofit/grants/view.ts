import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  page,
  pageHeader,
  ref,
  textBlock,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { assertUnrestrictedScope, UnrestrictedScopeError } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import {
  getGrantBudget,
  getGrantTerms,
  listGrantActivity,
  listGrantDrawdowns,
  listGrantReports,
} from '@openbooks/engine/src/nonprofit/grants.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isUuid, pickString } from '../../../../lib/list-params'
import { nonprofitGroupTabs } from '../../../../components/module-home/group-tabs'

/**
 * The grant register, split into a loader and a spec.
 *
 * The fixed-asset register archetype: the list itself is the universal
 * EntityListView (`grant`), so it arrives through the slot that re-derives
 * Authz server-side. The spec carries only the record type, the current
 * params, and a widget ref for the drawer — never an org id. The drawer
 * payload (terms, budget and allowable costs, drawdowns, reports, activity)
 * is ledger truth read here, beside the list, exactly like the asset pickers.
 *
 * Grants are org-wide: a subsidiary-restricted caller fails closed here with
 * a named refusal instead of a filtered list.
 */

export interface GrantAccountOption {
  id: string
  number: string | null
  name: string
  type: string
}

export interface GrantGroupOption extends Record<string, unknown> {
  id: string
  name: string
  dimension: string
}

/** Active account groups: the allowable-cost group and the MTDC excluded-cost and subaward groups. */
function loadGroupOptions(orgId: string) {
  return db.execute<GrantGroupOption>(sql`
    select id::text as id, name, dimension from account_groups
     where org_id = ${orgId} and is_active
     order by dimension, name limit 500`)
}

export interface GrantRecordDrawer {
  mode: 'record'
  remountKey: string
  terms: Awaited<ReturnType<typeof getGrantTerms>>
  budget: Awaited<ReturnType<typeof getGrantBudget>>
  drawdowns: Awaited<ReturnType<typeof listGrantDrawdowns>>
  reports: Awaited<ReturnType<typeof listGrantReports>>
  activity: Awaited<ReturnType<typeof listGrantActivity>>
  accountOptions: GrantAccountOption[]
  groupOptions: GrantGroupOption[]
  asOf: string
  canManage: boolean
  closeHref: string
}

export interface GrantCreateDrawer {
  mode: 'create'
  fundOptions: { id: string; code: string; name: string }[]
  groupOptions: GrantGroupOption[]
  sponsorOptions: { id: string; displayName: string }[]
  canManage: boolean
  closeHref: string
}

export type GrantDrawerData = GrantRecordDrawer | GrantCreateDrawer

export interface GrantsData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  tabs: Awaited<ReturnType<typeof nonprofitGroupTabs>>
  scopeDenied: boolean
  scopeDeniedMessage: string
  drawer: GrantDrawerData | null
}

export async function loadGrants(
  sp: Record<string, string | string[] | undefined>,
): Promise<GrantsData> {
  const authz = await requirePermission('grants.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'grantManagement')
  const t = await getTranslations('nonprofit')
  const tabs = await nonprofitGroupTabs(authz, '/nonprofit/grants')

  const base: GrantsData = {
    title: t('grants.title'),
    description: t('grants.description'),
    currentParams: sp,
    tabs,
    scopeDenied: false,
    scopeDeniedMessage: '',
    drawer: null,
  }

  try {
    assertUnrestrictedScope(authz.allowedSubsidiaryIds)
  } catch (error) {
    // A subsidiary-restricted caller is refused the whole register: the
    // denial carries the translated remedy, and the spec below omits the
    // list entirely, so no list fetch can fail differently beside it.
    if (error instanceof UnrestrictedScopeError) {
      return { ...base, scopeDenied: true, scopeDeniedMessage: t('grants.scopeDeniedMessage') }
    }
    throw error
  }

  const grantId = pickString(sp.grant)
  if (!grantId) return base
  if (grantId === 'new') {
    const [funds, groups, sponsors] = await Promise.all([
      db.execute<{ id: string; code: string; name: string }>(sql`
        select sv.id::text as id, sv.code, sv.name
          from funds f
          join segment_values sv on sv.org_id = f.org_id and sv.id = f.id
         where f.org_id = ${orgId} and sv.is_active
         order by sv.code limit 200`),
      loadGroupOptions(orgId),
      db.execute<{ id: string; display_name: string }>(sql`
        select id::text as id, display_name from parties
         where org_id = ${orgId} and is_active
         order by display_name limit 200`),
    ])
    return {
      ...base,
      drawer: {
        mode: 'create',
        fundOptions: funds.rows,
        groupOptions: groups.rows,
        sponsorOptions: sponsors.rows.map((row) => ({ id: row.id, displayName: row.display_name })),
        canManage: can(authz, 'grants.manage'),
        closeHref: '/nonprofit/grants',
      },
    }
  }
  if (!isUuid(grantId)) return base
  const asOf = await businessToday(orgId)
  const detail = await Promise.all([
    getGrantTerms(orgId, grantId),
    getGrantBudget(orgId, grantId),
    listGrantDrawdowns(orgId, grantId),
    listGrantReports(orgId, grantId, asOf),
    listGrantActivity(orgId, grantId),
    db.execute<{ id: string; number: string | null; name: string; type: string }>(sql`
      select id::text as id, number, name, type from accounts
       where org_id = ${orgId} and is_active and not is_summary
         and type in ('asset_bank', 'asset_receivable',
                      'liability_current_other', 'liability_long_term', 'liability_payable',
                      'income', 'income_other')
       order by number nulls last, name limit 500`),
    loadGroupOptions(orgId),
  ]).catch((error) => {
    // A missing or cross-org grant is not a drawer: the register stays.
    if (error?.code === 'grant_not_found' || error?.code === 'grant_version_missing') return null
    throw error
  })
  if (!detail) return base
  const [terms, budget, drawdowns, reports, activity, accounts, groups] = detail

  return {
    ...base,
    drawer: {
      mode: 'record',
      remountKey: terms.id,
      terms,
      budget,
      drawdowns,
      reports,
      activity,
      accountOptions: accounts.rows,
      groupOptions: groups.rows,
      asOf,
      canManage: can(authz, 'grants.manage'),
      closeHref: '/nonprofit/grants',
    },
  }
}

const f = ref<GrantsData>()

export function grantsSpec(data: GrantsData): PageSpec {
  return page({
    route: '/nonprofit/grants',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center justify-end gap-2',
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      // While denied the list is neither emitted nor loaded: the refusal
      // below is the whole page outcome.
      ...(!data.scopeDenied
        ? [
            {
              ...widgetBlock('entity-list-view', {
                recordType: 'grant',
                sp: data.currentParams,
                drawer: [data.drawer ? { widget: 'grant-drawer', props: { drawer: data.drawer } } : null].filter(
                  Boolean,
                ),
                emptyAction: null,
              }),
            },
          ]
        : []),
      textBlock(f('scopeDeniedMessage'), { when: f('scopeDenied') }),
    ],
  })
}
