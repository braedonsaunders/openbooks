import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { crmSharedScope, crmOpportunityScope } from '../../../../lib/crm-scope'
import { can, requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { customerGroupTabs } from '../../../../components/module-home/group-tabs'
import { isUuid, pickString } from '../../../../lib/list-params'
import { documentRevisionCounterSql } from '@openbooks/engine/src/records/revision.ts'
import { loadOpportunity } from '../../../../lib/crm'
import type { OpportunityDrawer } from '../OpportunityDrawer'
import type { KanbanOpportunity, KanbanStatus } from '../OpportunityKanban'

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
  viewMode: 'board' | 'list'
  currentParams: Record<string, string | string[] | undefined>
  tabs: Awaited<ReturnType<typeof customerGroupTabs>>
  drawer: OpportunityDrawerProps | null
  board: {
    statuses: KanbanStatus[]
    opportunities: KanbanOpportunity[]
    undatedOnly: boolean
    undatedLabel: string
    showAllLabel: string
  } | null
}

export async function loadOpportunities(
  sp: Record<string, string | string[] | undefined>,
): Promise<OpportunitiesData> {
  const authz = await requirePermission('crm.opportunities.read')
  const manage = can(authz, 'crm.opportunities.manage')
  const t = await getTranslations('crm')
  const openId = pickString(sp.opportunity)
  const viewMode: 'board' | 'list' = pickString(sp.view) === 'board' ? 'board' : 'list'
  // Forecast exclusion note links here with `undated=1`: the pipeline the
  // weighted forecast cannot see is exactly the undated population. The
  // forecast carries its active owner/team scope on that link, and the board
  // honours it — otherwise the board widens to the whole org while the
  // exclusion count beside the link stays scoped. Owner wins over team,
  // mirroring the forecasts loader's exclusivity.
  const undatedOnly = pickString(sp.undated) === '1'
  const requestedOwner = pickString(sp.owner)
  const requestedTeam = pickString(sp.team)
  const boardOwnerUserId = requestedOwner && isUuid(requestedOwner) ? requestedOwner : null
  const boardSalesTeamId =
    !boardOwnerUserId && requestedTeam && isUuid(requestedTeam) ? requestedTeam : null

  let board: OpportunitiesData['board'] = null
  if (viewMode === 'board') {
    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000
    const [statusesResult, opportunitiesResult] = await Promise.all([
      db.execute<{
        id: string
        key: string
        name: string
        sequence: number
        probability: number
        default_forecast_category: string
        is_closed: boolean
        is_won: boolean
      }>(sql`
        select id, key, name, sequence, probability, default_forecast_category, is_closed, is_won
          from crm_opportunity_statuses
         where org_id = ${authz.user.orgId} and is_active
         order by sequence`),
      db.execute<{
        id: string
        opportunity_number: string
        title: string
        party_id: string | null
        party_name: string | null
        primary_contact_id: string | null
        contact_name: string | null
        owner_user_id: string | null
        owner_name: string | null
        sales_team_name: string | null
        status_id: string
        forecast_category: string
        probability: number
        currency: string
        projected_amount: string
        weighted_amount: string
        expected_close_date: string | null
        next_step: string | null
        win_loss_reason: string | null
        updated_at: string
        revision_token: string
        last_activity_at: string | null
        lines_count: number
      }>(sql`
        select o.id, o.opportunity_number, o.title, o.party_id, p.display_name as party_name,
               o.primary_contact_id, c.name as contact_name, o.owner_user_id, u.name as owner_name,
               st.name as sales_team_name, o.status_id,
               o.forecast_category, o.probability, o.currency,
               o.projected_amount::text, o.weighted_amount::text, o.expected_close_date::text, o.next_step,
               o.win_loss_reason, o.updated_at::text,
               ${documentRevisionCounterSql(sql`o.revision_seq`)} as revision_token,
               (select max(coalesce(a.starts_at, a.due_at, a.created_at))::text
                  from crm_activities a
                  join crm_activity_links l on l.activity_id = a.id and l.org_id = a.org_id
                 where l.org_id = o.org_id and l.subject_kind = 'opportunity' and l.subject_id = o.id) as last_activity_at,
               (select count(*)::int from crm_opportunity_lines where opportunity_id = o.id and org_id = o.org_id) as lines_count
          from crm_opportunities o
          join crm_opportunity_statuses s on s.id = o.status_id and s.org_id = o.org_id
          left join parties p on p.id = o.party_id and p.org_id = o.org_id
          left join contacts c on c.id = o.primary_contact_id and c.org_id = o.org_id
          left join users u on u.id = o.owner_user_id
          left join crm_sales_teams st on st.id = o.sales_team_id and st.org_id = o.org_id
         where o.org_id = ${authz.user.orgId} and o.is_active${crmOpportunityScope(authz.allowedSubsidiaryIds)}
           ${undatedOnly ? sql`and o.expected_close_date is null` : sql``}
           ${boardOwnerUserId ? sql`and o.owner_user_id = ${boardOwnerUserId}` : sql``}
           ${boardSalesTeamId ? sql`and o.sales_team_id = ${boardSalesTeamId}` : sql``}
         order by o.expected_close_date nulls last, o.created_at desc
         limit 500`),
    ])

    const kanbanStatuses: KanbanStatus[] = statusesResult.rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      sequence: row.sequence,
      probability: row.probability,
      defaultForecastCategory: row.default_forecast_category,
      isClosed: row.is_closed,
      isWon: row.is_won,
    }))

    const kanbanOpportunities: KanbanOpportunity[] = opportunitiesResult.rows.map((row) => {
      const activeTimestamp = row.last_activity_at || row.updated_at
      const isStagnant =
        activeTimestamp ? new Date(activeTimestamp).getTime() < fourteenDaysAgo : false

      return {
        id: row.id,
        opportunityNumber: row.opportunity_number,
        title: row.title,
        partyId: row.party_id,
        partyName: row.party_name,
        primaryContactId: row.primary_contact_id,
        contactName: row.contact_name,
        ownerUserId: row.owner_user_id,
        ownerName: row.owner_name,
        salesTeamName: row.sales_team_name,
        statusId: row.status_id,
        forecastCategory: row.forecast_category,
        probability: row.probability,
        currency: row.currency,
        projectedAmount: row.projected_amount ?? '0',
        weightedAmount: row.weighted_amount ?? '0',
        expectedCloseDate: row.expected_close_date,
        nextStep: row.next_step,
        winLossReason: row.win_loss_reason,
        updatedAt: row.revision_token || row.updated_at,
        isStagnant,
        linesCount: row.lines_count ?? 0,
      }
    })

    board = {
      statuses: kanbanStatuses,
      opportunities: kanbanOpportunities,
      undatedOnly,
      undatedLabel: t('opportunities.undatedOnly'),
      showAllLabel: t('opportunities.showAll'),
    }
  }

  let drawer: (OpportunityDrawerProps & { remountKey: string }) | null = null
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
        // Keyed by the open record: the drawer holds unsaved edits in local
        // state, so switching records must remount it rather than pour B's
        // props into A's dirty form.
        remountKey: openId,
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
    viewMode,
    currentParams: sp,
    tabs: await customerGroupTabs(authz, '/crm/opportunities'),
    drawer,
    board,
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
  const viewSwitcher = {
    widget: 'opportunity-view-switcher',
    props: {
      view: data.viewMode,
    },
  }

  const isBoard = data.viewMode === 'board' && data.board

  return page({
    route: '/crm/opportunities',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex items-center gap-3',
        actions: [
          widget(viewSwitcher.widget, viewSwitcher.props),
          widget(newOpportunity.widget, newOpportunity.props, f('canManage')),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      isBoard
        ? widgetBlock('opportunity-kanban-board', {
            statuses: data.board!.statuses,
            opportunities: data.board!.opportunities,
            undatedOnly: data.board!.undatedOnly,
            undatedLabel: data.board!.undatedLabel,
            showAllLabel: data.board!.showAllLabel,
            canManage: data.canManage,
            drawer: data.drawer
              ? [{ widget: 'opportunity-drawer', props: { drawer: data.drawer } }]
              : [],
          })
        : widgetBlock('entity-list-view', {
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
