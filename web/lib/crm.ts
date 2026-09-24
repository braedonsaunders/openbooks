import 'server-only'
import { crmOpportunityScope, crmSharedScope, crmActivityScope } from './crm-scope'
import { sql, type SQL } from 'drizzle-orm'
import { subsidiaryVisibleFilter } from './subsidiaries'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { documentRevisionCounterSql, documentRevisionSql, isDocumentRevisionToken } from '@openbooks/engine/src/records/revision.ts'
import { isDocKindEnabled } from "./documents.ts";
import { isIsoCalendarDate } from './crm-dates'

export async function loadCrmAccount(partyId: string, orgId: string, allowed?: ReadonlySet<string> | null) {
  const profile = (await db.execute<Record<string, unknown>>(sql`
    select cp.*, ${documentRevisionSql(sql`cp.updated_at`)} as "__accountRevision",
           s.name as status_name, s.is_qualified, u.name as owner_name,
           t.name as territory_name, ls.name as lead_source_name
      from crm_account_profiles cp
      join parties scope_party on scope_party.id=cp.party_id and scope_party.org_id=cp.org_id
      left join crm_account_statuses s on s.id = cp.status_id and s.org_id = cp.org_id
      left join users u on u.id = cp.owner_user_id
      left join crm_sales_territories t on t.id = cp.territory_id and t.org_id = cp.org_id
      left join crm_lead_sources ls on ls.id = cp.lead_source_id and ls.org_id = cp.org_id
     where cp.party_id = ${partyId} and cp.org_id = ${orgId}${crmSharedScope(sql`scope_party.subsidiary_id`,allowed)}
  `))
  if (!profile.rows[0]) return null
  // The revision token never leaves this module in raw form: updated_at
  // carries the exact persisted revision token every relationship save must
  // send back as expectedUpdatedAt (same wire form as document revisions,
  // and the same rewrite loadOpportunity performs for opportunities).
  {
    const head = profile.rows[0]!
    const revision = head['__accountRevision']
    if (!isDocumentRevisionToken(revision)) {
      throw new Error('account read did not return an exact persisted revision')
    }
    delete head['__accountRevision']
    head.updated_at = revision
  }
  const [activities, opportunities, stageEvents, assignments] = await Promise.all([
    db.execute(sql`
      select a.id, a.kind, a.status, a.subject, a.priority, a.starts_at, a.due_at,
             a.completed_at, u.name as assigned_name
        from crm_activities a
        join crm_activity_links l on l.activity_id = a.id and l.org_id = a.org_id
        left join users u on u.id = a.assigned_user_id
       where l.org_id = ${orgId} and l.subject_kind = 'account' and l.subject_id = ${partyId}${crmActivityScope(allowed)}
       order by coalesce(a.starts_at, a.due_at, a.created_at) desc limit 50`),
    db.execute(sql`
      select o.id, o.opportunity_number, o.title, o.expected_close_date, o.forecast_category,
             o.probability, o.currency, o.projected_amount, o.weighted_amount,
             s.name as status_name, s.is_closed, s.is_won, u.name as owner_name
        from crm_opportunities o
        join crm_opportunity_statuses s on s.id = o.status_id and s.org_id = o.org_id
        left join users u on u.id = o.owner_user_id
       where o.org_id = ${orgId} and o.party_id = ${partyId}${crmOpportunityScope(allowed)}
       order by s.is_closed, o.expected_close_date nulls last, o.created_at desc limit 50`),
    db.execute(sql`
      select e.*, u.name as actor_name from crm_account_stage_events e
      left join users u on u.id = e.created_by
      where e.account_profile_id = ${profile.rows[0].id} and e.org_id = ${orgId}
      order by e.occurred_at desc`),
    db.execute(sql`
      select e.*, fu.name as from_owner_name, tu.name as to_owner_name,
             ft.name as from_territory_name, tt.name as to_territory_name
        from crm_account_assignment_events e
        left join users fu on fu.id = e.from_owner_user_id
        left join users tu on tu.id = e.to_owner_user_id
        left join crm_sales_territories ft on ft.id = e.from_territory_id and ft.org_id = e.org_id
        left join crm_sales_territories tt on tt.id = e.to_territory_id and tt.org_id = e.org_id
       where e.account_profile_id = ${profile.rows[0].id} and e.org_id = ${orgId}
       order by e.occurred_at desc`),
  ])
  return {
    profile: profile.rows[0],
    activities: activities.rows,
    opportunities: opportunities.rows,
    stageEvents: stageEvents.rows,
    assignments: assignments.rows,
  }
}

