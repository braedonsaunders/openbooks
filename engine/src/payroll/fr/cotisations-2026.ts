import { PayrollPackError } from "../payroll-error.ts";

/**
 * Transcribed URSSAF contribution tables for calendar year 2026.
 *
 * Provenance (read the local copies — this vantage cannot reach the hosts):
 * - Rates: `urssaf.fr/accueil/outils-documentation/taux-baremes/
 *   taux-cotisations-secteur-prive.html`, verified HTTP 200 from the host
 *   network, rendered in a real browser (the server HTML is a navigation
 *   shell with no rates — JS-rendered, NOT blocked). Saved as
 *   `packs/sources/urssaf-taux-secteur-prive.html / .txt`.
 * - Plafonds: `urssaf.fr/accueil/outils-documentation/taux-baremes/
 *   plafonds-securite-sociale.html`, verified HTTP 200, "Mis à jour le
 *   01 janvier 2026". Saved as `packs/sources/urssaf-plafonds.html / .txt`.
 * - `boss.gouv.fr`: connect timeout (000) even from the host network —
 *   genuinely unreachable, not a sandbox artefact. `legifrance.gouv.fr`:
 *   HTTP 403 (Cloudflare "Just a moment…", does not clear in a browser).
 * - No vendor, law-firm, OECD or other-ERP source is used anywhere.
 *
 * Operative text is quoted on every constant below ("Taux …" table, taux
 * patronaux then taux salariaux). Non-breaking spaces normalised.
 *
 * Money discipline: rates are exact decimal FRACTION strings ("0.13" for
 * 13 %), never floats, never percents-as-numbers. Caps are whole euros.
 * The engine consumes them with bigint units (see ./compute-statutory.ts).
 *
 * Rounding: NEITHER page states a rounding rule (no "arrondi"/"centime"
 * anywhere in either text). Method (engine-stated, not agency-quoted, per
 * the AU precedent): each contribution line rounds half-up to the centime.
 */

/** One transcribed rate with its quoted source figure. */
export interface FrCotisationRate {
  /** Exact decimal fraction ("0.13" for 13 %). */
  readonly rate: string;
  /** Operative text quoted from the URSSAF rates page. */
  readonly quote: string;
}

/**
 * PASS 2026 corroborated by the plafonds page (FR_PASS_2026 in
 * ./tables-2026.ts was transcribed from service-public.gouv.fr A15386):
 *
 * "2026 Année 48 060 € Trimestre 12 015 € Mois 4 005 € Quinzaine
 * 2 003 € Semaine 924 € Jour 220 € Heure 30 €"
 *
 * (métropole et Outre-mer hors Mayotte; Mayotte 2026: "Année
 * 36 264 € … Mois 3 022 €" — recorded, not implemented.)
 *
 * The plafonds page also states the ceiling's meaning: "Le plafond de
 * Sécurité sociale est le montant maximum des rémunérations ou gains à
 * prendre en compte pour le calcul de certaines cotisations."
 */
export const FR_PASS_2026_URSSAF = {
  annual: "48060",
  monthly: "4005",
} as const;

/**
 * Four times the PASS: 4 × 48 060 = 192 240. The rates page caps the
 * chômage, AGS and CSG/CRDS bases at "192 240 € en 2026" — the engine
 * asserts this relationship (FR_PASS_2026_URSSAF.annual × 4) rather than
 * transcribing 192 240 as an independent figure.
 */
export const FR_QUATRE_PASS_2026 = "192240";

/**
 * SMIC 2026 (salaire minimum de croissance), in force 1 January 2026:
 *
 * Décret n° 2025-1228 du 17 décembre 2025 portant relèvement du salaire
 * minimum de croissance (Journal officiel du 18 décembre 2025): taux
 * horaire brut 12,02 €, SMIC mensuel brut 1 823,03 € pour 151,67 h.
 * Corroborated by INSEE (Smic series: 2026 → 12,02 € / 1 823,03 €,
 * insee.fr) and service-public.fr A17008 (12,02 € horaire, 1 823,03 €
 * mensuel brut, net 1 443,11 €).
 *
 * The annual figure is the published monthly × 12 (1 823,03 × 12 =
 * 21 876,36) — asserted in the goldens, not re-transcribed.
 */
