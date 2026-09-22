import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";
import { subsidiaryVisibleFilter } from "../../subsidiaries";

const AWAITING_STATUSES = ["draft", "pending", "approved"] as const;

/** Subject caption for a financial_changes row: lease / asset / contract / ownership. */
export function financialChangeSubjectExpr(alias: "fc"): SQL {
  const a = sql.identifier(alias);
  return sql`coalesce(
    (select nullif(concat_ws(' — ', la.lease_number, nullif(btrim(la.description), '')), '')
       from lease_agreements la
      where la.org_id = ${a}.org_id and la.id = ${a}.subject_id),
    (select fa.asset_number || ' — ' || fa.name
       from fixed_assets fa
      where fa.org_id = ${a}.org_id and fa.id = ${a}.subject_id),
    (select nullif(concat_ws(' — ', rc.contract_number, nullif(btrim(rc.memo), '')), '')
       from revenue_contracts rc
      where rc.org_id = ${a}.org_id and rc.id = ${a}.subject_id),
    (select child.name
       from subsidiary_ownership_interests soi
       join subsidiaries child on child.id = soi.subsidiary_id and child.org_id = soi.org_id
      where soi.org_id = ${a}.org_id and soi.id = ${a}.subject_id),
    ${a}.subject_id::text
  )`;
}

function equality(aliasCol: SQL, operator: string, value: unknown): SQL | null {
  if (operator === "eq") return sql`and ${aliasCol}=${String(value)}`;
  if (operator === "ne") return sql`and ${aliasCol}<>${String(value)}`;
  if ((operator === "in" || operator === "not_in") && Array.isArray(value) && value.length) {
    const list = sql.join(
      value.filter((item): item is string => typeof item === "string").map((item) => sql`${item}`),
      sql`, `,
    );
    return operator === "in"
      ? sql`and ${aliasCol} in (${list})`
      : sql`and ${aliasCol} not in (${list})`;
  }
  return null;
}

function queuePredicate(aliasCol: SQL, value: string): SQL | null {
  if (value === "awaiting") {
    const list = sql.join(
      AWAITING_STATUSES.map((status) => sql`${status}`),
      sql`, `,
    );
    return sql`and ${aliasCol} in (${list})`;
  }
  if (value === "applied") return sql`and ${aliasCol}='applied'`;
  return null;
}

/** The universal entity list owns sorting/paging/views; these supply only
 * tenant-scoped predicates. Unknown saved filters fail closed. */
export function lifecycleWhere(
  alias: "la" | "fc",
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowed?: Set<string> | null,
): SQL {
  const a = sql.identifier(alias);
  const parts = [
    sql`${a}.org_id=${orgId}`,
    subsidiaryVisibleFilter(
      sql`${a}.subsidiary_id`,
      allowed === undefined ? new Set<string>() : allowed,
    ),
  ];
  for (const filter of view.filters) {
    if (filter.key === "status") {
      const pred = equality(sql`${a}.status`, filter.operator, filter.value);
      if (pred) parts.push(pred);
      else parts.push(sql`and false`);
    } else if (alias === "fc" && filter.key === "queue" && filter.operator === "eq") {
      const pred = queuePredicate(sql`${a}.status`, String(filter.value));
      parts.push(pred ?? sql`and false`);
    } else if (alias === "fc" && filter.key === "domain") {
      const pred = equality(sql`${a}.domain`, filter.operator, filter.value);
      parts.push(pred ?? sql`and false`);
    } else if (alias === "fc" && filter.key === "operation") {
      const pred = equality(sql`${a}.operation`, filter.operator, filter.value);
      parts.push(pred ?? sql`and false`);
    } else parts.push(sql`and false`);
  }
  if (adhoc.filters?.status)
    parts.push(sql`and ${a}.status=${adhoc.filters.status}`);
  if (alias === "fc" && adhoc.filters?.queue) {
    const pred = queuePredicate(sql`${a}.status`, adhoc.filters.queue);
    parts.push(pred ?? sql`and false`);
  }
  if (alias === "fc" && adhoc.filters?.domain)
    parts.push(sql`and ${a}.domain=${adhoc.filters.domain}`);
  if (alias === "fc" && adhoc.filters?.operation)
    parts.push(sql`and ${a}.operation=${adhoc.filters.operation}`);
  if (adhoc.q) {
    const q = `%${adhoc.q}%`;
    parts.push(
      alias === "la"
        ? sql`and (la.lease_number ilike ${q} or la.description ilike ${q})`
        : sql`and (
          fc.reason ilike ${q}
          or fc.operation ilike ${q}
          or fc.domain ilike ${q}
          or exists (
            select 1 from lease_agreements la
             where la.org_id=fc.org_id and la.id=fc.subject_id
               and (la.lease_number ilike ${q} or la.description ilike ${q})
          )
          or exists (
            select 1 from fixed_assets fa
             where fa.org_id=fc.org_id and fa.id=fc.subject_id
               and (fa.asset_number ilike ${q} or fa.name ilike ${q})
          )
          or exists (
            select 1 from revenue_contracts rc
             where rc.org_id=fc.org_id and rc.id=fc.subject_id
               and (rc.contract_number ilike ${q} or coalesce(rc.memo,'') ilike ${q})
          )
          or exists (
            select 1 from subsidiaries s
             where s.org_id=fc.org_id and s.id=fc.subsidiary_id
               and s.name ilike ${q}
          )
        )`,
    );
  }
  return sql.join(parts, sql` `);
}