export async function loadOpportunity(id: string, orgId: string, allowed?: ReadonlySet<string> | null) {
  const opportunity = (await db.execute<Record<string, unknown>>(sql`
    select o.*, ${documentRevisionCounterSql(sql`o.revision_seq`)} as "__opportunityRevision",
           p.display_name as party_name, c.name as contact_name,
           s.name as status_name, s.is_closed, s.is_won,
           u.name as owner_name, st.name as sales_team_name, ls.name as lead_source_name
      from crm_opportunities o
      join crm_opportunity_statuses s on s.id = o.status_id and s.org_id = o.org_id
      left join parties p on p.id = o.party_id and p.org_id = o.org_id
      left join contacts c on c.id = o.primary_contact_id and c.org_id = o.org_id
      left join users u on u.id = o.owner_user_id
      left join crm_sales_teams st on st.id = o.sales_team_id and st.org_id = o.org_id
      left join crm_lead_sources ls on ls.id = o.lead_source_id and ls.org_id = o.org_id
     where o.id = ${id} and o.org_id = ${orgId}${crmOpportunityScope(allowed)}
  `))
  if (!opportunity.rows[0]) return null
  // The revision counter never leaves this module in raw form: updated_at
  // carries the exact persisted revision token every opportunity save must
  // send back as expectedUpdatedAt (same wire form as document revisions).
  {
    const head = opportunity.rows[0]!
    const revision = head["__opportunityRevision"]
    if (!isDocumentRevisionToken(revision)) {
      throw new Error('opportunity read did not return an exact persisted revision')
    }
    delete head["__opportunityRevision"]
    head.updated_at = revision
  }
  const [lines, team, documents, activities, history] = await Promise.all([
    db.execute(sql`select * from crm_opportunity_lines where opportunity_id = ${id} and org_id = ${orgId} order by line_number`),
    db.execute(sql`
      select m.*, u.name as user_name, u.email as user_email
        from crm_opportunity_team_members m join users u on u.id = m.user_id
       where m.opportunity_id = ${id} and m.org_id = ${orgId} order by m.is_primary desc, u.name`),
    db.execute(sql`
      select d.id, d.kind, d.document_number, d.document_date, d.status, d.currency, d.total
        from crm_opportunity_documents od join documents d on d.id = od.document_id and d.org_id = od.org_id
       where od.opportunity_id = ${id} and od.org_id = ${orgId} and d.org_id = ${orgId}${subsidiaryVisibleFilter(sql`d.subsidiary_id`,allowed ?? null)}
       order by d.document_date desc, d.created_at desc`),
    db.execute(sql`
      select a.id, a.kind, a.status, a.subject, a.starts_at, a.due_at, a.completed_at
        from crm_activities a join crm_activity_links l on l.activity_id = a.id and l.org_id = a.org_id
       where l.subject_kind = 'opportunity' and l.subject_id = ${id} and l.org_id = ${orgId}${crmActivityScope(allowed)}
       order by coalesce(a.starts_at, a.due_at, a.created_at) desc`),
    db.execute(sql`
      select e.*, fs.name as from_status_name, ts.name as to_status_name, u.name as actor_name
        from crm_opportunity_stage_events e
        left join crm_opportunity_statuses fs on fs.id = e.from_status_id and fs.org_id = e.org_id
        join crm_opportunity_statuses ts on ts.id = e.to_status_id and ts.org_id = e.org_id
        left join users u on u.id = e.created_by
       where e.opportunity_id = ${id} and e.org_id = ${orgId} order by e.occurred_at desc`),
  ])
  const visibleDocuments = []
  for (const row of documents.rows) {
    if (await isDocKindEnabled(orgId, String((row as { kind?: unknown }).kind))) {
      visibleDocuments.push(row)
    }
  }
  return { opportunity: opportunity.rows[0], lines: lines.rows, team: team.rows, documents: visibleDocuments, activities: activities.rows, history: history.rows }
}

