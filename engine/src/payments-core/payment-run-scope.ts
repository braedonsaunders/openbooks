import { sql, type SQL } from "drizzle-orm";

/**
 * The record boundary of a payment run for a caller restricted to a set of
 * legal entities. A run exposes its header and all retained source evidence,
 * including excluded items, so it is visible only when:
 *
 * - its header entity is unassigned or allowed;
 * - an unassigned header carries at least one item (an empty org-wide run has
 *   no provable owner, so restricted callers fail closed on it);
 * - every item's source document belongs to an allowed entity.
 *
 * `orgId` is the tenant id, or a SQL expression naming it (a correlated
 * column). `allowed === null` is an unrestricted caller. This is the one
 * definition: the run lists, drawers and API verbs, and the run's approval
 * subject in Flows all read it.
 */
export function paymentRunVisibleSql(
  orgId: string | SQL,
  allowed: ReadonlySet<string> | null,
  alias = "r",
): SQL {
  const col = (name: string) => sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
  const org = sql`${col("org_id")} = ${orgId}`;
  if (allowed === null) return org;
  if (allowed.size === 0) return sql`false`;
  const ids = `{${[...allowed].join(",")}}`;
  return sql`(${org}
    and (${col("subsidiary_id")} is null or ${col("subsidiary_id")} = any(${ids}::uuid[]))
    and (${col("subsidiary_id")} is not null or exists (
      select 1 from payment_run_items scope_item
       where scope_item.payment_run_id = ${col("id")} and scope_item.org_id = ${col("org_id")}
    ))
    and not exists (
      select 1 from payment_run_items scope_item
      left join documents scope_doc on scope_doc.id = scope_item.source_document_id and scope_doc.org_id = scope_item.org_id
      where scope_item.payment_run_id = ${col("id")} and scope_item.org_id = ${col("org_id")}
        and (scope_doc.subsidiary_id is null or not (scope_doc.subsidiary_id = any(${ids}::uuid[])))
    ))`;
}
