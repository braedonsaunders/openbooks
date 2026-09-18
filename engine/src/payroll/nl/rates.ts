import type { PayrollPackRates } from "../statutory-rates.ts";
import type { PayrollEditionScaffold, PayrollTaxYearSupport } from "../tax-years.ts";

/**
 * The Netherlands — 2026 statutory transcription for the loonheffing engine
 * (`./loonheffing.ts`).
 *
 * Sourced from the Belastingdienst's own publications, fetched 2026-09-18
 * (HTTP 200, no challenge body) from download.belastingdienst.nl:
 *
 * - "Rekenvoorschriften voor de geautomatiseerde loonadministratie 2026 —
 *   Uitgave januari 2026, versie 2" (LH 099-1Z62FD), the official payroll-
 *   software algorithm. "Alle symboolwaarden in dit document gelden voor het
 *   jaar 2026, vanaf 1 januari." (§2.1, stap 5.)
 * - "Tarieven, bedragen en percentages loonheffingen vanaf 1 januari 2026 —
 *   Bijlage bij de Nieuwsbrief Loonheffingen 2026, Uitgave 2" (19 januari
 *   2026). "In deze cijferbijlage van de Nieuwsbrief Loonheffingen 2026 treft
 *   u de tarieven, bedragen en percentages aan ten behoeve van de
 *   loonheffingen voor het jaar 2026."
 *
 * Every figure below carries the table it was read from. Amounts are whole
 * euros (the voorschriften give every threshold and maximum in whole euros);
 * rates are decimal strings at the publication's own precision (percentages
 * to 2 decimals, opbouw/afbouw factors to 5).
 *
 * Deliberately NOT transcribed, each refused by name in the engine:
 *
 * - Herleidingssituaties AG–FL and the buitenland tables (Rekenvoorschriften
 *   chapters 7–8): the row-selection and substitutiewaarden live in the
 *   separately downloadable bijlage "Parameterwaarden, substitutiewaarden en
 *   herleidingsfactoren", which was not obtained. Only the standaardsituatie
 *   for an employee living in Nederland computes.
 * - The tabellen voor bijzondere beloningen (bonuses): the percentages are
 *   published per prior-year-wage row, but which row a bonus takes is set by
 *   Handboek Loonheffingen 2026 §9.3.6, and no primary-host copy of that
 *   paragraph was obtainable from this network vantage. A tapered-percentage
 *   table applied on a guessed row key is wrong money, so any non-periodic
 *   payment throws rather than falling through to the regular table.
 * - Eindheffing tabellen 5.x/6.x, the sectorale Whk percentages (Tabel 10 —
 *   sectorfondsen detail, out of scope for this pack), the 30%-ruling, the
 *   WKR, and pension schemes (all named out of scope).
 * - The Whk (Werkhervattingskas) percentage itself: "Gedifferentieerde premie
 *   Whk — Zie mededeling of beschikking" (Tabel 9). It arrives per employer
 *   by beschikking, so it is a declared engine input, never a constant.
 * - No ZW percentage: Tabel 9 "Premies werknemersverzekeringen" lists AWf,
 *   Whk, Aof, Opslag Wko and Ufo — no ZW row. The ZW-flex differentiated
 *   premium for non-eigenrisicodragers runs inside the Whk beschikking, so
 *   the ZW component posts nothing (see `./loonheffing.ts`).
 */

/** Which age class prices the withholding: the AOW boundary splits schijf 1. */
export type NlAgeClass = "under_aow" | "aow_1945" | "aow_1946";

/** One marginal band of the schijventarief: base up to `upTo` prices at `ratePct`. */
export interface NlBracket {
  /** Upper bound in whole euros; null tops out. */
  upTo: number | null;
  /** Loonbelasting/premie volksverzekeringen percent, 2 decimals. */
  ratePct: string;
  /** Gecumuleerde maximuminhouding over the lower schijven, whole euros. */
  cumulative: number;
}

/**
 * Schijventarief loonbelasting/premie volksverzekeringen 2026
 * (Tarieven newsletter Tabel 1; Rekenvoorschriften Tabel 2).
 * "1 € 0 € 38.883 35,75%"; "2a € 38.883 € 78.426 37,56%";
 * "3 € 78.426 – 49,50%". AOW 1945+: schijf 1 to € 41.123 at 17,85%.
 */
