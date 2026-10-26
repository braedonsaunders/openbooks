import { sql } from "drizzle-orm";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { db } from "../platform/db.ts";

export async function getReconciliationRouteRow(orgId: string, reconciliationId: string) {
  const rows = await db.execute<Record<string, unknown>>(
    sql`
      select r.id, r.account_id, r.through_date, r.statement_balance, r.status,
             r.signed_off_by, r.signed_off_at, r.created_at,
             a.number as account_number, a.name as account_name,
             a.subsidiary_id as account_subsidiary_id
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.id = ${reconciliationId} and r.org_id = ${orgId}
    `,
    "objects",
  );
  return rows[0] ?? null;
}

export async function listReconciliationRouteRows(input: {
  orgId: string;
  accountId: string | null;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}) {
  return db.execute(
    sql`
        select r.id, r.account_id, r.through_date, r.statement_balance, r.status,
               r.signed_off_at, r.created_at,
               a.number as account_number, a.name as account_name
          from reconciliations r
          join accounts a on a.id = r.account_id and a.org_id = r.org_id
         where r.org_id = ${input.orgId}
           ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, input.allowedSubsidiaryIds)}
           ${input.accountId ? sql` and r.account_id = ${input.accountId}` : sql``}
         order by r.created_at desc
         limit 200
      `,
    "objects",
  );
}
