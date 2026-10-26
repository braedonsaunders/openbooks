import type { PayrollEmployerLevyProgram } from "../pack-types.ts";

/** Assessment bases and create-time exclusions declared by Canadian payroll. */
export const CA_EMPLOYER_LEVY_PROGRAMS: readonly PayrollEmployerLevyProgram[] = [
  {
    nonTaxableEarningsExcludedByDefault: true,
    key: "wcb",
    label: "WCB/WSIB assessable earnings",
    help: "Earnings assessable for workers' compensation premiums at the employee's class rate, to the class annual maximum.",
  },
  {
    nonTaxableEarningsExcludedByDefault: true,
    key: "eht",
    label: "Employer health tax assessable earnings",
    help: "Remuneration assessable for provincial employer health tax (Ontario EHT past the annual exemption).",
  },
  {
    nonTaxableEarningsExcludedByDefault: true,
    key: "hsf",
    label: "Health Services Fund assessable earnings",
    help: "Remuneration subject to the Québec Health Services Fund contribution (TP-1015.F-V s. 5).",
  },
  {
    nonTaxableEarningsExcludedByDefault: true,
    key: "cnt",
    label: "Labour standards contribution assessable earnings",
    help: "Remuneration subject to the Québec contribution related to labour standards (LE-39.0.2-V).",
  },
];

/** Issued premiums supported independently of the native assessment basis. */
export const CA_ISSUED_EMPLOYER_LEVY_PROGRAMS = {
  ca_eht: { country: "CA", systemKey: "eht", label: "Employer Health Tax" },
  ca_wcb: { country: "CA", systemKey: "wcb", label: "WCB/WSIB" },
} as const;

/** A single issued withholding total cannot replace separately assessed provincial tax. */
export const CA_ISSUED_INCOME_TAX_OVERRIDE = { country: "CA", excludedRegions: ["QC"] } as const;
