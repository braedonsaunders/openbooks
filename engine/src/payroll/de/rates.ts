import type { PayrollPackRates } from "../statutory-rates.ts";
import type { PayrollEditionScaffold, PayrollTaxYearSupport } from "../tax-years.ts";

/**
 * Germany — tax years and tenant-entered statutory rates (skeleton).
 *
 * Nothing is transcribed yet: `editions` is empty, so every year — 2026
 * included — is refused by name until the publications below are transcribed.
 * The publications to transcribe, in order:
 *
 * 1. BMF Programmablaufplan für den Lohnsteuerabzug 2026 (BMF-Schreiben vom
 *    12.11.2025): the machine Lohnsteuer calculation (§39b EStG) — §32a
 *    tariff, Vorsorgepauschale, Solidaritätszuschlag, and the
 *    Kirchenlohnsteuer assessment base.
 * 2. The 2026 Sozialversicherungs-Rechengrößen (Beitragsbemessungsgrenzen
 *    KV/RV/AV and the Versicherungspflichtgrenze) from the
 *    Sozialversicherungs-Rechengrößenverordnung 2026.
 *
 * Lohnsteuer is federal and uniform: no Land publishes its own wage-tax
 * tables, so `regionsWithOwnTables` is empty. Kirchenlohnsteuer RATES differ
 * by Land (8% in Bayern/Baden-Württemberg, 9% elsewhere) but ride the federal
 * assessment base — the refusal is the missing base, not the percentages.
 */
export const DE_EDITION_SCAFFOLD: PayrollEditionScaffold = {
  files: [],
  barrels: [],
  steps: [
    "Transcribe the BMF Programmablaufplan für den Lohnsteuerabzug 2026 "
    + "(BMF-Schreiben vom 12.11.2025) into engine/src/payroll/de/.",
    "Transcribe the 2026 SV Rechengrößen (Sozialversicherungs-Rechengrößenverordnung 2026).",
    "Add published 2026 editions to DE_TAX_YEARS and flip installable to true in pack.ts.",
  ],
};

export const DE_TAX_YEARS: PayrollTaxYearSupport = {
  country: "DE",
  editions: [],
  regionsWithOwnTables: [],
  ratesModule: "engine/src/payroll/de/rates.ts",
  scaffold: DE_EDITION_SCAFFOLD,
};

/**
 * Tenant-entered statutory rates: none declared yet. The employer-side levies
 * whose rates no publication can supply (Umlage U1/U2 vary by Krankenkasse,
 * Berufsgenossenschaft rates vary by Gefahrklasse) will each gain a slot here
 * when the corresponding engine work transcribes them — see the ledger.
 */
export const DE_PACK_RATES: PayrollPackRates = {
  country: "DE",
  slots: [],
};