export const FR_SMIC_2026 = {
  hourly: "12.02",
  monthly: "1823.03",
  annual: "21876.36",
  quote:
    "Décret n° 2025-1228 du 17 décembre 2025: taux horaire du SMIC 12,02 € "
    + "bruts, SMIC mensuel brut 1 823,03 € (151,67 h) à compter du 1er janvier 2026",
} as const;

/**
 * Allocations familiales reduced-rate ceiling 2026: 3,5 × SMIC annuel.
 *
 * CSS art. L241-6-1 fixes the employer rate at 3,45 % for salaries that do
 * not exceed 3,5 times the SMIC and 5,25 % above it ("n'excède pas 3,5 fois
 * le montant du Smic"); art. D241-3-1 sets the assessment modalities. The
 * engine compares the annualised remuneration (brut × periodicity) against
 * this annual ceiling — at monthly periodicity that is exactly brut ≤ 3,5 ×
 * SMIC mensuel (6 380,605 €).
 *
 * 3,5 × 21 876,36 = 76 567,26 — transcribed, with the relationship asserted
 * in the goldens (the FR_QUATRE_PASS_2026 pattern).
 */
export const FR_ALLOC_FAM_SEUIL_2026 = {
  multiple: "3.5",
  annual: "76567.26",
  quote:
    "CSS art. L241-6-1: taux réduit 3,45 % pour les rémunérations n'excédant "
    + "pas 3,5 fois le SMIC, taux plein 5,25 % au-delà (modalités: art. D241-3-1)",
} as const;

// ---------------------------------------------------------------------------
// Taux patronaux (employer)
// ---------------------------------------------------------------------------

/**
 * "Assurance maladie, maternité, invalidité, décès Taux réduit à 7 %
 * Taux plein à 13 %"
 *
 * The reduced/full split is income-dependent (réduction générale) and the
 * page states NO income condition — no SMIC multiple, no threshold text.
 * The engine applies the taux plein and refuses the reduced rate by name
 * (see FR_COTISATION_REFUSALS_2026); it never guesses which applies.
 */
export const FR_MALADIE_ER_2026 = {
  plein: { rate: "0.13", quote: "Assurance maladie, maternité, invalidité, décès Taux plein à 13 %" },
  reduit: { rate: "0.07", quote: "Assurance maladie, maternité, invalidité, décès Taux réduit à 7 %" },
} as const;

/**
 * "Contribution solidarité autonomie (CSA) 0,30 %"
 */
export const FR_CSA_ER_2026: FrCotisationRate = {
  rate: "0.003",
  quote: "Contribution solidarité autonomie (CSA) 0,30 %",
};

/**
 * "Assurance vieillesse 2,11 % sur la totalité et 8,55 % dans la limite
 * du plafond" (taux patronaux — déplafonnée then plafonnée).
 */
export const FR_VIEILLESSE_ER_2026 = {
  deplafonnee: {
    rate: "0.0211",
    quote: "Assurance vieillesse 2,11 % sur la totalité et 8,55 % dans la limite du plafond",
  },
  plafonnee: {
    rate: "0.0855",
    quote: "Assurance vieillesse 2,11 % sur la totalité et 8,55 % dans la limite du plafond",
  },
} as const;

/**
 * "Allocations familiales Taux réduit à 3,45 % Taux plein à 5,25 %"
 *
 * Unlike maladie, the réduit/plein split has a statutory income condition:
 * CSS art. L241-6-1 (modalités art. D241-3-1) — 3,45 % when the annualised
 * remuneration does not exceed 3,5 × SMIC (FR_ALLOC_FAM_SEUIL_2026 above),
 * 5,25 % above it. The engine selects the rate in ./cotisations.ts.
 */
export const FR_ALLOC_FAM_ER_2026 = {
  plein: { rate: "0.0525", quote: "Allocations familiales Taux plein à 5,25 %" },
  reduit: { rate: "0.0345", quote: "Allocations familiales Taux réduit à 3,45 %" },
} as const;

/**
 * "Contribution au dialogue social 0,016 %"
 */
