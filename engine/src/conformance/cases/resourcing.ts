import { priceHoursDrawdown } from "../../resourcing/retainers.ts";
import type { ConformanceCase } from "../types.ts";

/** Professional-services usage drawdowns — ASC 606 / IFRS 15. */
export const RESOURCING_CASES: readonly ConformanceCase[] = [
  {
    id: "res-drawdown-allocation",
    title: "A weekly hours drawdown preserves cents across calendar months",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-55-18",
        kind: "requirement",
        requirement:
          "When an invoicing right directly tracks the value transferred to date, revenue may be recognized for the amount the entity has a right to invoice.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.B16",
        kind: "requirement",
        requirement:
          "The same practical expedient applies when the invoice amount directly corresponds to value transferred so far.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Billable work is priced at its invoiceable amount, allocated to the cent, and assigned to the calendar month in which the work occurred.",
    facts: [
      "Three approved billable entries in the Sunday week from May 31 through June 6, 2026, carry 2.5000, 3.2500, and 1.3333 hours at a unit rate of 137.50.",
      "Their exact products rounded once to four decimals are 343.7500, 446.8750, and 183.3288, totaling 973.9538; the cent-rounded total is 973.95.",
      "Largest-remainder allocation assigns 343.75, 446.87, and 183.33, which sum to 973.95; May receives 343.75 and June receives 630.20 by worked date.",
    ],
    expected: {
      values: {
        mayEntry: "343.7500",
        juneEntryOne: "446.8700",
        juneEntryTwo: "183.3300",
        may: "343.7500",
        june: "630.2000",
        total: "973.9500",
        hours: "7.0833",
      },
    },
    run: () => {
      const priced = priceHoursDrawdown([
        { id: "may-entry", workedOn: "2026-05-31", hours: "2.5000" },
        { id: "june-entry-one", workedOn: "2026-06-01", hours: "3.2500" },
        { id: "june-entry-two", workedOn: "2026-06-02", hours: "1.3333" },
      ], "137.50");
      return {
        values: {
          mayEntry: priced.byEntry[0]!.amount,
          juneEntryOne: priced.byEntry[1]!.amount,
          juneEntryTwo: priced.byEntry[2]!.amount,
          may: priced.byMonth["2026-05"]!,
          june: priced.byMonth["2026-06"]!,
          total: priced.total,
          hours: priced.hours,
        },
      };
    },
  },
];