export const NL_BRACKETS_2026: Record<NlAgeClass, readonly NlBracket[]> = {
  under_aow: [
    { upTo: 38883, ratePct: "35.75", cumulative: 0 },
    { upTo: 78426, ratePct: "37.56", cumulative: 13900 },
    { upTo: null, ratePct: "49.50", cumulative: 28752 },
  ],
  aow_1945: [
    { upTo: 41123, ratePct: "17.85", cumulative: 0 },
    { upTo: 78426, ratePct: "37.56", cumulative: 7340 },
    { upTo: null, ratePct: "49.50", cumulative: 21351 },
  ],
  aow_1946: [
    { upTo: 38883, ratePct: "17.85", cumulative: 0 },
    { upTo: 78426, ratePct: "37.56", cumulative: 6940 },
    { upTo: null, ratePct: "49.50", cumulative: 21792 },
  ],
};

/** Algemene heffingskorting symbols (Rekenvoorschriften Tabel 3). */
export interface NlAhkParams {
  /** Basisbedrag: "€ 3.115" (AOW: "€ 1.556"). */
  base: number;
  /** 1e inkomensgrens: "€ 29.736". */
  phaseFrom: number;
  /** 2e inkomensgrens: "€ 78.426". */
  phaseTo: number;
  /** Afbouwfactor: "0,06398" (AOW: "0,03195"). */
  phaseOut: string;
}

export const NL_AHK_2026: Record<"under_aow" | "aow", NlAhkParams> = {
  under_aow: { base: 3115, phaseFrom: 29736, phaseTo: 78426, phaseOut: "0.06398" },
  aow: { base: 1556, phaseFrom: 29736, phaseTo: 78426, phaseOut: "0.03195" },
};

/** Ouderenkorting symbols (Rekenvoorschriften Tabel 4, AOW only). */
export const NL_OUK_2026 = {
  /** Basisbedrag: "€ 2.067". */
  base: 2067,
  /** 1e inkomensgrens: "€ 46.002". */
  phaseFrom: 46002,
  /** 2e inkomensgrens: "€ 59.782". */
  phaseTo: 59782,
  /** Afbouwfactor: "0,15000". */
  phaseOut: "0.15000",
} as const;

/** Alleenstaande-ouderenkorting (Rekenvoorschriften Tabel 5, AOW only). */
export const NL_AOK_2026 = 540;

/** Arbeidskorting symbols (Rekenvoorschriften Tabel 6). */
export interface NlArkParams {
  build1: string;
  build2: string;
  build3: string;
  taper: string;
  band1: number;
  band2: number;
  band3: number;
  taperEnd: number;
  max1: number;
  max2: number;
  max3: number;
}

export const NL_ARK_2026: Record<"under_aow" | "aow", NlArkParams> = {
  under_aow: {
    build1: "0.08324",
    build2: "0.31009",
    build3: "0.01950",
    taper: "0.06510",
    band1: 11965,
    band2: 25845,
    band3: 45592,
    taperEnd: 132920,
    max1: 996,
    max2: 5300,
    max3: 5685,
  },
  aow: {
    build1: "0.04156",
    build2: "0.15483",
    build3: "0.00974",
    taper: "0.03250",
    band1: 11965,
    band2: 25845,
    band3: 45592,
    taperEnd: 132920,
    max1: 498,
    max2: 2647,
    max3: 2840,
  },
};

/**
 * Jonggehandicaptenkorting standard annual amount: "De
 * jonggehandicaptenkorting wordt vastgesteld als een standaardjaarbedrag
 * (2026: € 923)" (Rekenvoorschriften §5.1). Time-slice amounts from Tabel 13:
 * kwartaal "€ 230,75", maand "€ 76,92", 4 weken "€ 71,00", week "€ 17,75",
 * dag "€ 3,55". The AOW+ herleid amount (€ 462 = € 210 loonbelastingdeel +
 * € 252 premiedeel Anw/Wlz) is the document's own worked example (§5.2).
 */
export const NL_JGK_2026 = 923;
export const NL_JGK_2026_AOW = 462;

/** Brontabel step and ceiling (Rekenvoorschriften Tabel 1a). */
export const NL_LV_2026 = 54;
export const NL_LMAX_2026 = 133110;

/**
 * Tijdvakfactor F (Rekenvoorschriften Tabel 1b): "Kwartaalloon 4,000",
 * "Maandloon 12,000", "Vierwekenloon 13,000", "Weekloon 52,000",
 * "Dagloon 260,000". Keyed by periods per year.
 */
