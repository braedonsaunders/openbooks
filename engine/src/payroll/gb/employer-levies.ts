import type { PayrollEmployerAggregateLevy } from "../packs.ts";
import { gbTablesForTaxYear } from "./year-tables.ts";

/**
 * The GB pack's employer-aggregate levies: the Apprenticeship Levy.
 *
 * HMRC "Pay Apprenticeship Levy" (https://www.gov.uk/guidance/pay-apprenticeship-levy):
 * employers with an annual pay bill over £3 million — total earnings subject
 * to Class 1 secondary NICs, connected employers counted together — pay 0.5%
 * of the pay bill less a £15,000 annual allowance shared across the connected
 * companies, calculated month by month with 1/12 of the allowance accruing
 * each tax month and reported on the Employer Payment Summary. Allowance
 * allocation: Apprenticeship Levy Manual ALM06000
 * (https://www.gov.uk/hmrc-internal-manuals/apprenticeship-levy/alm06000).
 *
 * The stub base is NIC-able earnings less the period secondary threshold
 * (the same subtraction `calculateGbNic` prices employer NICs from), so the
 * accumulated base is exactly earnings that attract secondary Class 1. The
 * allowance share rides the `gb_apprenticeship_levy_allowance` employer
 * fact — a standalone employer records 15000.00; connected employers record
 * their allocated slices. An unrecorded share refuses by name in the priors
 * layer; nothing else refuses. The levy posts as an employer-contribution
 * line per stub (each stub's marginal share of the month's liability, so the
 * month partitions exactly) and stamps GB_LEVY/GB_LEVY_EARN factors — the
 * year-to-date levy the EPS reports is their sum over committed stubs.
 * EPS submission itself rides RTI software per the pack's standing refusal.
 */
export function gbEmployerAggregateLevies(taxYear: number): readonly PayrollEmployerAggregateLevy[] {
  // Throws for a year without transcribed tables — the declaration refuses
  // untranscribed years, never prices from a neighbour's.
  const tables = gbTablesForTaxYear(taxYear);
  return [
    {
      key: "apprenticeship_levy",
      label: "Apprenticeship Levy",
      systemKey: "apprenticeship_levy",
      description:
        "Apprenticeship Levy 0.5% — report the year-to-date levy on the Employer Payment Summary",
      sequence: 211,
      base: {
        source: "pensionable",
        scope: "org",
        periodFloor: {
          weekly: tables.nicWeekly.st,
          monthly: tables.nicMonthly.st,
          annual: tables.nicAnnual.st,
        },
      },
      timing: "per_run",
      rate: { kind: "flat_percent", percent: "0.5" },
      allowance: {
        kind: "accruing_allowance",
        factKey: "gb_apprenticeship_levy_allowance",
        yearStartMonth: 4,
        yearStartDay: 6,
      },
      factorKey: "GB_LEVY",
    },
  ];
}
