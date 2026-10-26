import { isIsoCalendarDate } from "../platform/iso-date.ts";
import type { PayrollCountryPack } from "./pack-types.ts";
import { taxYearFor } from "./tax-year-math.ts";
import { PayrollError } from "./error.ts";

/** Facts explicitly attested by the retained original statutory opening report. */
export type OpeningLevySourceFacts = {
  originalCountry: string;
  originalCurrency: string;
  coverageStart: string;
  coverageEnd: string;
  coverageComplete: true;
};

export function validateOpeningLevySourceFacts(
  facts: OpeningLevySourceFacts,
  taxYear: number,
  pack: Pick<PayrollCountryPack, "country" | "statutoryCurrency" | "taxYear"> | undefined,
): void {
  if (
    !pack ||
    pack.country !== facts.originalCountry ||
    facts.originalCurrency !== pack.statutoryCurrency
  ) {
    throw new PayrollError(
      "Record the original country and statutory currency from the Cabinet source in Payroll → Opening balances → Levy source",
    );
  }
  if (
    !isIsoCalendarDate(facts.coverageStart) ||
    !isIsoCalendarDate(facts.coverageEnd) ||
    facts.coverageStart.slice(5) !==
      `${String(pack.taxYear.startMonth).padStart(2, "0")}-${String(pack.taxYear.startDay).padStart(2, "0")}` ||
    facts.coverageEnd < facts.coverageStart ||
    taxYearFor(pack.taxYear, facts.coverageStart) !== taxYear ||
    taxYearFor(pack.taxYear, facts.coverageEnd) !== taxYear ||
    facts.coverageComplete !== true
  ) {
    throw new PayrollError(
      "The original report must explicitly confirm complete year-to-date statutory coverage from the declared statutory tax-year start through its stated end date; attach that complete report and record its coverage in Payroll → Opening balances → Levy source",
    );
  }
}
