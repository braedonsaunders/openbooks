import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../../../lib/features'
import {
  isUuid,
  parseListParams,
  pickString,
} from '../../../../../lib/list-params'
import type { CrmSetupTab } from './CrmSetupWorkspace'

/**
 * CRM setup lists, split into a loader and a spec.
 *
 * The whole page is one client island: the underline tab strip, the search +
 * New-button toolbar, the hand-rolled per-tab table, the pager and the edit
 * drawer all live inside `CrmSetupWorkspace`. None of that decomposes into
 * spec blocks — the tab strip is underline links with per-tab active classes
 * (a conditional pair, not presence), the table rows navigate on click and
 * Enter with per-tab column sets and translated/badge/money cells, and the
 * drawer edits drafts in local state before POST-ing. So the spec places one
 * `crm-setup-workspace` widget and the loader binds every prop verbatim from
 * the native page: the tab whitelist, the six per-tab list queries, the
 * multiCurrency probe, the user/team/currency pickers, and the ?row= flyout
 * resolution (org guard, uuid guard, team-member expansion).
 *
 * Loader work copied verbatim from page.tsx: the crm.setup.manage gate, the
 * crm feature gate, the tab fallback, and all six tab queries. No formatting
 * moves server-side — cells render client-side in the shared component, so
 * money, badges and translated enums stay identical by construction.
 */

const TABS: CrmSetupTab[] = [
  'accountStatuses',
  'opportunityStatuses',
  'sources',
  'territories',
  'teams',
  'quotas',
]

export interface CrmSetupData {
  tab: CrmSetupTab
  rows: Record<string, unknown>[]
  selected: Record<string, unknown> | null
  creating: boolean
  total: number
  page: number
  perPage: number
  currentParams: Record<string, string | string[] | undefined>
  users: { id: string; name: string }[]
  teams: { id: string; name: string }[]
  baseCurrency: string
  currencies: { code: string; name: string }[]
  multiCurrency: boolean
}