export const FR_DIALOGUE_SOCIAL_ER_2026: FrCotisationRate = {
  rate: "0.00016",
  quote: "Contribution au dialogue social 0,016 %",
};

/**
 * "Contribution assurance chômage 4,00 % dans la limite de 192 240 €
 * en 2026"
 */
export const FR_CHOMAGE_ER_2026 = {
  rate: { rate: "0.04", quote: "Contribution assurance chômage 4,00 % dans la limite de 192 240 € en 2026" },
  /** Annual cap; the engine scales it to the pay periodicity. */
  capAnnual: FR_QUATRE_PASS_2026,
} as const;

/**
 * "Cotisation AGS Dans la limite de 192 240 € en 2026 : 0,25 %
 * 0,03 % pour les entreprises de travail temporaire"
 *
 * The engine applies 0,25 %. The 0,03 % temporary-work-agency variant
 * needs an employer-type channel no pack carries — refused by name.
 */
export const FR_AGS_ER_2026 = {
  rate: { rate: "0.0025", quote: "Cotisation AGS Dans la limite de 192 240 € en 2026 : 0,25 %" },
  capAnnual: FR_QUATRE_PASS_2026,
  interimVariant: {
    rate: "0.0003",
    quote: "Cotisation AGS Dans la limite de 192 240 € en 2026 : 0,25 % 0,03 % pour les entreprises de travail temporaire",
  },
} as const;

/**
 * "Fnal (effectif de moins de 50 salariés) 0,10 % dans la limite du
 * plafond Fnal (effectif de 50 salariés et plus) 0,50 %"
 *
 * Headcount-dependent: the engine reads the employer's effectif from the
 * statutory context (`employerEmployeeCount`) and fail-closes when it is
 * absent — it never assumes a size.
 */
export const FR_FNAL_ER_2026 = {
  moins50: {
    rate: "0.001",
    quote: "Fnal (effectif de moins de 50 salariés) 0,10 % dans la limite du plafond",
  },
  cinquanteEtPlus: {
    rate: "0.005",
    quote: "Fnal (effectif de 50 salariés et plus) 0,50 %",
  },
} as const;

// ---------------------------------------------------------------------------
// Taux salariaux (employee)
// ---------------------------------------------------------------------------

/**
 * "Assurance vieillesse  0,40 % sur la totalité et 6,90 % dans la limite
 * du plafond" (taux salariaux — déplafonnée then plafonnée).
 */
export const FR_VIEILLESSE_SAL_2026 = {
  deplafonnee: {
    rate: "0.004",
    quote: "Assurance vieillesse  0,40 % sur la totalité et 6,90 % dans la limite du plafond",
  },
  plafonnee: {
    rate: "0.069",
    quote: "Assurance vieillesse  0,40 % sur la totalité et 6,90 % dans la limite du plafond",
  },
} as const;

/**
 * "CSG imposable  2,40 % sur 98,25 % du salaire brut dans la limite
 * de 192 240 € en 2026" and "CSG non imposable  6,80 % sur 98,25 % du
 * salaire brut dans la limite de 192 240 € en 2026".
 *
 * The 98,25 % abattement is the classic French defect: CSG/CRDS are NOT
 * rate × brut. The engine builds the abated base first (brut × 98,25 %,
 * capped — see the cap-order note in ./compute-statutory.ts), or refuses
 * the line by name. There is no fallback that silently applies the rate
 * to the full brut.
 */
export const FR_CSG_SAL_2026 = {
  abattement: "0.9825",
  capAnnual: FR_QUATRE_PASS_2026,
  imposable: {
    rate: "0.024",
    quote: "CSG imposable  2,40 % sur 98,25 % du salaire brut dans la limite de 192 240 € en 2026",
  },
  nonImposable: {
    rate: "0.068",
    quote: "CSG non imposable  6,80 % sur 98,25 % du salaire brut dans la limite de 192 240 € en 2026",
  },
} as const;

/**
 * "CRDS  0,50 % sur 98,25 % du salaire brut dans la limite de
 * 192 240 € en 2026" — same abated base as CSG.
 */