export const NL_PERIOD_FACTORS_2026: Record<number, number> = {
  4: 4,
  12: 12,
  13: 13,
  52: 52,
  260: 260,
};

/** Employer premiums 2026 (Tarieven newsletter Tabel 9). */
export const NL_EMPLOYER_PREMIUMS_2026 = {
  /** "Premie AWf laag 2,74%". */
  awfLow: "2.74",
  /** "Premie AWf hoog 7,74%". */
  awfHigh: "7.74",
  /** "Gedifferentieerde premie Aof laag 6,27%". */
  aofLow: "6.27",
  /** "Gedifferentieerde premie Aof hoog 7,63%". */
  aofHigh: "7.63",
  /** "Gedifferentieerde premie Whk — Zie mededeling of beschikking": no rate. */
  whk: null,
} as const;

/** Employer-size bounds for Aof/Whk (Tabel 9): gemiddeld premieloon "€ 43.300". */
export const NL_EMPLOYER_SIZE_2026 = {
  averageWage: 43300,
  /** "Kleine werkgever: tot en met 25x gemiddeld premieloon ≤ € 1.082.500". */
  smallMax: 1082500,
  /** "Middelgrote werkgever: tot en met 100x ≤ € 4.330.000". */
  mediumMax: 4330000,
} as const;

/** Zvw percentages (Tabel 12): werkgeversheffing / inhouding bijdrage. */
export const NL_ZVW_2026 = {
  /** "werkgeversheffing Zvw 6,10%". */
  employer: "6.10",
  /** "inhouding van bijdrage Zvw 4,85%" (employee-side, not a slot). */
  employeeWithholding: "4.85",
} as const;

/**
 * Maximumpremieloon / maximumbijdrageloon 2026 (Tabel 11): "Loontijdvakmaxima
 * zijn gelijk voor de werknemersverzekeringen en de Zorgverzekeringswet".
 * Dag "€ 305,41", week "€ 1.527,09", 4 weken "€ 6.108,38", maand
 * "€ 6.617,41", kwartaal "€ 19.852,25", jaar "€ 79.409,00".
 */
export const NL_MAX_PREMIUM_WAGE_2026: Record<number, string> = {
  260: "305.41",
  52: "1527.09",
  13: "6108.38",
  12: "6617.41",
  4: "19852.25",
  1: "79409.00",
};
export const NL_MAX_PREMIUM_WAGE_ANNUAL_2026 = "79409.00";

/** The one transcribed year. */
export const NL_TRANSCRIBED_YEARS_2026 = [2026] as const;

export const NL_EDITION_SCAFFOLD: PayrollEditionScaffold = {
  files: [],
  barrels: [],
  steps: [
    "Transcribe the next year's Rekenvoorschriften voor de geautomatiseerde loonadministratie into engine/src/payroll/nl/rates.ts from download.belastingdienst.nl.",
    "Transcribe the next year's Tarieven, bedragen en percentages loonheffingen newsletter (AWf/Aof/Zvw/maximumpremieloon).",
    "Add a published edition to NL_TAX_YEARS with the edition label and citation, plus conformance goldens against that year's witte maandtabel.",
  ],
};

export const NL_TAX_YEARS: PayrollTaxYearSupport = {
  country: "NL",
  editions: [
    {
      year: 2026,
      label: "Rekenvoorschriften januari 2026 v2 + Tarieven Uitgave 2",
      effectiveFrom: "2026-01-01",
      citation:
        "Belastingdienst, Rekenvoorschriften voor de geautomatiseerde loonadministratie 2026 "
        + "(uitgave januari 2026, versie 2); Tarieven, bedragen en percentages loonheffingen "
        + "vanaf 1 januari 2026 (bijlage bij de Nieuwsbrief Loonheffingen 2026, uitgave 2)",
      status: "published",
    },
  ],
  regionsWithOwnTables: [],
  ratesModule: "engine/src/payroll/nl/rates.ts",
  scaffold: NL_EDITION_SCAFFOLD,
};

/**
 * Tenant-entered statutory rates: none. The employer premiums with published
 * rates (AWf, Aof, Zvw) are edition constants above; the Whk percentage
 * ("Zie mededeling of beschikking") is a per-employer declared engine input
 * (see `./loonheffing.ts`), not a tenant slot — declaring a slot before the
 * engine reads it would be a shape without a reader.
 */
export const NL_PACK_RATES: PayrollPackRates = {
  country: "NL",
  slots: [],
};
