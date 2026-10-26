import { sql } from "drizzle-orm";
import { subsidiaryVisibleFilter } from "../../organization/subsidiary-scope.ts";
import type { SqlExecutor } from "../../platform/db.ts";

export interface StripeBillingCustomerChoice {
  id: string;
  name: string;
  email: string | null;
}

/** List active billing customers visible to the caller's legal entities. */
export async function listStripeBillingCustomers(
  db: SqlExecutor,
  input: {
    orgId: string;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
  },
): Promise<StripeBillingCustomerChoice[]> {
  const scope =
    input.allowedSubsidiaryIds === null
      ? sql``
      : input.allowedSubsidiaryIds.size > 0
        ? subsidiaryVisibleFilter(sql`p.subsidiary_id`, input.allowedSubsidiaryIds, {
            orgWideNull: true,
          })
        : sql`and false`;
  return db.execute<StripeBillingCustomerChoice>(
    sql`
      select p.id, coalesce(nullif(p.display_name, ''), p.email, p.id) as name, p.email as email
        from parties p
       where p.org_id = ${input.orgId} and p.is_active
         and exists (select 1 from customer_roles cr
           where cr.org_id = p.org_id and cr.party_id = p.id and cr.is_active)
         ${scope}
       order by name limit 500`,
    "objects",
  );
}
