import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import {
  isUuid,
  parseListParams,
  pickString,
} from '../../../../../lib/list-params'
import type { CrmSetupTab } from './CrmSetupWorkspace'

/**
 * CRM setup lists: account statuses, opportunity stages and lead sources.
 * Each list is its own Setup page addressed by `?tab=`.
 *
 * The page is one client island: the toolbar, the per-list table (rows
 * navigate on click and Enter, with translated and badge cells), the pager
 * and the edit drawer that holds a draft in local state before saving. The
 * spec places one `crm-setup-workspace` widget and the loader resolves the
 * crm.setup.manage and CRM feature gates, the list, and the ?row= drawer
 * record (organization- and uuid-guarded).
 */

const TABS: CrmSetupTab[] = ['accountStatuses', 'opportunityStatuses', 'sources']

export interface CrmSetupData {
  tab: CrmSetupTab
  rows: Record<string, unknown>[]
  selected: Record<string, unknown> | null
  creating: boolean
  total: number
  page: number
  perPage: number
  currentParams: Record<string, string | string[] | undefined>
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
  } else {
    ;[rowsResult, countResult] = await Promise.all([
      db.execute(sql`
        select * from crm_lead_sources
         where org_id=${orgId} ${list.q ? sql`and (name ilike ${term} or description ilike ${term})` : sql``}
         order by name limit ${list.perPage} offset ${offset}`),
      db.execute(
        sql`select count(*)::int n from crm_lead_sources where org_id=${orgId} ${list.q ? sql`and (name ilike ${term} or description ilike ${term})` : sql``}`,
      ),
    ])
  }

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
    else
      selectedResult = await db.execute(
        sql`select * from crm_lead_sources where id=${rowParam} and org_id=${orgId}`,
      )
    selected = (selectedResult.rows[0] as Record<string, unknown> | undefined) ?? null
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
      // table and the labor-costing workspace: the toolbar, the per-list
      // table, the pager and the drawer all own
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
      }),
    ],
  })
}
