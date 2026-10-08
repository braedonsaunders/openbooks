import 'server-only'
import { sql } from 'drizzle-orm'
import { subsidiaryVisibleFilter } from './subsidiaries'

/** Native credit commitment population shared by customer detail and
 * portfolio analytics. Amounts remain dated functional-currency flows. */
export function customerOrderCommitmentsSource(orgId: string, scope: ReadonlySet<string> | null, partyId?: string) {
  return sql`
    select d.party_id, d.document_date::text as date, sub.base_currency as func,
           round(d.total * d.fx_rate, 4)::text as amount
    from documents d
    left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
    where d.org_id = ${orgId} and d.kind = 'sales_order'
      and d.status in ('pending_approval', 'approved') and d.voided_at is null
      ${partyId ? sql`and d.party_id = ${partyId}` : sql``}
      ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, scope)}
  `
}