export async function loadActivity(id: string, orgId: string, allowed?: ReadonlySet<string> | null) {
  const activity = (await db.execute<Record<string, unknown>>(sql`
    select a.*, ${documentRevisionSql(sql`a.updated_at`)} as "__activityRevision",
           ou.name as owner_name, au.name as assigned_name
      from crm_activities a
      left join users ou on ou.id = a.owner_user_id
      left join users au on au.id = a.assigned_user_id
     where a.id = ${id} and a.org_id = ${orgId}${crmActivityScope(allowed)}`))
  if (!activity.rows[0]) return null
  // The revision token never leaves this module in raw form: updated_at
  // carries the exact persisted revision token every activity save must send
  // back as expectedUpdatedAt (same wire form as document revisions, and the
  // same rewrite loadCrmAccount performs for accounts).
  {
    const head = activity.rows[0]!
    const revision = head['__activityRevision']
    if (!isDocumentRevisionToken(revision)) {
      throw new Error('activity read did not return an exact persisted revision')
    }
    delete head['__activityRevision']
    head.updated_at = revision
  }
  const [links, participants] = await Promise.all([
    db.execute(sql`select * from crm_activity_links where activity_id = ${id} and org_id = ${orgId} order by created_at`),
    db.execute(sql`
      select p.*, u.name as user_name, c.name as contact_name
        from crm_activity_participants p
        left join users u on u.id = p.user_id
        left join contacts c on c.id = p.contact_id and c.org_id = p.org_id
       where p.activity_id = ${id} and p.org_id = ${orgId} order by p.created_at`),
  ])
  return { activity: activity.rows[0], links: links.rows, participants: participants.rows }
}

export interface ForecastScope {
  orgId: string
  periodStart: string
  periodEnd: string
  ownerUserId?: string | null
  salesTeamId?: string | null
  allowedSubsidiaryIds?: ReadonlySet<string> | null
}

export type ForecastRow = {
  currency: string
  pipeline_amount: string
  weighted_amount: string
  worst_case_amount: string
  most_likely_amount: string
  upside_amount: string
  closed_amount: string
}

