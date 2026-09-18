/**
 * The AU pack's rate slots and tax-year support.
 *
 * FY 2026–27 is transcribed: Schedule 1 (statement of formulas) scales 1–3,
 * with and without the Schedule 8 STSL component, live in
 * ./schedule1-2027.ts, quoted from the Federal Register instrument F2026L00716
 * (the ATO site 403s). FY 2025–26 stays `draft`, which the tax-year layer
 * reports as a refusal naming the year rather than as calculable coverage.
 */
import type { PayrollPackRates } from "../statutory-rates.ts";
import type { PayrollTaxYearSupport } from "../tax-years.ts";
import { AU_KNOWN_REGIONS } from "./jurisdictions.ts";

/**
 * Tenant-entered rates the AU pack cannot publish.
 *
 * Workers' compensation premiums are set per employer by each state's
 * workers' compensation insurer — no publication a payroll system can carry
 * supplies them, exactly the shape the `region`-scoped slot exists for.
 * (State payroll-tax thresholds and rates are published per state but are an
 * employer-aggregate levy whose channel is still in review — see the ledger —
 * so they are not declared here.)
 */
export const AU_PACK_RATES: PayrollPackRates = {
  country: "AU",
  slots: [
    {
      key: "au_workers_comp",
      label: "Workers' compensation premium",
      scope: "region",
      regions: AU_KNOWN_REGIONS,
      systemKeys: ["wcb"],
      fields: [
        {
          key: "rate",
          label: "Premium rate",
          kind: "rate",
          decimals: 6,
          min: "0",
          max: "1",
          required: true,
          help: "The premium rate on the state insurer's notice, as a decimal "
            + "fraction (0.027 for 2.7%).",
        },
      ],
      citation:
        "State and territory workers' compensation schemes — "
        + "employer premium notices",
      variesBecause:
        "Premium rates are set per employer by each state or territory's "
        + "workers' compensation insurer from the employer's industry and "
        + "claims history. No pack constant can carry them.",
    },
  ],
};

export const AU_TAX_YEARS: PayrollTaxYearSupport = {
  country: "AU",
  editions: [
    {
      year: 2026,
      label: "2025–26",
      effectiveFrom: "2025-07-01",
      citation:
        "ATO PAYG withholding tax tables 2025–26 (Schedule 1 applied to "
        + "payments 1 July 2024 – 30 June 2026) — "
        + "https://www.ato.gov.au/tax-rates-and-codes/tax-tables-overview",
      status: "draft",
    },
    {
      year: 2027,
      label: "2026–27",
      effectiveFrom: "2026-07-01",
      citation:
        "Taxation Administration (Withholding Schedules) Instrument 2026 "
        + "(F2026L00716), Schedule 1 – Statement of formulas for calculating "
        + "amounts to be withheld, made by Ben Kelly, Deputy Commissioner of "
        + "Taxation, 2 June 2026, commencing 1 July 2026 — "
        + "https://www.legislation.gov.au/F2026L00716/asmade/2026-06-12/"
        + "text/original/epub/OEBPS/document_1/document_1.html",
      status: "published",
    },
  ],
  // PAYG withholding is national: no state publishes its own tables.
  regionsWithOwnTables: [],
  ratesModule: "engine/src/payroll/au/rates.ts",
  scaffold: {
    files: [
      {
        path: "engine/src/payroll/au/schedule1-{year}.ts",
        purpose:
          "Transcribed ATO Schedule 1 coefficients (scales 1–6) for the year",
        template:
          "export const AU_PAYG_SCHEDULE_{year} = { year: {year}, "
          + "priorYear: {priorYear}, scales: {} as const };\n",
      },
    ],
    barrels: [
      {
        path: "engine/src/payroll/au/schedule1.ts",
        modulePattern: "schedule1-(\\d{4})\\.ts",
        exportName: "AU_PAYG_SCHEDULE_{year}",
        template: "{imports}\nexport const AU_PAYG_SCHEDULES = { {entries} };\n",
      },
    ],
    steps: [
      "Transcribe the ATO Schedule 1 coefficients for {year} from the cited publication",
      "Flip the {year} edition in AU_TAX_YEARS from draft to published",
      "Add a golden withholding case computed from the transcribed scales",
    ],
  },
};
