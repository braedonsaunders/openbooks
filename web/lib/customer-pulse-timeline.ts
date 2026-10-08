import 'server-only'

import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { normalizeMoney } from '@openbooks/engine/money'
import { crmActivityScope, crmSharedScope } from './crm-scope'
import { subsidiaryVisibleFilter } from './subsidiaries'
import type { CustomerPulseSections } from './customer-pulse-sections'
import { customerPulseTimelineParams, type CustomerPulseTimelineItem, type CustomerPulseTimelinePage } from './customer-pulse-timeline-params'

/** One permission-filtered timeline, counted and paged in the same snapshot.
 * Filtering precedes paging; independent source caps never truncate history. */
export async function loadCustomerPulseTimeline(
  partyId: string,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null | undefined,
  sections: CustomerPulseSections | undefined,
  search: Record<string, string | string[] | undefined> = {},
): Promise<CustomerPulseTimelinePage | null> {
  if (!sections || (!sections.ar && !sections.crm && !sections.projects)) return null
  const params = customerPulseTimelineParams(search)
  const party = await db.execute<{ id: string }>(sql`
    select p.id from parties p where p.org_id = ${orgId} and p.id = ${partyId}
    ${crmSharedScope(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
  `)
  if (!party.rows.length) return null
  if (!sections.ar && !sections.crm) return { ...params, rows: [], total: 0 }

  const sources: SQL[] = []
  if (sections.crm) sources.push(sql`
    select a.id, 'activity'::text as type, a.subject as title, a.body as description,
           null::text as amount, null::text as currency,
           coalesce(a.starts_at, a.due_at, a.created_at) as timestamp,
           a.created_at as created_at, a.status::text as status, null::text as reference
      from crm_activities a
     where a.org_id = ${orgId} and not a.is_private
       and exists (select 1 from crm_activity_links l
         where l.org_id = a.org_id and l.activity_id = a.id
           and l.subject_kind = 'account' and l.subject_id = ${partyId})
       ${crmActivityScope(allowedSubsidiaryIds)}
  `)
  if (sections.ar) sources.push(sql`
    select d.id,
           case d.kind when 'quote' then 'estimate' when 'sales_order' then 'sales_order'
             when 'customer_payment' then 'payment' else 'invoice' end as type,
           d.document_number || ' (' || replace(d.kind, '_', ' ') || ')' as title,
           d.memo as description, d.total::text as amount, d.currency::text as currency,
           d.document_date::timestamp at time zone 'UTC' as timestamp,
           d.created_at as created_at, d.status::text as status, d.document_number as reference
      from documents d
     where d.org_id = ${orgId} and d.party_id = ${partyId}
       and d.kind in ('quote', 'sales_order', 'customer_invoice', 'customer_payment')
       ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds ?? null)}
  `)
  const direction = params.dir === 'asc' ? sql`asc` : sql`desc`
  const result = await db.execute<{ total: string; rows: CustomerPulseTimelineItem[] }>(sql`
    with timeline as not materialized (${sql.join(sources, sql` union all `)}),
    matching as not materialized (
      select * from timeline
      ${params.q ? sql`where title ilike ${`%${params.q}%`} or coalesce(description, '') ilike ${`%${params.q}%`}
        or coalesce(reference, '') ilike ${`%${params.q}%`} or coalesce(status, '') ilike ${`%${params.q}%`}` : sql``}
    ), total as (select count(*)::text as count from matching),
    page_rows as (
      select * from matching order by timestamp ${direction}, created_at ${direction}, type asc, id asc
      limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    )
    select total.count as total,
           coalesce(jsonb_agg(jsonb_build_object(
             'id', p.id, 'type', p.type, 'title', p.title, 'description', p.description,
             'amount', p.amount, 'currency', p.currency, 'timestamp', p.timestamp::text,
             'status', p.status, 'reference', p.reference
           ) order by p.timestamp ${direction}, p.created_at ${direction}, p.type asc, p.id asc)
             filter (where p.id is not null), '[]'::jsonb) as rows
      from total left join page_rows p on true group by total.count
  `)
  const row = result.rows[0]
  if (!row) throw new Error('Customer interaction history could not be read.')
  const total = Number(row.total)
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Customer interaction history count is invalid.')
  return { ...params, total, rows: row.rows.map((item) => ({
    id: item.id, type: item.type, title: item.title, description: item.description,
    timestamp: item.timestamp,
    ...(item.amount != null ? { amount: normalizeMoney(item.amount) } : {}),
    ...(item.currency != null ? { currency: item.currency } : {}),
    ...(item.status != null ? { status: item.status } : {}),
    ...(item.reference != null ? { reference: item.reference } : {}),
  })) }
}
