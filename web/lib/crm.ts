import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

export async function loadCrmAccount(partyId: string, orgId: string) {
  const profile = (await db.execute(sql`
    select cp.*, s.name as status_name, s.is_qualified, u.name as owner_name,
           t.name as territory_name, ls.name as lead_source_name
      from crm_account_profiles cp
      left join crm_account_statuses s on s.id = cp.status_id
      left join users u on u.id = cp.owner_user_id
      left join crm_sales_territories t on t.id = cp.territory_id
      left join crm_lead_sources ls on ls.id = cp.lead_source_id
     where cp.party_id = ${partyId} and cp.org_id = ${orgId}
  `)) as unknown as { rows: Record<string, unknown>[] }
  if (!profile.rows[0]) return null
  const [activities, opportunities, stageEvents, assignments] = await Promise.all([
    db.execute(sql`
      select a.id, a.kind, a.status, a.subject, a.priority, a.starts_at, a.due_at,
             a.completed_at, u.name as assigned_name
        from crm_activities a
        join crm_activity_links l on l.activity_id = a.id
        left join users u on u.id = a.assigned_user_id
       where l.org_id = ${orgId} and l.subject_kind = 'account' and l.subject_id = ${partyId}
       order by coalesce(a.starts_at, a.due_at, a.created_at) desc limit 50`),
    db.execute(sql`
      select o.id, o.opportunity_number, o.title, o.expected_close_date, o.forecast_category,
             o.probability, o.currency, o.projected_amount, o.weighted_amount,
             s.name as status_name, s.is_closed, s.is_won, u.name as owner_name
        from crm_opportunities o
        join crm_opportunity_statuses s on s.id = o.status_id
        left join users u on u.id = o.owner_user_id
       where o.org_id = ${orgId} and o.party_id = ${partyId}
       order by s.is_closed, o.expected_close_date nulls last, o.created_at desc limit 50`),
    db.execute(sql`
      select e.*, u.name as actor_name from crm_account_stage_events e
      left join users u on u.id = e.created_by
      where e.account_profile_id = ${profile.rows[0].id}
      order by e.occurred_at desc`),
    db.execute(sql`
      select e.*, fu.name as from_owner_name, tu.name as to_owner_name,
             ft.name as from_territory_name, tt.name as to_territory_name
        from crm_account_assignment_events e
        left join users fu on fu.id = e.from_owner_user_id
        left join users tu on tu.id = e.to_owner_user_id
        left join crm_sales_territories ft on ft.id = e.from_territory_id
        left join crm_sales_territories tt on tt.id = e.to_territory_id
       where e.account_profile_id = ${profile.rows[0].id}
       order by e.occurred_at desc`),
  ]) as any[]
  return {
    profile: profile.rows[0],
    activities: activities.rows,
    opportunities: opportunities.rows,
    stageEvents: stageEvents.rows,
    assignments: assignments.rows,
  }
}

export async function loadOpportunity(id: string, orgId: string) {
  const opportunity = (await db.execute(sql`
    select o.*, p.display_name as party_name, c.name as contact_name,
           s.name as status_name, s.is_closed, s.is_won,
           u.name as owner_name, st.name as sales_team_name, ls.name as lead_source_name
      from crm_opportunities o
      join crm_opportunity_statuses s on s.id = o.status_id
      left join parties p on p.id = o.party_id
      left join contacts c on c.id = o.primary_contact_id
      left join users u on u.id = o.owner_user_id
      left join crm_sales_teams st on st.id = o.sales_team_id
      left join crm_lead_sources ls on ls.id = o.lead_source_id
     where o.id = ${id} and o.org_id = ${orgId}
  `)) as unknown as { rows: Record<string, unknown>[] }
  if (!opportunity.rows[0]) return null
  const [lines, team, documents, activities, history] = await Promise.all([
    db.execute(sql`select * from crm_opportunity_lines where opportunity_id = ${id} and org_id = ${orgId} order by line_number`),
    db.execute(sql`
      select m.*, u.name as user_name, u.email as user_email
        from crm_opportunity_team_members m join users u on u.id = m.user_id
       where m.opportunity_id = ${id} and m.org_id = ${orgId} order by m.is_primary desc, u.name`),
    db.execute(sql`
      select d.id, d.kind, d.document_number, d.document_date, d.status, d.currency, d.total
        from crm_opportunity_documents od join documents d on d.id = od.document_id
       where od.opportunity_id = ${id} and od.org_id = ${orgId} and d.org_id = ${orgId}
       order by d.document_date desc, d.created_at desc`),
    db.execute(sql`
      select a.id, a.kind, a.status, a.subject, a.starts_at, a.due_at, a.completed_at
        from crm_activities a join crm_activity_links l on l.activity_id = a.id
       where l.subject_kind = 'opportunity' and l.subject_id = ${id} and l.org_id = ${orgId}
       order by coalesce(a.starts_at, a.due_at, a.created_at) desc`),
    db.execute(sql`
      select e.*, fs.name as from_status_name, ts.name as to_status_name, u.name as actor_name
        from crm_opportunity_stage_events e
        left join crm_opportunity_statuses fs on fs.id = e.from_status_id
        join crm_opportunity_statuses ts on ts.id = e.to_status_id
        left join users u on u.id = e.created_by
       where e.opportunity_id = ${id} and e.org_id = ${orgId} order by e.occurred_at desc`),
  ]) as any[]
  return { opportunity: opportunity.rows[0], lines: lines.rows, team: team.rows, documents: documents.rows, activities: activities.rows, history: history.rows }
}

