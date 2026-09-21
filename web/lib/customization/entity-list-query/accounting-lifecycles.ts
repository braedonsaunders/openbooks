import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";
import { subsidiaryVisibleFilter } from "../../subsidiaries";

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
    if (
      filter.key === "status" &&
      (filter.operator === "eq" || filter.operator === "ne")
    ) {
      parts.push(
        filter.operator === "eq"
          ? sql`and ${a}.status=${String(filter.value)}`
          : sql`and ${a}.status<>${String(filter.value)}`,
      );
    } else parts.push(sql`and false`);
  }
  if (adhoc.filters?.status)
    parts.push(sql`and ${a}.status=${adhoc.filters.status}`);
  if (adhoc.q) {
    const q = `%${adhoc.q}%`;
    parts.push(
      alias === "la"
        ? sql`and (la.lease_number ilike ${q} or la.description ilike ${q})`
        : sql`and (fc.reason ilike ${q} or fc.operation ilike ${q} or fc.domain ilike ${q})`,
    );
  }
  return sql.join(parts, sql` `);
}
