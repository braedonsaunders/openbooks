import { sql } from "drizzle-orm";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { db } from "../platform/db.ts";

export async function listTaxPoolRouteRows(input: {
  orgId: string;
  taxYear: number;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}) {
  return db.execute<Record<string, string>>(
    sql`
    select pp.tax_year, tp.class_code, tp.regime,
           pp.opening_balance::text, pp.additions::text, pp.dispositions::text,
           pp.allowance::text, pp.closing_balance::text, pp.recapture::text, pp.terminal_loss::text
      from tax_pool_periods pp
      join tax_depreciation_pools tp on tp.id = pp.pool_id and tp.org_id = pp.org_id
     where pp.org_id = ${input.orgId} and pp.tax_year = ${input.taxYear}
       ${subsidiaryVisibleFilter(sql`tp.subsidiary_id`, input.allowedSubsidiaryIds)}
     order by tp.class_code`,
    "objects",
  );
}

export async function findActiveTaxPoolBook(orgId: string, bookId: string) {
  const rows = await db.execute<{ id: string }>(
    sql`
      select id
        from accounting_books
       where id = ${bookId} and org_id = ${orgId} and is_active
       limit 1`,
    "objects",
  );
  return rows[0] ?? null;
}

export async function findTaxPoolSubsidiary(orgId: string, subsidiaryId: string) {
  const rows = await db.execute<{ id: string }>(
    sql`
      select id
        from subsidiaries
       where id = ${subsidiaryId} and org_id = ${orgId}
       limit 1`,
    "objects",
  );
  return rows[0] ?? null;
}