export async function loadCrmSetup(
  sp: Record<string, string | string[] | undefined>,
): Promise<CrmSetupData> {
  const authz = await requirePermission('crm.setup.manage')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'crm')
  const requestedTab = pickString(sp.tab) as CrmSetupTab | undefined
  const tab =
    requestedTab && TABS.includes(requestedTab)
      ? requestedTab
      : 'accountStatuses'
  const list = parseListParams(sp, {
    sort: 'default',
    allowedSorts: ['default'] as const,
    perPage: 25,
  })
  const offset = (list.page - 1) * list.perPage
  const term = `%${list.q ?? ''}%`

  let rowsResult
  let countResult
  if (tab === 'accountStatuses') {
    ;[rowsResult, countResult] = await Promise.all([
      db.execute(sql`
        select * from crm_account_statuses
         where org_id=${orgId} ${list.q ? sql`and (name ilike ${term} or description ilike ${term} or lifecycle_stage ilike ${term})` : sql``}
         order by lifecycle_stage, sequence, name limit ${list.perPage} offset ${offset}`),
      db.execute(
        sql`select count(*)::int n from crm_account_statuses where org_id=${orgId} ${list.q ? sql`and (name ilike ${term} or description ilike ${term} or lifecycle_stage ilike ${term})` : sql``}`,
      ),
    ])
  } else if (tab === 'opportunityStatuses') {
    ;[rowsResult, countResult] = await Promise.all([
      db.execute(sql`
        select * from crm_opportunity_statuses
         where org_id=${orgId} ${list.q ? sql`and (name ilike ${term} or description ilike ${term} or default_forecast_category ilike ${term})` : sql``}
         order by sequence, name limit ${list.perPage} offset ${offset}`),
      db.execute(
        sql`select count(*)::int n from crm_opportunity_statuses where org_id=${orgId} ${list.q ? sql`and (name ilike ${term} or description ilike ${term} or default_forecast_category ilike ${term})` : sql``}`,
      ),
    ])
  } else if (tab === 'sources') {
    ;[rowsResult, countResult] = await Promise.all([
      db.execute(sql`
        select * from crm_lead_sources
         where org_id=${orgId} ${list.q ? sql`and (name ilike ${term} or description ilike ${term})` : sql``}
         order by name limit ${list.perPage} offset ${offset}`),
      db.execute(
        sql`select count(*)::int n from crm_lead_sources where org_id=${orgId} ${list.q ? sql`and (name ilike ${term} or description ilike ${term})` : sql``}`,
      ),
    ])
  } else if (tab === 'territories') {
    ;[rowsResult, countResult] = await Promise.all([
      db.execute(sql`
        select t.*, u.name owner_name, m.name manager_name
          from crm_sales_territories t
          left join users u on u.id=t.default_owner_user_id
          left join users m on m.id=t.manager_user_id
         where t.org_id=${orgId} ${list.q ? sql`and (t.name ilike ${term} or t.description ilike ${term} or u.name ilike ${term} or m.name ilike ${term})` : sql``}
         order by t.priority, t.name limit ${list.perPage} offset ${offset}`),
      db.execute(sql`
        select count(*)::int n from crm_sales_territories t
        left join users u on u.id=t.default_owner_user_id
        left join users m on m.id=t.manager_user_id
        where t.org_id=${orgId} ${list.q ? sql`and (t.name ilike ${term} or t.description ilike ${term} or u.name ilike ${term} or m.name ilike ${term})` : sql``}`),
    ])
  } else if (tab === 'teams') {
    ;[rowsResult, countResult] = await Promise.all([
      db.execute(sql`
        select t.*, u.name manager_name, count(tm.id)::int member_count
          from crm_sales_teams t
          left join users u on u.id=t.manager_user_id
          left join crm_sales_team_members tm on tm.team_id=t.id and tm.org_id=t.org_id and tm.is_active
         where t.org_id=${orgId} ${list.q ? sql`and (t.name ilike ${term} or u.name ilike ${term})` : sql``}
         group by t.id, u.name order by t.name limit ${list.perPage} offset ${offset}`),
      db.execute(sql`
        select count(*)::int n from crm_sales_teams t left join users u on u.id=t.manager_user_id
        where t.org_id=${orgId} ${list.q ? sql`and (t.name ilike ${term} or u.name ilike ${term})` : sql``}`),
    ])
  } else {
    ;[rowsResult, countResult] = await Promise.all([
      db.execute(sql`
        select q.*, coalesce(u.name,t.name) target_name
          from crm_sales_quotas q
          left join users u on u.id=q.owner_user_id
          left join crm_sales_teams t on t.id=q.sales_team_id and t.org_id=q.org_id
         where q.org_id=${orgId} ${list.q ? sql`and (u.name ilike ${term} or t.name ilike ${term} or q.currency ilike ${term})` : sql``}
         order by q.period_start desc, target_name limit ${list.perPage} offset ${offset}`),
      db.execute(sql`
        select count(*)::int n from crm_sales_quotas q
        left join users u on u.id=q.owner_user_id left join crm_sales_teams t on t.id=q.sales_team_id and t.org_id=q.org_id
        where q.org_id=${orgId} ${list.q ? sql`and (u.name ilike ${term} or t.name ilike ${term} or q.currency ilike ${term})` : sql``}`),
    ])
  }

  const multiCurrency = await isFeatureEnabled(orgId, 'multiCurrency')
  const [usersResult, teamsResult, orgResult, currenciesResult] =
    (await Promise.all([
      db.execute(
        sql`select id,name from users where org_id=${orgId} and is_active order by name`,
      ),
      db.execute(
        sql`select id,name from crm_sales_teams where org_id=${orgId} and is_active order by name`,
      ),
      db.execute(sql`select base_currency from orgs where id=${orgId}`),
      multiCurrency
        ? db.execute(sql`select code,name from currencies order by code`)
        : Promise.resolve({ rows: [] }),
    ])) as unknown as [any, any, any, any]

  const rowParam = pickString(sp.row)
  const creating = rowParam === 'new'
  let selected: Record<string, unknown> | null = null
  if (rowParam && rowParam !== 'new' && isUuid(rowParam)) {
    let selectedResult
    if (tab === 'accountStatuses')
      selectedResult = await db.execute(
        sql`select * from crm_account_statuses where id=${rowParam} and org_id=${orgId}`,
      )
    else if (tab === 'opportunityStatuses')
      selectedResult = await db.execute(
        sql`select * from crm_opportunity_statuses where id=${rowParam} and org_id=${orgId}`,
      )
    else if (tab === 'sources')
      selectedResult = await db.execute(
        sql`select * from crm_lead_sources where id=${rowParam} and org_id=${orgId}`,
      )
    else if (tab === 'territories')
      selectedResult = await db.execute(
        sql`select * from crm_sales_territories where id=${rowParam} and org_id=${orgId}`,
      )
    else if (tab === 'teams')
      selectedResult = await db.execute(
        sql`select * from crm_sales_teams where id=${rowParam} and org_id=${orgId}`,
      )
    else
      selectedResult = await db.execute(
        sql`select * from crm_sales_quotas where id=${rowParam} and org_id=${orgId}`,
      )
    selected = (selectedResult.rows[0] as Record<string, unknown> | undefined) ?? null
    if (selected && tab === 'teams') {
      const members = await db.execute(
        sql`select user_id,role from crm_sales_team_members where team_id=${rowParam} and org_id=${orgId} and is_active order by role,user_id`,
      )
      selected.members = (members.rows as { user_id: string; role: string }[]).map((member) => ({
        userId: member.user_id,
        role: member.role,
      }))
    }
  }

  return {
    tab,
    rows: rowsResult.rows as unknown as Record<string, unknown>[],
    selected,
    creating,
    total: Number(
      (countResult.rows[0] as { n?: unknown } | undefined)?.n ?? 0,
    ),
    page: list.page,
    perPage: list.perPage,
    currentParams: sp,
    users: usersResult.rows as { id: string; name: string }[],
    teams: teamsResult.rows as { id: string; name: string }[],
    baseCurrency:
      (orgResult.rows[0] as { base_currency?: string } | undefined)
        ?.base_currency ?? '',
    currencies: currenciesResult.rows as { code: string; name: string }[],
    multiCurrency,
  }
}

export function crmSetupSpec(data: CrmSetupData): PageSpec {
  return page({
    route: '/admin/setup/crm',
    // The setup workspace renders its own shell around every entity page;
    // wrapping it in a second page layout would nest the chrome.
    layout: 'bare',
    header: [],
    body: [
      // The whole page is one client island, passed whole like the approvals
      // table and the labor-costing workspace: the tab strip, the toolbar,
      // the per-tab hand-rolled table, the pager and the drawer all own
      // client behavior (router.push navigation, row-click routing, draft
      // state) a spec cannot name. Every prop is loader-resolved data.
      widgetBlock('crm-setup-workspace', {
        tab: data.tab,
        rows: data.rows,
        selected: data.selected,
        creating: data.creating,
        total: data.total,
        page: data.page,
        perPage: data.perPage,
        currentParams: data.currentParams,
        users: data.users,
        teams: data.teams,
        baseCurrency: data.baseCurrency,
        currencies: data.currencies,
        multiCurrency: data.multiCurrency,
      }),
    ],
  })
}
