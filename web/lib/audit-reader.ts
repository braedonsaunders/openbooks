import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/database";
import type { AuditListRow } from "../app/(app)/admin/audit/AuditRows";
import type { AuditEvent } from "../app/(app)/admin/audit/AuditEventDrawer";
import { parseImportJson } from "./data-io/import-parse";
import { auditRecordLabels } from "./audit-record-labels";

export interface AuditFilters {
  action?: string;
  rtype?: string;
  actor?: string;
  from?: string;
  to?: string;
  q?: string;
  page: number;
  perPage: number;
}

interface AuditMetadata extends Record<string, unknown> {
  id: string;
  table_name: string;
  row_id: string;
  action: string;
  at: string;
  actor_name: string | null;
  rtype: string;
}

interface AuditListSource extends AuditMetadata {
  summary_kind: AuditListRow["summaryKind"];
  change_count: string;
}

interface AuditEventSource extends AuditMetadata {
  request_id: string | null;
  changes: string;
}

interface AuditFacet extends Record<string, unknown> {
  action: string | null;
  actor_id: string | null;
  actor_name: string | null;
  rtype: string | null;
  n: string;
  filtered_n: string;
  action_group: number;
  actor_group: number;
  rtype_group: number;
}

// Deleted documents retain their type in the immutable before snapshot.
const recordType = sql`case when a.table_name = 'documents'
  then coalesce(d.kind, a.changes #>> '{before,document,kind}', 'documents')
  else a.table_name end`;
const documentJoin = sql`left join documents d
  on a.table_name = 'documents' and d.id = a.row_id and d.org_id = a.org_id`;
// Facets scan the compact metadata index. Only a missing document needs its
// retained snapshot; fetching that by primary key avoids loading every event.
const facetRecordType = sql`case when a.table_name = 'documents'
  then coalesce(d.kind, (select snapshot.changes #>> '{before,document,kind}'
    from audit_log snapshot where snapshot.id = a.id and snapshot.org_id = a.org_id), 'documents')
  else a.table_name end`;

export async function readAuditEvent(orgId: string, eventId: string): Promise<AuditEvent | null> {
  const result = await db.execute<AuditEventSource>(
    sql`
    select a.id, a.table_name, a.row_id, a.action, a.at, a.request_id, a.changes::text as changes,
           u.name as actor_name, (${recordType}) as rtype
      from audit_log a
      ${documentJoin}
      left join users u on u.id = a.actor_id and u.org_id = a.org_id
     where a.org_id = ${orgId} and a.id = ${eventId}
     limit 1
  `,
    "objects",
  );
  const row = result[0];
  if (!row) return null;
  const labels = await auditRecordLabels(orgId, [{ table: row.table_name, rowId: row.row_id }]);
  return {
    id: row.id,
    rowId: row.row_id,
    action: row.action,
    at: new Date(row.at).toISOString(),
    actorName: row.actor_name,
    recordType: row.rtype,
    recordLabel: labels.get(`${row.table_name}:${row.row_id}`) ?? null,
    requestId: row.request_id,
    changes: parseImportJson(row.changes),
  };
}

