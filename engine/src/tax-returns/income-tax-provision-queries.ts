import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

/** Fiscal years represented by the organization's accounting calendar. */
export async function listIncomeTaxProvisionFiscalYears(
  orgId: string,
): Promise<{ fiscal_year: number }[]> {
  return db.execute<{ fiscal_year: number }>(
    sql`select distinct fiscal_year from accounting_periods where org_id = ${orgId} order by fiscal_year desc`,
    "objects",
  );
}

/** Whether an organization owns the addressed income-tax provision run. */
export async function incomeTaxProvisionRunExists(orgId: string, runId: string): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(
    sql`select id from tax_provision_runs where org_id = ${orgId} and id = ${runId}`,
    "objects",
  );
  return rows.length > 0;
}

/** Active enacted income-tax rates available within the caller's entity grant. */
export async function listIncomeTaxProvisionRates(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<Record<string, unknown>[]> {
  const scope =
    allowedSubsidiaryIds === null
      ? sql``
      : allowedSubsidiaryIds.size === 0
        ? sql`and false`
        : sql`and (subsidiary_id is null or subsidiary_id = any(${`{${[...allowedSubsidiaryIds].join(",")}}`}::uuid[]))`;
  return db.execute<Record<string, unknown>>(
    sql`
      select jurisdiction, rate_percent as "ratePercent", effective_from::text as "effectiveFrom",
             effective_to::text as "effectiveTo", subsidiary_id as "subsidiaryId"
        from income_tax_rates where org_id = ${orgId} and is_active
        ${scope}
       order by effective_from desc
    `,
    "objects",
  );
}