export const FR_CRDS_SAL_2026 = {
  rate: "0.005",
  quote: "CRDS  0,50 % sur 98,25 % du salaire brut dans la limite de 192 240 € en 2026",
} as const;

/**
 * "Cotisation salariale maladie supplémentaire pour les départements du
 * Haut-Rhin, Bas-Rhin et de la Moselle  1,30 %" — transcribed and NOT
 * applied: it needs a workplace-department channel no pack carries.
 * Refused by name.
 */
export const FR_MALADIE_SAL_ALSACE_MOSELLE_2026: FrCotisationRate = {
  rate: "0.013",
  quote: "Cotisation salariale maladie supplémentaire pour les départements du Haut-Rhin, Bas-Rhin et de la Moselle  1,30 %",
};

// ---------------------------------------------------------------------------
// Tenant-declared by design (posture quotes, no rates transcribable)
// ---------------------------------------------------------------------------

/**
 * "Accident du travail Taux notifié par la Carsat" and "Versement
 * mobilité (effectif de 11 salariés et plus) Outil de recherche
 * versement mobilité" — establishment-/commune-specific by construction.
 * The pack already declares this posture (fr_atmp slot; versement
 * mobilité refused in FR_REFUSED_2026): the tenant declares the rate,
 * the pack never invents one.
 */
export const FR_TENANT_DECLARED_QUOTES_2026 = {
  atmp: "Accident du travail Taux notifié par la Carsat",
  versementMobilite:
    "Versement mobilité (effectif de 11 salariés et plus) Outil de recherche versement mobilité",
} as const;

/**
 * Named refusals for the 2026 cotisation pass: everything this file
 * transcribes but the engine must not guess at, with the reason. The
 * engine quotes these names back.
 */
export const FR_COTISATION_REFUSALS_2026: readonly string[] = [
  "Maladie patronale taux réduit 7 %: the page states no income condition for the réduit/plein split — the engine applies the 13 % plein, never the 7 % réduit",
  "Allocations familiales taux réduit 3,45 %: COMPUTED — CSS art. L241-6-1 threshold (3,5 × SMIC, FR_ALLOC_FAM_SEUIL_2026 above); the engine selects 3,45 % at or below the ceiling, 5,25 % above",
  "AGS 0,03 % interim variant: needs an employer-type (entreprise de travail temporaire) channel no pack carries — the engine applies 0,25 %",
  "Alsace-Moselle cotisation salariale maladie supplémentaire 1,30 % (transcribed above): needs a workplace-department channel no pack carries",
  "AT/MP (Taux notifié par la Carsat) and versement mobilité (commune-dependent): tenant-declared by design, never table-supplied",
  "FNAL without a known effectif: employerEmployeeCount absent — the 0,10 % plafonné vs 0,50 % déplafonné choice cannot be made",
  "AGIRC-ARRCO T1/T2 both shares, CEG and CET: transcribed in ./retraite-2026.ts and computed",
  "APEC 0,06 % (transcribed in ./retraite-2026.ts): cadres only — no pack channel carries the employee's cadre status",
  "AGIRC-ARRCO split modified by accord collectif: the page allows a collective agreement to modify the regulated 60/40 — the engine applies 60/40 with no tenant-override channel",
  "Brut/net-imposable bridge: COMPUTED — the stub's earnings figure is the brut; the PAS assiette (net imposable) is derived in ./cotisations.ts (calculateFrNetImposable2026: brut minus déductible lines, CSG 2,4 pts + CRDS added back)",
];

/** 2026 cotisation tables resolve by calendar year and throw otherwise. */
export function frCotisationYearForPayDate(payDate: string): 2026 {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
    throw new PayrollPackError(
      `FR cotisations need an ISO pay date (YYYY-MM-DD), got "${payDate}"`,
    );
  }
  if (payDate < "2026-01-01" || payDate > "2026-12-31") {
    throw new PayrollPackError(
      `FR cotisations have no transcribed tables for pay date ${payDate}: `
      + "the FR pack transcribes calendar 2026 only "
      + "(URSSAF taux secteur privé + plafonds, both rendered January 2026). "
      + "Transcribe the year's tables into engine/src/payroll/fr/ first.",
    );
  }
  return 2026;
}
