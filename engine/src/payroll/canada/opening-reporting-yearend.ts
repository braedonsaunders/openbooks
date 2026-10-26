import { readEmployeeOpeningLevySources } from "../opening-levy-source-reader.ts";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../../platform/db.ts";
import { cmp, normalizeMoney } from "../../money/money.ts";
import { PayrollError } from "../error.ts";
import type { OpeningYearEndYtd } from "../yearend.ts";
import { readEmployeeCanadianOpeningReportingSource } from "./opening-reporting-reader.ts";
import type { CanadianOpeningReportingAllocation } from "./opening-reporting-source.ts";

export type CanadianOpeningYearEndSlice = {
  employeePartyId: string;
  employeeName: string;
  coverageEnd: string;
  subsidiaryId: string;
  allocation: CanadianOpeningReportingAllocation;
  ytd: OpeningYearEndYtd;
};

/** Interpret only source-qualified native fields; required values cannot become missing-as-zero. */
export function canadianOpeningAllocationYtd(
  allocation: CanadianOpeningReportingAllocation,
): OpeningYearEndYtd {
  const read = (column: string): string => {
    const amount = allocation.annualAmounts[column];
    if (typeof amount !== "string")
      throw new PayrollError(
        `The original reporting allocation has no exact ${column} — reload Reporting source`,
      );
    return normalizeMoney(amount);
  };
  return {
    pensionableYtd: read("pensionable_ytd"),
    insurableYtd: read("insurable_ytd"),
    cppYtd: read("cpp_ytd"),
    cpp2Ytd: read("cpp2_ytd"),
    eiYtd: read("ei_ytd"),
    qpipYtd: read("qpip_ytd"),
    taxableYtd: read("taxable_ytd"),
    taxYtd: read("tax_ytd"),
    qcTaxYtd: read("qc_tax_ytd"),
    ficaWithheldYtd: read("fica_withheld_ytd"),
    employerCppYtd: read("employer_cpp_ytd"),
    employerCpp2Ytd: read("employer_cpp2_ytd"),
    employerEiYtd: read("employer_ei_ytd"),
    unionDuesYtd: read("union_dues_ytd"),
    programBasesYtd: Object.fromEntries(
      allocation.children.programBases.map((row) => [row.program_key, row.insurable_ytd]),
    ),
  };
}

export async function readCanadianOpeningYearEndSlices(
  tx: SqlExecutor,
  orgId: string,
  taxYear: number,
): Promise<CanadianOpeningYearEndSlice[]> {
  const employees = await tx.execute<{ id: string; name: string }>(
    sql`
    select b.employee_party_id as id,p.display_name as name from payroll_opening_balances b
    join parties p on p.org_id=b.org_id and p.id=b.employee_party_id
    where b.org_id=${orgId} and b.tax_year=${taxYear} order by b.employee_party_id
  `,
    "objects",
  );
  const slices: CanadianOpeningYearEndSlice[] = [];
  for (const employee of employees) {
    const original = await readEmployeeOpeningLevySources(tx, {
      orgId,
      employeePartyId: employee.id,
      taxYear,
    });
    if (original.facts?.originalCountry !== "CA" || !original.openingSnapshot) continue;
    const reportColumns = [
      "pensionable_ytd",
      "insurable_ytd",
      "cpp_ytd",
      "cpp2_ytd",
      "ei_ytd",
      "qpip_ytd",
      "taxable_ytd",
      "tax_ytd",
      "qc_tax_ytd",
      "employer_cpp_ytd",
      "employer_cpp2_ytd",
      "employer_ei_ytd",
      "union_dues_ytd",
    ];
    const reportable =
      reportColumns.some((column) => {
        const value = original.openingSnapshot![column];
        if (typeof value !== "string")
          throw new PayrollError(
            "The original reporting amounts are unavailable as exact native decimals",
          );
        return cmp(value, "0") !== 0;
      }) ||
      original.openingChildren!.programBases.some(
        (row) => row.program_key === "qpip" && cmp(row.insurable_ytd, "0") !== 0,
      );
    if (!reportable) continue;
    const source = await readEmployeeCanadianOpeningReportingSource(tx, {
      orgId,
      employeePartyId: employee.id,
      taxYear,
    });
    if (!source.authority) continue;
    for (const allocation of source.allocations)
      slices.push({
        employeePartyId: employee.id,
        employeeName: employee.name,
        coverageEnd: source.authority.coverageEnd,
        subsidiaryId: source.authority.subsidiaryId,
        allocation,
        ytd: canadianOpeningAllocationYtd(allocation),
      });
  }
  return slices;
}
