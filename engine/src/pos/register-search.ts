import { sql } from "drizzle-orm";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import type { SqlExecutor } from "../platform/db.ts";

const UNSELLABLE_ITEM_KINDS = ["gift_card", "discount", "absence", "labor"] as const;

export interface PosItemSearchResult {
  id: string;
  code: string | null;
  name: string;
  kind: string;
  unit: string | null;
  exact: boolean;
}

export interface PosCustomerSearchResult {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

/** Search active, sellable items in the organization for the register. */
export async function searchPosItems(
  db: SqlExecutor,
  orgId: string,
  query: string,
): Promise<PosItemSearchResult[]> {
  const q = query.trim().slice(0, 80);
  if (q === "") return [];
  const pattern = `%${q.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  return db.execute<PosItemSearchResult>(
    sql`
      select id, code, name, kind, unit, (lower(code) = lower(${q})) as exact
        from items
       where org_id = ${orgId} and is_active
         and kind <> all(${sql.param([...UNSELLABLE_ITEM_KINDS])}::text[])
         and (lower(code) = lower(${q}) or code ilike ${pattern} or name ilike ${pattern})
       order by (lower(code) = lower(${q})) desc, (code ilike ${`${q.replace(/[\\%_]/g, (character) => `\\${character}`)}%`}) desc, name
       limit 24`,
    "objects",
  );
}

/** Search active customer parties visible to the caller's legal entities. */
export async function searchPosCustomers(
  db: SqlExecutor,
  orgId: string,
  query: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<PosCustomerSearchResult[]> {
  const q = query.trim().slice(0, 80);
  if (q.length < 2) return [];
  const pattern = `%${q.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  return db.execute<PosCustomerSearchResult>(
    sql`
      select p.id, p.display_name as name, p.email, p.phone
        from parties p
        join customer_roles c on c.org_id = p.org_id and c.party_id = p.id and c.is_active
       where p.org_id = ${orgId} and p.is_active
         and (p.display_name ilike ${pattern} or p.email ilike ${pattern} or p.phone ilike ${pattern})
         ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
       order by p.display_name
       limit 20`,
    "objects",
  );
}
