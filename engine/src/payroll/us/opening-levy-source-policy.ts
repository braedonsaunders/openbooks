import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { add, cmp, sum } from "../../money/money.ts";
import { PayrollError } from "../error.ts";
import type { PayrollCountryPack } from "../pack-types.ts";

type Policy = NonNullable<PayrollCountryPack["openingLevySource"]>;
const STATES = [
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "DC",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
];
/** Original EIN and state wage bases sealed for statutory carry-in. */
export const US_OPENING_LEVY_SOURCE: Policy = {
  programKeys: ["us_futa", "us_sui", "us_pa_lst"],
  validateScope(row) {
    if (
      !row.federalAccountId ||
      (row.programKey === "us_futa" && row.federalAccountId !== row.filingAccountId)
    )
      throw new PayrollError(
        "Record the original federal EIN for each US allocation; Canadian allocations have no EIN",
      );
    if (row.programKey === "us_futa")
      return row.region === "US" && !row.subRegion && row.filingAccountId !== null;
    if (row.programKey === "us_sui") return STATES.includes(row.region) && !row.subRegion;
    return (
      row.programKey === "us_pa_lst" &&
      row.region === "PA" &&
      /^[0-9]{6}$/.test(row.subRegion) &&
      row.filingAccountId === null
    );
  },
  validateRequired(rows) {
    if (rows.some((row) => !this.programKeys.includes(row.programKey)))
      throw new PayrollError("A US opening cannot contain Canadian levy allocations");
    if (!rows.some((row) => row.programKey === "us_futa"))
      throw new PayrollError(
        "Declare FUTA opening wages for each original EIN, including zero when the source confirms none",
      );
  },
  async validateOpening({ orgId, subsidiaryId, opening, allocations }) {
    const einRows = await db.execute<{ id: string; isActive: boolean }>(
      sql`
      select id,is_active as "isActive" from payroll_filing_accounts
       where org_id=${orgId} and country='US' and program_type='us_ein'
         and (subsidiary_id=${subsidiaryId} or subsidiary_id is null)
       order by id for share
    `,
      "objects",
    );
    const futa = allocations.filter((row) => row.programKey === "us_futa");
    if (allocations.some((row) => !einRows.some((ein) => ein.id === row.federalAccountId))) {
      throw new PayrollError(
        "Add or restore each original US EIN in Payroll Setup → Filing accounts, then bind every US opening allocation to its source-confirmed EIN",
      );
    }
    if (
      allocations.some((row) => !futa.some((base) => base.filingAccountId === row.federalAccountId))
    ) {
      throw new PayrollError(
        "Declare a FUTA opening for every original EIN named by a SUI or LST allocation, including explicit zeros",
      );
    }
    const accountBaseRows = await db.execute<{
      programKey: string;
      region: string | null;
      filingAccountId: string;
      amount: string;
    }>(
      sql`
      select program_key as "programKey",region,filing_account_id as "filingAccountId",insurable_ytd::text as amount
        from payroll_opening_account_bases where org_id=${orgId} and employee_party_id=${opening.employeePartyId}
         and tax_year=${opening.taxYear} and program_key in ('us_futa','us_sui')
    `,
      "objects",
    );
    const futaAccountBases = accountBaseRows.filter((row) => row.programKey === "us_futa");
    if (futaAccountBases.length) {
      if (cmp(opening.insurableYtd, "0") !== 0) {
        throw new PayrollError(
          "The employee-only insurable opening must be zero when EIN-specific FUTA openings are recorded",
        );
      }
      if (
        futaAccountBases.some(
          (stored) =>
            !futa.some(
              (row) =>
                row.filingAccountId === stored.filingAccountId &&
                cmp(row.amount, stored.amount) === 0,
            ),
        ) ||
        futa.some(
          (row) =>
            !futaAccountBases.some((stored) => stored.filingAccountId === row.filingAccountId) &&
            cmp(row.amount, "0") !== 0,
        )
      ) {
        throw new PayrollError(
          "FUTA source allocations must preserve every exact EIN-specific opening wage base already recorded",
        );
      }
    } else if (cmp(sum(futa.map((row) => row.amount)), opening.insurableYtd) !== 0) {
      throw new PayrollError(
        "The EIN-specific FUTA allocations must equal the original employee-only insurable wage opening",
      );
    }
    const stateRows = await db.execute<{ region: string; amount: string }>(
      sql`
      select sw.state as region,sw.insurable_ytd::text as amount from payroll_opening_sui_wages sw
        join payroll_opening_balances b on b.org_id=sw.org_id and b.id=sw.opening_balance_id
       where b.org_id=${orgId} and b.employee_party_id=${opening.employeePartyId} and b.tax_year=${opening.taxYear}
    `,
      "objects",
    );
    const suiAccountBases = accountBaseRows.filter((row) => row.programKey === "us_sui");
    const sui = allocations.filter((row) => row.programKey === "us_sui");
    const suiAccounts = await db.execute<{ id: string; stateCode: string; isActive: boolean }>(
      sql`
      select id,state_code as "stateCode",is_active as "isActive" from payroll_filing_accounts
       where org_id=${orgId} and country='US' and program_type='us_state_sui'
         and state_code is not null and (subsidiary_id=${subsidiaryId} or subsidiary_id is null)
       order by id for share
    `,
      "objects",
    );
    for (const row of sui) {
      if (
        row.filingAccountId !== null &&
        !suiAccounts.some(
          (account) => account.id === row.filingAccountId && account.stateCode === row.region,
        )
      ) {
        throw new PayrollError(
          "SUI source allocations must retain a state account for the same original state and legal employer",
        );
      }
    }
    for (const stored of suiAccountBases) {
      if (
        !sui.some(
          (row) => row.filingAccountId === stored.filingAccountId && row.region === stored.region,
        ) ||
        cmp(
          sum(
            sui
              .filter(
                (row) =>
                  row.filingAccountId === stored.filingAccountId && row.region === stored.region,
              )
              .map((row) => row.amount),
          ),
          stored.amount,
        ) !== 0
      ) {
        throw new PayrollError(
          `SUI source allocations must preserve the original ${stored.region ?? "state"} filing-account wage opening`,
        );
      }
    }
    const priorStates = new Map<string, string>();
    for (const row of [
      ...stateRows,
      ...suiAccountBases.map((base) => ({ region: base.region ?? "", amount: base.amount })),
    ]) {
      if (!row.region) continue;
      priorStates.set(row.region, add(priorStates.get(row.region) ?? "0", row.amount));
    }
    if (cmp(opening.insurableYtd, "0") > 0 && sui.length === 0) {
      throw new PayrollError(
        "Declare the original US SUI jurisdiction allocations for the generic insurable opening, including a state with zero only when the retained source confirms no SUI wages",
      );
    }
    for (const [state, amount] of priorStates) {
      if (
        cmp(sum(sui.filter((row) => row.region === state).map((row) => row.amount)), amount) !== 0
      ) {
        throw new PayrollError(
          `SUI source allocations must preserve the original ${state} state opening wages`,
        );
      }
    }
  },
};