export async function readAuditPage(orgId: string, filters: AuditFilters) {
  const { action, rtype, actor, from, to, q, page, perPage } = filters;
  const matches = (typeExpression = recordType) => sql`true
    ${action ? sql`and a.action = ${action}` : sql``}
    ${rtype ? sql`and (${typeExpression}) = ${rtype}` : sql``}
    ${actor ? (actor === "system" ? sql`and a.actor_id is null` : sql`and a.actor_id = ${actor}`) : sql``}
    ${from ? sql`and a.at >= ${from}::date::timestamptz` : sql``}
    ${to ? sql`and a.at < (${to}::date + interval '1 day')::timestamptz` : sql``}
    ${
      q
        ? sql`and ((${typeExpression}) ilike ${"%" + q + "%"}
      or replace((${typeExpression}), '_', ' ') ilike ${"%" + q + "%"}
      or a.action ilike ${"%" + q + "%"}
      or a.row_id::text = ${q}
      or (a.changes ->> 'reason') ilike ${"%" + q + "%"}
      or (a.changes #>> '{before,reason}') ilike ${"%" + q + "%"}
      or (a.changes #>> '{after,reason}') ilike ${"%" + q + "%"}
      or exists (select 1 from users searched_user
        where searched_user.org_id = ${orgId} and searched_user.id = a.actor_id
          and (searched_user.name ilike ${"%" + q + "%"} or searched_user.email ilike ${"%" + q + "%"})))`
        : sql``
    }`;

  const [list, facets] = await Promise.all([
    // Kind-filtered events may be far from the newest event. Resolve their
    // metadata before sorting so the page does not walk full snapshots in
    // timestamp order while looking for a rare kind.
    db.execute<AuditListSource>(
      sql`
      with candidates as ${rtype ? sql`materialized` : sql`not materialized`} (
        select a.id, a.at from audit_log a
        ${q || rtype ? documentJoin : sql``}
        where a.org_id = ${orgId} and ${matches(facetRecordType)}
      ), page_ids as materialized (
        select id, at from candidates
        order by at desc, id desc
        limit ${perPage} offset ${(page - 1) * perPage}
      )
      select a.id, a.table_name, a.row_id, a.action, a.at, u.name as actor_name, (${recordType}) as rtype,
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
    `,
      "objects",
    ),
    // Aggregate ordinary records before combining them with document kinds.
    // Only document events need the document join and retained-snapshot lookup.
    // Counts remain exact, including filtered totals and deleted documents.
    db.execute<AuditFacet>(
      sql`
      with metadata as (
        select a.action, a.actor_id, a.table_name as rtype,
          count(*) as n, count(*) filter (where ${matches(sql`a.table_name`)}) as filtered_n
        from audit_log a
        where a.org_id = ${orgId} and a.table_name <> 'documents'
        group by a.action, a.actor_id, a.table_name
        union all
        select a.action, a.actor_id, (${facetRecordType}) as rtype,
          count(*) as n, count(*) filter (where ${matches(facetRecordType)}) as filtered_n
        from audit_log a ${documentJoin}
        where a.org_id = ${orgId} and a.table_name = 'documents'
        group by a.action, a.actor_id, (${facetRecordType})
      ), facets as (
        select action, actor_id, rtype,
          coalesce(sum(n), 0) as n, coalesce(sum(filtered_n), 0) as filtered_n,
          grouping(action) as action_group,
          grouping(actor_id) as actor_group,
          grouping(rtype) as rtype_group
        from metadata
        group by grouping sets ((), (action), (actor_id), (rtype))
      )
      select f.*, u.name as actor_name from facets f
      left join users u on f.actor_group = 0 and u.id = f.actor_id and u.org_id = ${orgId}
    `,
      "objects",
    ),
  ]);
  const total = facets.find(
    (r) => r.action_group === 1 && r.actor_group === 1 && r.rtype_group === 1,
  );
  if (!total) throw new Error("The audit query did not return its total.");
  const byCount = (a: AuditFacet, b: AuditFacet) =>
    Number(b.n) - Number(a.n) ||
    String(a.action ?? a.rtype ?? a.actor_id ?? "").localeCompare(
      String(b.action ?? b.rtype ?? b.actor_id ?? ""),
    );
  const labels = await auditRecordLabels(
    orgId,
    list.map((row) => ({ table: row.table_name, rowId: row.row_id })),
  );
  return {
    rows: list.map((row): AuditListRow => ({
      id: row.id,
      rowId: row.row_id,
      at: new Date(row.at).toISOString(),
      actorName: row.actor_name,
      action: row.action,
      recordType: row.rtype,
      recordLabel: labels.get(`${row.table_name}:${row.row_id}`) ?? null,
      summaryKind: row.summary_kind,
      changeCount: Number(row.change_count),
    })),
    total: Number(total.filtered_n),
    actions: facets.filter((r) => r.action_group === 0).sort(byCount),
    recordTypes: facets
      .filter((r) => r.rtype_group === 0)
      .sort(byCount)
      .slice(0, 60),
    actors: facets
      .filter((r) => r.actor_group === 0)
      .sort(byCount)
      .slice(0, 50),
  };
}
