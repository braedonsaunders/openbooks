import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import type { AuditListRow } from '../app/(app)/admin/audit/AuditRows'
import type { AuditEvent } from '../app/(app)/admin/audit/AuditEventDrawer'
import { parseImportJson } from './data-io/import-parse'

export interface AuditFilters {
  action?: string
  rtype?: string
  actor?: string
  from?: string
  to?: string
  q?: string
  page: number
  perPage: number
}

interface AuditMetadata extends Record<string, unknown> {
  id: string
  row_id: string
  action: string
  at: string
  actor_name: string | null
  rtype: string
}

interface AuditListSource extends AuditMetadata {
  summary_kind: AuditListRow['summaryKind']
  change_count: string
}

interface AuditEventSource extends AuditMetadata {
  request_id: string | null
  changes: string
}

interface AuditFacet extends Record<string, unknown> {
  action: string | null
  actor_id: string | null
  actor_name: string | null
  rtype: string | null
  n: string
  filtered_n: string
  action_group: number
  actor_group: number
  rtype_group: number
}

// Deleted documents retain their type in the immutable before snapshot.
const recordType = sql`case when a.table_name = 'documents'
  then coalesce(d.kind, a.changes #>> '{before,document,kind}', 'documents')
  else a.table_name end`
const documentJoin = sql`left join documents d
  on a.table_name = 'documents' and d.id = a.row_id and d.org_id = a.org_id`
// Facets scan the compact metadata index. Only a missing document needs its
// retained snapshot; fetching that by primary key avoids loading every event.
const facetRecordType = sql`case when a.table_name = 'documents'
  then coalesce(d.kind, (select snapshot.changes #>> '{before,document,kind}'
    from audit_log snapshot where snapshot.id = a.id and snapshot.org_id = a.org_id), 'documents')
  else a.table_name end`

export async function readAuditEvent(orgId: string, eventId: string): Promise<AuditEvent | null> {
  const result = await db.execute<AuditEventSource>(sql`
    select a.id, a.row_id, a.action, a.at, a.request_id, a.changes::text as changes,
           u.name as actor_name, (${recordType}) as rtype
      from audit_log a
      ${documentJoin}
      left join users u on u.id = a.actor_id and u.org_id = a.org_id
     where a.org_id = ${orgId} and a.id = ${eventId}
     limit 1
  `)
  const row = result.rows[0]
  return row ? {
    id: row.id, rowId: row.row_id, action: row.action,
    at: new Date(row.at).toISOString(), actorName: row.actor_name,
    recordType: row.rtype, requestId: row.request_id,
    changes: parseImportJson(row.changes),
  } : null
}

export async function readAuditPage(orgId: string, filters: AuditFilters) {
  const { action, rtype, actor, from, to, q, page, perPage } = filters
  const matches = (typeExpression = recordType) => sql`true
    ${action ? sql`and a.action = ${action}` : sql``}
    ${rtype ? sql`and (${typeExpression}) = ${rtype}` : sql``}
    ${actor ? (actor === 'system' ? sql`and a.actor_id is null` : sql`and a.actor_id = ${actor}`) : sql``}
    ${from ? sql`and a.at >= ${from}::date` : sql``}
    ${to ? sql`and a.at < (${to}::date + interval '1 day')` : sql``}
    ${q ? sql`and ((${typeExpression}) ilike ${'%' + q + '%'} or a.row_id::text = ${q}
      or exists (select 1 from users searched_user
        where searched_user.org_id = ${orgId} and searched_user.id = a.actor_id
          and searched_user.name ilike ${'%' + q + '%'}))` : sql``}`

  const [list, facets] = await Promise.all([
    db.execute<AuditListSource>(sql`
      with page_ids as materialized (
        select a.id, a.at from audit_log a
        ${q || rtype ? documentJoin : sql``}
        where a.org_id = ${orgId} and ${matches()}
        order by a.at desc, a.id desc
        limit ${perPage} offset ${(page - 1) * perPage}
      )
      select a.id, a.row_id, a.action, a.at, u.name as actor_name, (${recordType}) as rtype,
        case when a.changes ? 'before' or a.changes ? 'after' then 'snapshot'
             when a.changes ->> 'source' = 'record_metadata' then 'metadata'
             else 'fields' end as summary_kind,
        (select count(*) from jsonb_object_keys(
          case when jsonb_typeof(a.changes) = 'object' then a.changes else '{}'::jsonb end
        ) changed_key(key) where key not in ('source', 'mode', 'reason', 'before', 'after')) as change_count
      from page_ids selected
      join audit_log a on a.id = selected.id and a.org_id = ${orgId}
      ${documentJoin}
      left join users u on u.id = a.actor_id and u.org_id = a.org_id
      order by selected.at desc, selected.id desc
    `),
    // One pass computes all exact facets and the filtered total. Only the
    // grouped actor ids are joined to users; full snapshots never leave SQL.
    db.execute<AuditFacet>(sql`
      with facets as (
        select a.action, a.actor_id, (${facetRecordType}) as rtype,
          count(*) as n, count(*) filter (where ${matches(facetRecordType)}) as filtered_n,
          grouping(a.action) as action_group,
          grouping(a.actor_id) as actor_group,
          grouping(${facetRecordType}) as rtype_group
        from audit_log a ${documentJoin}
        where a.org_id = ${orgId}
        group by grouping sets ((), (a.action), (a.actor_id), (${facetRecordType}))
      )
      select f.*, u.name as actor_name from facets f
      left join users u on f.actor_group = 0 and u.id = f.actor_id and u.org_id = ${orgId}
    `),
  ])
  const total = facets.rows.find((r) => r.action_group === 1 && r.actor_group === 1 && r.rtype_group === 1)
  if (!total) throw new Error('The audit query did not return its total.')
  const byCount = (a: AuditFacet, b: AuditFacet) => Number(b.n) - Number(a.n)
    || String(a.action ?? a.rtype ?? a.actor_id ?? '').localeCompare(String(b.action ?? b.rtype ?? b.actor_id ?? ''))
  return {
    rows: list.rows.map((row): AuditListRow => ({
      id: row.id, rowId: row.row_id, at: new Date(row.at).toISOString(),
      actorName: row.actor_name, action: row.action, recordType: row.rtype,
      summaryKind: row.summary_kind, changeCount: Number(row.change_count),
    })),
    total: Number(total.filtered_n),
    actions: facets.rows.filter((r) => r.action_group === 0).sort(byCount),
    recordTypes: facets.rows.filter((r) => r.rtype_group === 0).sort(byCount).slice(0, 60),
    actors: facets.rows.filter((r) => r.actor_group === 0).sort(byCount).slice(0, 50),
  }
}