/** Exact forecast rollup performed by PostgreSQL numeric arithmetic. */
export async function calculateForecast(scope: ForecastScope) {
  if (!isIsoCalendarDate(scope.periodStart) || !isIsoCalendarDate(scope.periodEnd) || scope.periodEnd < scope.periodStart) {
    throw new Error('invalid forecast period')
  }
  const ownerFilter = scope.ownerUserId ? sql`and o.owner_user_id = ${scope.ownerUserId}` : sql``
  /**
   * A team forecast is the set of opportunities assigned to that team. Keep
   * that boundary in one CTE so pipeline and closed-revenue rows cannot drift
   * into different populations. The CTE deliberately does not require an
   * opportunity to be active or in-period: historical invoices linked to an
   * opportunity remain attributable to its team.
   */
  const teamScopeFilter = scope.salesTeamId ? sql`and o.sales_team_id = ${scope.salesTeamId}` : sql``
  const teamScopedDocument = sql`
    exists (
      select 1
        from crm_opportunity_documents od
        join forecast_scope fo on fo.id = od.opportunity_id
      where od.org_id = ${scope.orgId}
         and od.document_id = d.id
    )`
  /**
   * Closed is a net-revenue basis, not a tax-inclusive takings total:
   * invoices contribute their subtotal (tax excluded) and posted customer
   * credits against the same revenue subtract theirs. A credit follows its
   * revenue — the invoice it settles (through a live application) or the
   * opportunity it is linked to — so an unrelated credit never reduces
   * another owner's or team's figure. The credit side of an application is
   * the from-side by engine convention, but either endpoint counts as
   * linkage: direction is a posting detail, attribution is not.
   * Declared before the team/owner filters that interpolate it: both build
   * their SQL eagerly whenever their scope key is set, so a later
   * declaration would throw a temporal-dead-zone ReferenceError on exactly
   * the scoped calls the filters exist for.
   */
  const creditAppliesToScopedInvoice = (invoiceScope: SQL) => sql`
    exists (
      select 1
        from applications a
        join journal_lines fl on fl.id = a.from_line_id and fl.org_id = a.org_id
        join journal_entries fe on fe.id = fl.entry_id and fe.org_id = a.org_id
        join journal_lines tl on tl.id = a.to_line_id and tl.org_id = a.org_id
        join journal_entries te on te.id = tl.entry_id and te.org_id = a.org_id
        join documents inv on inv.org_id = d.org_id
          and inv.kind = 'customer_invoice'
          and inv.id <> d.id
          and (inv.id = te.source_document_id or inv.id = fe.source_document_id)
      where a.org_id = d.org_id
        and a.unapplied_at is null
        and (fe.source_document_id = d.id or te.source_document_id = d.id)
        and ${invoiceScope}
    )`
  const teamActualsFilter = scope.salesTeamId ? sql`
    and (
      (d.kind = 'customer_invoice' and ${teamScopedDocument})
      or (d.kind = 'customer_credit' and (
        ${teamScopedDocument}
        or ${creditAppliesToScopedInvoice(sql`
          exists (
            select 1
              from crm_opportunity_documents od
              join forecast_scope fo on fo.id = od.opportunity_id
            where od.org_id = inv.org_id
               and od.document_id = inv.id
          )`)}
      ))
    )` : sql``
  const ownerActualsFilter = scope.ownerUserId ? sql`
    and (
      (d.kind = 'customer_invoice' and exists (
        select 1 from crm_account_profiles cp
         where cp.org_id = ${scope.orgId} and cp.party_id = d.party_id and cp.owner_user_id = ${scope.ownerUserId}
      )) or (d.kind = 'customer_credit' and (
        exists (
          select 1 from crm_account_profiles cp
           where cp.org_id = ${scope.orgId} and cp.party_id = d.party_id and cp.owner_user_id = ${scope.ownerUserId}
        ) or exists (
          select 1
            from crm_opportunity_documents od
            join crm_opportunities o on o.id = od.opportunity_id and o.org_id = od.org_id
           where od.org_id = ${scope.orgId}
             and od.document_id = d.id
             and o.owner_user_id = ${scope.ownerUserId}
        ) or ${creditAppliesToScopedInvoice(sql`exists (
          select 1 from crm_account_profiles cp
           where cp.org_id = inv.org_id and cp.party_id = inv.party_id and cp.owner_user_id = ${scope.ownerUserId}
        )`)}
      ))
    )` : sql``
  const rows = (await db.execute<ForecastRow>(sql`
    with forecast_scope as (
      select o.id
        from crm_opportunities o
       where o.org_id = ${scope.orgId}
         ${teamScopeFilter}
         ${crmOpportunityScope(scope.allowedSubsidiaryIds)}
    ), opportunity_base as (
      select o.currency, o.projected_amount, o.weighted_amount, o.forecast_category, s.is_closed, s.is_won
        from crm_opportunities o
        join forecast_scope fo on fo.id = o.id
        join crm_opportunity_statuses s on s.id = o.status_id and s.org_id = o.org_id
       where o.org_id = ${scope.orgId} and o.is_active
         and o.expected_close_date between ${scope.periodStart}::date and ${scope.periodEnd}::date
         ${ownerFilter}
    ), actuals as (
      select d.currency, coalesce(sum(case when d.kind = 'customer_invoice' then d.subtotal else -d.subtotal end), 0)::numeric(19,4) as closed_amount
        from documents d
       where d.org_id = ${scope.orgId} and d.kind in ('customer_invoice', 'customer_credit') and d.status = 'posted'
         ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, scope.allowedSubsidiaryIds == null ? null : new Set(scope.allowedSubsidiaryIds))}
         and d.document_date between ${scope.periodStart}::date and ${scope.periodEnd}::date
         ${ownerActualsFilter}
         ${teamActualsFilter}
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
  `))
  return rows.rows
}

/**
 * Open, forecast-eligible opportunities the rollup above cannot see: no
 * expected close date means no period membership, so they contribute $0
 * without a trace. The population mirrors `opportunity_base` exactly
 * (active, not closed, not omitted) plus the same owner/team/subsidiary
 * scope — the count names what the KPIs silently left out.
 */
export async function countUndatedForecastExcluded(scope: {
  orgId: string
  ownerUserId?: string | null
  salesTeamId?: string | null
  allowedSubsidiaryIds?: ReadonlySet<string> | null
}): Promise<number> {
  const ownerFilter = scope.ownerUserId ? sql`and o.owner_user_id = ${scope.ownerUserId}` : sql``
  const teamFilter = scope.salesTeamId ? sql`and o.sales_team_id = ${scope.salesTeamId}` : sql``
  const rows = await db.execute<{ count: string }>(sql`
    select count(*)::text as count
      from crm_opportunities o
      join crm_opportunity_statuses s on s.id = o.status_id and s.org_id = o.org_id
     where o.org_id = ${scope.orgId} and o.is_active
       and not s.is_closed and o.forecast_category <> 'omitted'
       and o.expected_close_date is null
       ${ownerFilter}
       ${teamFilter}${crmOpportunityScope(scope.allowedSubsidiaryIds)}
  `)
  return Number(rows.rows[0]?.count ?? 0)
}
