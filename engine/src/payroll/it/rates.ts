/**
 * The IT pack's tax-year support: nothing transcribed, 2026 refused by name.
 *
 * What 2026 requires (all unsourced-in-this-repo, hence the refusal):
 *
 * - IRPEF scaglioni/aliquote: the 2026 Budget Law (L. 30 dicembre 2025,
 *   n. 199, art. 1 c. 3–4) cut the second bracket (€28,001–€50,000) from 35%
 *   to 33% — so above €50,000 the due tax is €13,700 + 43% — and neutralises
 *   the benefit above €200,000 of total income. The Agenzia delle Entrate's
 *   own rates page (last update 16/01/2026,
 *   https://www.agenziaentrate.gov.it/portale/web/english/personal-income-tax-rates-and-calculation)
 *   carries the cut as a note while its table still prints the prior 35% /
 *   €14,140 figures, so the page alone cannot be transcribed without
 *   reconciling table against note against the Gazzetta text.
 * - Detrazioni (artt. 12–13 TUIR) phaseouts for the year.
 * - INPS: Circolare n. 6 del 30 gennaio 2026 (minimali/massimali for
 *   dipendenti) and the year's FPLD/IVS rates.
 * - Addizionali: the year's regional deliberations and the MEF comunale
 *   dataset — thousands of rates, never a constant.
 *
 * `statutoryRates` carries no slots yet: INPS rates are published constants
 * (edition material, not tenant-entered), and the per-comune addizionale
 * slot only makes sense once an engine reads it. This pack has no
 * pre-scoping settings blob, so there is no legacyRows reader either.
 */
import type { PayrollPackRates } from "../statutory-rates.ts";
import type { PayrollTaxYearSupport } from "../tax-years.ts";

export const IT_TAX_YEARS: PayrollTaxYearSupport = {
  country: "IT",
  // No edition transcribed for any year. 2026 in particular is refused:
  // L. 199/2025 rewrote the second IRPEF bracket and the AdE page is
  // internally inconsistent (note vs. table), so there is no sourced table
  // to load — only the scaffold below describing how to build one.
  editions: [],
  // No region publishes its own withholding tables the Québec way: regional
  // and municipal surcharges ride the national computation once transcribed.
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
    // No barrel exists until the first edition module lands; the generator
    // wires editions/{year}.ts into rates.ts when that happens.
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

export const IT_PACK_RATES: PayrollPackRates = {
  country: "IT",
  slots: [],
};
