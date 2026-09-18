/**
 * The IT pack's tax-year support: 2025 transcribed, 2026 refused by name.
 *
 * 2025 (this file + tax-year-2025.ts): IRPEF 23/35/43 scaglioni (L. 207/2024
 * art. 1 c. 2, AdE rates page, 730/2026 TABELLA 1), art. 13 detrazione lavoro
 * dipendente with the 1.955 base and 1.910/1.190 taper (Circ. 4/E/2025,
 * 730/2026 TABELLA 6), the +65 euro art. 13 c. 2 increase, the L. 207/2024
 * c. 4 somma and c. 6 ulteriore detrazione, the trattamento integrativo with
 * the structural −75 euro correction (L. 207/2024 c. 3), INPS FPLD/IVS
 * 9,19/23,81 with prima fascia 55.448 and post-1995 massimale 120.607
 * (INPS Circ. 26/2025, Tabella 1/2025), and the CU half-up-to-cent rounding.
 * Sourcing outcomes per host are recorded in tax-year-2025.ts.
 *
 * 2026 is refused by name: L. 30 dicembre 2025, n. 199, art. 1 c. 3–4 cut
 * the second bracket (€28,001–€50,000) from 35% to 33% — so above €50,000
 * the due tax is €13,700 + 43% — and neutralises the benefit above €200,000
 * of total income. The Agenzia delle Entrate's own rates page (last update
 * 16/01/2026) carries the cut as a note while its table still prints the
 * prior 35% / €14,140 figures, so the page alone cannot be transcribed
 * without reconciling table against note against the Gazzetta text; INPS
 * Circ. n. 6 del 30 gennaio 2026 and the 2026 addizionali deliberations are
 * likewise untranscribed here.
 */
import type { PayrollPackRates } from "../statutory-rates.ts";
import type { PayrollTaxYearSupport } from "../tax-years.ts";
import { IT_2025_EDITION_LABEL } from "./tax-year-2025.ts";

export const IT_TAX_YEARS: PayrollTaxYearSupport = {
  country: "IT",
  editions: [
    {
      year: 2025,
      label: IT_2025_EDITION_LABEL,
      effectiveFrom: "2025-01-01",
      citation:
        "L. 30 dicembre 2024, n. 207, art. 1 c. 2–9, 11 (GU 24G00229); "
        + "AdE Circolare 4/E del 16 maggio 2025; AdE 730/2026 istruzioni "
        + "(redditi 2025); CU 2026 istruzioni; INPS Circolare n. 26 del 30 "
        + "gennaio 2025; INPS Tabella 1/2025",
      status: "published",
    },
  ],
  // No region publishes its own withholding tables the Québec way: the
  // addizionali ride the national computation from tenant-declared rates
  // (see the it_addizionale_regionale / it_addizionale_comunale slots).
  regionsWithOwnTables: [],
  ratesModule: "engine/src/payroll/it/rates.ts",
  scaffold: {
    files: [
      {
        path: "engine/src/payroll/it/editions/{year}.ts",
        purpose:
          "IRPEF scaglioni/aliquote, detrazioni phaseouts, and INPS FPLD/IVS rates transcribed "
          + "from the year's Legge di Bilancio, AdE provvedimenti, and INPS circular",
        template:
          "export const IT_EDITION_{year} = {\n"
          + "  year: {year},\n"
          + "  // Transcribed from the Gazzetta Ufficiale text, reconciled against the AdE rates page.\n"
          + "  // Prior edition: IT_EDITION_{priorYear}.\n"
          + "};\n",
      },
    ],
    barrels: [],
    steps: [
      "Read the year's Legge di Bilancio (for 2026: L. 30 dicembre 2025, n. 199, art. 1 c. 3–4 — "
      + "second IRPEF bracket 33%, benefit neutralised above €200,000) from the Gazzetta Ufficiale.",
      "Reconcile against the AdE IRPEF rates page "
      + "(https://www.agenziaentrate.gov.it/portale/web/english/personal-income-tax-rates-and-calculation): "
      + "do not transcribe while its table and notes disagree.",
      "Transcribe the year's INPS circular (for 2026: Circolare n. 6 del 30 gennaio 2026) — "
      + "minimali, massimali, and FPLD/IVS employee/employer rates.",
      "Transcribe the year's addizionale regionale deliberations and the MEF addizionale comunale "
      + "dataset; Trento and Bolzano deliberate separately inside region 04.",
      "Add the edition to IT_TAX_YEARS.editions with the AdE provvedimento citation, flip "
      + "installable to true, and wire computeItStatutory to the tables.",
    ],
  },
};

/**
 * Tenant-entered statutory rates: the two addizionali. Their rates are
 * deliberated yearly by ~20 regions and ~7,900 comuni (D.Lgs. 15 dicembre
 * 1997, n. 446; D.Lgs. 28 settembre 1998, n. 360; AdE Elenco addizionale
 * comunale 2025, 196 pages) — no publication a payroll system can carry
 * supplies them, so the employer enters the domicile's deliberated rate,
 * exactly as they enter a SUI experience rate. The engine reads the
 * resolution and refuses an unconfigured scope point rather than guessing.
 */
export const IT_PACK_RATES: PayrollPackRates = {
  country: "IT",
  slots: [
    {
      key: "it_addizionale_regionale",
      label: "Addizionale regionale all'IRPEF — aliquota deliberata",
      scope: "region",
      systemKeys: ["regional_surtax"],
      fields: [
        {
          key: "rate",
          label: "Aliquota deliberata dalla regione",
          kind: "percent",
          decimals: 4,
          min: "0",
          max: "100",
          required: true,
          help: "The region's deliberated addizionale regionale rate as a percent number (1,23 for 1,23%). Follows the employee's fiscal domicile, never the workplace.",
        },
      ],
      citation:
        "D.Lgs. 15 dicembre 1997, n. 446; annual regional deliberations",
      variesBecause:
        "each of the ~20 regions (Trento and Bolzano deliberating separately inside region 04) sets its own rate yearly; no pack constant can carry them",
    },
    {
      key: "it_addizionale_comunale",
      label: "Addizionale comunale all'IRPEF — aliquota deliberata",
      scope: "sub_region",
      systemKeys: ["municipal_surtax"],
      fields: [
        {
          key: "rate",
          label: "Aliquota deliberata dal comune",
          kind: "percent",
          decimals: 4,
          min: "0",
          max: "100",
          required: true,
          help: "The comune's deliberated addizionale comunale rate as a percent number (0,8 for 0,8%). Follows the employee's fiscal domicile comune (codice catastale).",
        },
        {
          key: "exemption",
          label: "Soglia di esenzione deliberata (EUR)",
          kind: "amount",
          decimals: 2,
          min: "0",
          max: "1000000",
          required: false,
          help: "The comune's deliberated exemption threshold: no surtax when the IRPEF taxable income is at or below it. Leave blank when the comune deliberates none.",
        },
      ],
      citation:
        "D.Lgs. 28 settembre 1998, n. 360; AdE Elenco addizionale comunale 2025",
      variesBecause:
        "each of the ~7,900 comuni deliberates its own rate (single or banded) and exemption yearly; the AdE Elenco alone runs to 196 pages",
    },
  ],
};