export async function loadActivity(id: string, orgId: string) {
  const activity = (await db.execute(sql`
    select a.*, ou.name as owner_name, au.name as assigned_name
      from crm_activities a
      left join users ou on ou.id = a.owner_user_id
      left join users au on au.id = a.assigned_user_id
     where a.id = ${id} and a.org_id = ${orgId}`)) as unknown as { rows: Record<string, unknown>[] }
  if (!activity.rows[0]) return null
  const [links, participants] = await Promise.all([
    db.execute(sql`select * from crm_activity_links where activity_id = ${id} and org_id = ${orgId} order by created_at`),
    db.execute(sql`
      select p.*, u.name as user_name, c.name as contact_name
        from crm_activity_participants p
        left join users u on u.id = p.user_id
        left join contacts c on c.id = p.contact_id
       where p.activity_id = ${id} and p.org_id = ${orgId} order by p.created_at`),
  ]) as any[]
  return { activity: activity.rows[0], links: links.rows, participants: participants.rows }
}

export interface ForecastScope {
  orgId: string
  periodStart: string
  periodEnd: string
  ownerUserId?: string | null
  salesTeamId?: string | null
}

/** Exact forecast rollup performed by PostgreSQL numeric arithmetic. */
export async function calculateForecast(scope: ForecastScope) {
  const ownerFilter = scope.ownerUserId ? sql`and o.owner_user_id = ${scope.ownerUserId}` : sql``
  const teamFilter = scope.salesTeamId ? sql`and o.sales_team_id = ${scope.salesTeamId}` : sql``
  const rows = (await db.execute(sql`
    with opportunity_base as (
      select o.currency, o.projected_amount, o.weighted_amount, o.forecast_category, s.is_closed, s.is_won
        from crm_opportunities o join crm_opportunity_statuses s on s.id = o.status_id
       where o.org_id = ${scope.orgId} and o.is_active
         and o.expected_close_date between ${scope.periodStart}::date and ${scope.periodEnd}::date
         ${ownerFilter} ${teamFilter}
    ), actuals as (
      select d.currency, coalesce(sum(d.total), 0)::numeric(19,4) as closed_amount
        from documents d
       where d.org_id = ${scope.orgId} and d.kind = 'customer_invoice' and d.status = 'posted'
         and d.document_date between ${scope.periodStart}::date and ${scope.periodEnd}::date
         ${scope.ownerUserId ? sql`and exists (select 1 from crm_account_profiles cp where cp.party_id = d.party_id and cp.owner_user_id = ${scope.ownerUserId})` : sql``}
       group by d.currency
    ), currencies as (
      select currency from opportunity_base union select currency from actuals
    )
    select c.currency,
           coalesce(sum(o.projected_amount) filter (where not o.is_closed and o.forecast_category <> 'omitted'), 0)::text as pipeline_amount,
           coalesce(sum(o.weighted_amount) filter (where not o.is_closed and o.forecast_category <> 'omitted'), 0)::text as weighted_amount,
           coalesce(sum(o.projected_amount) filter (where not o.is_closed and o.forecast_category = 'worst_case'), 0)::text as worst_case_amount,
           coalesce(sum(o.projected_amount) filter (where not o.is_closed and o.forecast_category = 'most_likely'), 0)::text as most_likely_amount,
           coalesce(sum(o.projected_amount) filter (where not o.is_closed and o.forecast_category = 'upside'), 0)::text as upside_amount,
           coalesce(max(a.closed_amount), 0)::text as closed_amount
      from currencies c
      left join opportunity_base o on o.currency = c.currency
      left join actuals a on a.currency = c.currency
     group by c.currency order by c.currency
  `)) as unknown as { rows: Record<string, string>[] }
  return rows.rows
}
