import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../../platform/db.ts";
import type { CanadianOpeningReportingCatalogue } from "./opening-reporting-source.ts";

/** Resolve native opening declarations and tenant identities; never infer ownership from a profile. */
export async function readCanadianOpeningReportingCatalogue(
  tx: SqlExecutor,
  orgId: string,
): Promise<CanadianOpeningReportingCatalogue> {
  const { OPENING_BALANCE_FIELDS, declaredProgramBaseFields, declaredAccountOpeningBaseFields } =
    await import("../opening-balances.ts");
  const programs = [
    ...(await declaredProgramBaseFields()),
    ...(await declaredAccountOpeningBaseFields()),
  ];
  const uniquePrograms = new Map(
    programs.map((program) => [
      program.programKey,
      {
        programKey: program.programKey,
        country: program.country,
        ...(program.country === "CA" && program.programKey === "qpip" ? { provinces: ["QC"] } : {}),
      },
    ]),
  );
  const components = await tx.execute<{ id: string; country: string | null }>(
    sql`
    select id,country from pay_components where org_id=${orgId} order by id for share
  `,
    "objects",
  );
  const filingAccounts = await tx.execute<
    CanadianOpeningReportingCatalogue["filingAccounts"][number]
  >(
    sql`
    select id,org_id as "orgId",subsidiary_id as "subsidiaryId",country,program_type as "programType",name,account_number as "accountNumber"
      from payroll_filing_accounts where org_id=${orgId} order by id for share
  `,
    "objects",
  );
  return {
    annualFields: OPENING_BALANCE_FIELDS,
    components,
    programs: [...uniquePrograms.values()],
    filingAccounts,
  };
}
