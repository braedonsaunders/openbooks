/**
 * CRA T4127 payroll deductions constants, versioned by edition.
 *
 * 2026 has two Option-1 constant sets: the 122nd edition (Jan 1) and the
 * 123rd edition (Jul 1), a delta edition that prorates the retroactive BC,
 * NL, and PE changes over the last six months. Everything not reproduced in
 * the 123rd edition carries forward from the 122nd unchanged.
 *
 * Sources (fetched from canada.ca, not memory):
 *   122nd: canada.ca/.../t4127-jan/t4127-jan-payroll-deductions-formulas-computer-programs.html
 *   123rd: canada.ca/.../t4127-jul/t4127-jul-payroll-deductions-formulas.html
 * plus CRA's machine-readable CSVs (Table 8.1/8.2, CPP/EI, claim codes).
 */

export type Province =
  | "AB" | "BC" | "MB" | "NB" | "NL" | "NS" | "NT" | "NU" | "ON" | "PE" | "QC" | "SK" | "YT"
  | "ZZ"; // outside Canada / in Canada beyond any province

/** Bracket: annual income up to `upTo` (null = top) taxed at `rate` with constant `k`. */
export interface TaxBracket { upTo: string | null; rate: string; k: string }

export interface BpaPhaseOut {
  max: string;        // BPA below phaseStart
  min: string;        // BPA at/above phaseEnd
  phaseStart: string;
  phaseEnd: string;
  // slope = (max - min) / (phaseEnd - phaseStart), kept as an exact fraction
  slopeNum: string;
  slopeDen: string;
}

export interface FederalRates {
  brackets: TaxBracket[];
  lowestRate: string;
  bpaf: BpaPhaseOut;
  cea: string;                     // Canada Employment Amount (K4)
  lcf: { cap: string; rate: string };
  abatementQc: string;             // Quebec abatement on T3
  outsideCanadaSurtax: string;     // 48% federal surtax (province ZZ)
  claimCodes: string[];            // TC for claim codes 1..10 (code 0 = 0)
}

export interface PensionPlanRates {
  ympe: string;
  yampe: string;
  basicExemption: string;
  totalRate: string;   // base + first additional (C excludes C2)
  maxTotal: string;
  baseRate: string;    // credit share (K2)
  maxBase: string;
  addlRate: string;    // first additional (F5 share of C)
  maxAddl: string;
  cpp2Rate: string;    // second additional, YMPE→YAMPE band
  maxCpp2: string;
}

export interface EiRates {
  mie: string;
  employeeRate: string;
  maxEmployee: string;
  qcEmployeeRate: string;
  qcMaxEmployee: string;
  employerMultiple: string; // 1.4 unless a reduced-rate program applies
}

export interface QpipRates {
  mie: string;
  employeeRate: string;
  maxEmployee: string;
  employerRate: string;
  maxEmployer: string;
}

export interface ProvincialRates {
  brackets: TaxBracket[];
  lowestRate: string;
  /** TD1 default when none filed: a flat amount or a formula BPA. */
  tcpDefault: string | "BPAF" | "BPAMB";
  claimCodes: string[]; // TCP for claim codes 1..10
  lcp?: { cap: string; rate: string };
  /** Ontario surtax V1. */
  surtax?: { thresholds: [string, string]; rates: [string, string] };
  /** Ontario Health Premium V2 applies. */
  healthPremium?: boolean;
  /** Ontario tax reduction S: 2×(basic + Y) − (T4+V1), Y = perDependant × counts. */
  ontarioReduction?: { basic: string; perDependant: string };
  /** BC tax reduction S: lesser(T4, basic − (A − phaseStart) × phaseRate), 0 past phaseEnd. */
  bcReduction?: { basic: string; phaseStart: string; phaseEnd: string; phaseRate: string };
  /** Alberta K5P = ((K1P + K2P) − threshold) × rate, floor 0. */
  k5p?: { threshold: string; rate: string };
  /** Yukon K4P (Canada employment amount at the provincial lowest rate). */
  hasK4p?: boolean;
}

export interface EditionRates {
  year: number;
  edition: number;          // 122 | 123
  effectiveFrom: string;    // ISO date
  federal: FederalRates;
  cpp: PensionPlanRates;
  qpp: PensionPlanRates;
  ei: EiRates;
  qpip: QpipRates;
  provinces: Partial<Record<Province, ProvincialRates>>;
}

const FEDERAL_2026: FederalRates = {
  brackets: [
    { upTo: "58523", rate: "0.14", k: "0" },
    { upTo: "117045", rate: "0.205", k: "3804" },
    { upTo: "181440", rate: "0.26", k: "10241" },
    { upTo: "258482", rate: "0.29", k: "15685" },
    { upTo: null, rate: "0.33", k: "26024" },
  ],
  lowestRate: "0.14",
  bpaf: {
    max: "16452", min: "14829",
    phaseStart: "181440", phaseEnd: "258482",
    slopeNum: "1623", slopeDen: "77042",
  },
  cea: "1501",
  lcf: { cap: "750", rate: "0.15" },
  abatementQc: "0.165",
  outsideCanadaSurtax: "0.48",
  claimCodes: [
    "16452.00", "17868.50", "20701.50", "23534.50", "26367.50",
    "29200.50", "32033.50", "34866.50", "37699.50", "40532.50",
  ],
};

const CPP_2026: PensionPlanRates = {
  ympe: "74600", yampe: "85000", basicExemption: "3500",
  totalRate: "0.0595", maxTotal: "4230.45",
  baseRate: "0.0495", maxBase: "3519.45",
  addlRate: "0.0100", maxAddl: "711.00",
  cpp2Rate: "0.04", maxCpp2: "416.00",
};

const QPP_2026: PensionPlanRates = {
  ympe: "74600", yampe: "85000", basicExemption: "3500",
  totalRate: "0.0630", maxTotal: "4479.30",
  baseRate: "0.0530", maxBase: "3768.30",
  addlRate: "0.0100", maxAddl: "711.00",
  cpp2Rate: "0.04", maxCpp2: "416.00",
};

const EI_2026: EiRates = {
  mie: "68900",
  employeeRate: "0.0163", maxEmployee: "1123.07",
  qcEmployeeRate: "0.0130", qcMaxEmployee: "895.70",
  employerMultiple: "1.4",
};

const QPIP_2026: QpipRates = {
  mie: "103000",
  employeeRate: "0.0043", maxEmployee: "442.90",
  employerRate: "0.00602", maxEmployer: "620.06",
};

const BC_CLAIM_CODES = [
  "13216.00", "14703.00", "17677.00", "20651.00", "23625.00",
  "26599.00", "29573.00", "32547.00", "35521.00", "38495.00",
];

const PROVINCES_2026_JAN: Partial<Record<Province, ProvincialRates>> = {
  AB: {
    brackets: [
      { upTo: "61200", rate: "0.08", k: "0" },
      { upTo: "154259", rate: "0.10", k: "1224" },
      { upTo: "185111", rate: "0.12", k: "4309" },
      { upTo: "246813", rate: "0.13", k: "6160" },
      { upTo: "370220", rate: "0.14", k: "8628" },
      { upTo: null, rate: "0.15", k: "12331" },
    ],
    lowestRate: "0.08",
    tcpDefault: "22769",
    claimCodes: [
      "22769.00", "24397.50", "27654.50", "30911.50", "34168.50",
      "37425.50", "40682.50", "43939.50", "47196.50", "50453.50",
    ],
    k5p: { threshold: "4896", rate: "0.25" },
  },
  BC: {
    brackets: [
      { upTo: "50363", rate: "0.0506", k: "0" },
      { upTo: "100728", rate: "0.077", k: "1330" },
      { upTo: "115648", rate: "0.105", k: "4150" },
      { upTo: "140430", rate: "0.1229", k: "6220" },
      { upTo: "190405", rate: "0.147", k: "9604" },
      { upTo: "265545", rate: "0.168", k: "13603" },
      { upTo: null, rate: "0.205", k: "23428" },
    ],
    lowestRate: "0.0506",
    tcpDefault: "13216",
    claimCodes: BC_CLAIM_CODES,
    bcReduction: { basic: "575", phaseStart: "25570", phaseEnd: "41722", phaseRate: "0.0356" },
  },
  MB: {
    brackets: [
      { upTo: "47000", rate: "0.108", k: "0" },
      { upTo: "100000", rate: "0.1275", k: "917" },
      { upTo: null, rate: "0.174", k: "5567" },
    ],
    lowestRate: "0.108",
    tcpDefault: "BPAMB",
    claimCodes: [
      "15780.00", "16626.50", "18319.50", "20012.50", "21705.50",
      "23398.50", "25091.50", "26784.50", "28477.50", "30170.50",
    ],
    lcp: { cap: "1800", rate: "0.15" },
  },
  NB: {
    brackets: [
      { upTo: "52333", rate: "0.094", k: "0" },
      { upTo: "104666", rate: "0.14", k: "2407" },
      { upTo: "193861", rate: "0.16", k: "4501" },
      { upTo: null, rate: "0.195", k: "11286" },
    ],
    lowestRate: "0.094",
    tcpDefault: "13664",
    claimCodes: [
      "13664.00", "15062.50", "17859.50", "20656.50", "23453.50",
      "26250.50", "29047.50", "31844.50", "34641.50", "37438.50",
    ],
    lcp: { cap: "2000", rate: "0.20" },
  },
  NL: {
    brackets: [
      { upTo: "44678", rate: "0.087", k: "0" },
      { upTo: "89354", rate: "0.145", k: "2591" },
      { upTo: "159528", rate: "0.158", k: "3753" },
      { upTo: "223340", rate: "0.178", k: "6943" },
      { upTo: "285319", rate: "0.198", k: "11410" },
      { upTo: "570638", rate: "0.208", k: "14263" },
      { upTo: "1141275", rate: "0.213", k: "17117" },
      { upTo: null, rate: "0.218", k: "22823" },
    ],
    lowestRate: "0.087",
    tcpDefault: "11188",
    claimCodes: [
      "11188.00", "12396.00", "14812.00", "17228.00", "19644.00",
      "22060.00", "24476.00", "26892.00", "29308.00", "31724.00",
    ],
  },
  NS: {
    brackets: [
      { upTo: "30995", rate: "0.0879", k: "0" },
      { upTo: "61991", rate: "0.1495", k: "1909" },
      { upTo: "97417", rate: "0.1667", k: "2976" },
      { upTo: "157124", rate: "0.175", k: "3784" },
      { upTo: null, rate: "0.21", k: "9283" },
    ],
    lowestRate: "0.0879",
    tcpDefault: "11932",
    claimCodes: [
      "11932.00", "12770.00", "14446.00", "16122.00", "17798.00",
      "19474.00", "21150.00", "22826.00", "24502.00", "26178.00",
    ],
    lcp: { cap: "2000", rate: "0.20" },
  },
  NT: {
    brackets: [
      { upTo: "53003", rate: "0.059", k: "0" },
      { upTo: "106009", rate: "0.086", k: "1431" },
      { upTo: "172346", rate: "0.122", k: "5247" },
      { upTo: null, rate: "0.1405", k: "8436" },
    ],
    lowestRate: "0.059",
    tcpDefault: "18198",
    claimCodes: [
      "18198.00", "19762.50", "22891.50", "26020.50", "29149.50",
      "32278.50", "35407.50", "38536.50", "41665.50", "44794.50",
    ],
  },
  NU: {
    brackets: [
      { upTo: "55801", rate: "0.04", k: "0" },
      { upTo: "111602", rate: "0.07", k: "1674" },
      { upTo: "181439", rate: "0.09", k: "3906" },
      { upTo: null, rate: "0.115", k: "8442" },
    ],
    lowestRate: "0.04",
    tcpDefault: "19659",
    claimCodes: [
      "19659.00", "21248.50", "24427.50", "27606.50", "30785.50",
      "33964.50", "37143.50", "40322.50", "43501.50", "46680.50",
    ],
  },
  ON: {
    brackets: [
      { upTo: "53891", rate: "0.0505", k: "0" },
      { upTo: "107785", rate: "0.0915", k: "2210" },
      { upTo: "150000", rate: "0.1116", k: "4376" },
      { upTo: "220000", rate: "0.1216", k: "5876" },
      { upTo: null, rate: "0.1316", k: "8076" },
    ],
    lowestRate: "0.0505",
    tcpDefault: "12989",
    claimCodes: [
      "12989.00", "14388.00", "17186.00", "19984.00", "22782.00",
      "25580.00", "28378.00", "31176.00", "33974.00", "36772.00",
    ],
    surtax: { thresholds: ["5818", "7446"], rates: ["0.20", "0.36"] },
    healthPremium: true,
    ontarioReduction: { basic: "300", perDependant: "554" },
  },
  PE: {
    brackets: [
      { upTo: "33928", rate: "0.095", k: "0" },
      { upTo: "65820", rate: "0.1347", k: "1347" },
      { upTo: "106890", rate: "0.166", k: "3407" },
      { upTo: "142520", rate: "0.1762", k: "4497" },
      { upTo: null, rate: "0.19", k: "6464" },
    ],
    lowestRate: "0.095",
    tcpDefault: "15000",
    claimCodes: [
      "15000.00", "15800.00", "17400.00", "19000.00", "20600.00",
      "22200.00", "23800.00", "25400.00", "27000.00", "28600.00",
    ],
  },
  SK: {
    brackets: [
      { upTo: "54532", rate: "0.105", k: "0" },
      { upTo: "155805", rate: "0.125", k: "1091" },
      { upTo: null, rate: "0.145", k: "4207" },
    ],
    lowestRate: "0.105",
    tcpDefault: "20381",
    claimCodes: [
      "20381.00", "21627.50", "24120.50", "26613.50", "29106.50",
      "31599.50", "34092.50", "36585.50", "39078.50", "41571.50",
    ],
    lcp: { cap: "875", rate: "0.175" },
  },
  YT: {
    brackets: [
      { upTo: "58523", rate: "0.064", k: "0" },
      { upTo: "117045", rate: "0.09", k: "1522" },
      { upTo: "181440", rate: "0.109", k: "3745" },
      { upTo: "500000", rate: "0.128", k: "7193" },
      { upTo: null, rate: "0.15", k: "18193" },
    ],
    lowestRate: "0.064",
    tcpDefault: "BPAF",
    claimCodes: FEDERAL_2026.claimCodes,
    hasK4p: true,
  },
  // QC: provincial income tax is administered by Revenu Québec (TP-1015);
  // T4127 covers only the federal side (abatement, K2Q, QPP/QPIP).
};

export const RATES_2026_JAN: EditionRates = {
  year: 2026,
  edition: 122,
  effectiveFrom: "2026-01-01",
  federal: FEDERAL_2026,
  cpp: CPP_2026,
  qpp: QPP_2026,
  ei: EI_2026,
  qpip: QPIP_2026,
  provinces: PROVINCES_2026_JAN,
};

/** 123rd edition: only BC, NL, PE changed (Option-1 prorated for Jul–Dec). */
export const RATES_2026_JUL: EditionRates = {
  ...RATES_2026_JAN,
  edition: 123,
  effectiveFrom: "2026-07-01",
  provinces: {
    ...PROVINCES_2026_JAN,
    BC: {
      ...PROVINCES_2026_JAN.BC!,
      brackets: [
        { upTo: "50363", rate: "0.0614", k: "0" },
        { upTo: "100728", rate: "0.077", k: "786" },
        { upTo: "115648", rate: "0.105", k: "3606" },
        { upTo: "140430", rate: "0.1229", k: "5676" },
        { upTo: "190405", rate: "0.147", k: "9061" },
        { upTo: "265545", rate: "0.168", k: "13059" },
        { upTo: null, rate: "0.205", k: "22884" },
      ],
      lowestRate: "0.0614",
      bcReduction: { basic: "805", phaseStart: "25570", phaseEnd: "44952", phaseRate: "0.0356" },
    },
    NL: {
      ...PROVINCES_2026_JAN.NL!,
      tcpDefault: "15000",
      claimCodes: [
        "15000.00", "16208.00", "18624.00", "21040.00", "23456.00",
        "25872.00", "28288.00", "30704.00", "33120.00", "35536.00",
      ],
    },
    PE: {
      ...PROVINCES_2026_JAN.PE!,
      brackets: [
        { upTo: "33928", rate: "0.095", k: "0" },
        { upTo: "65820", rate: "0.1347", k: "1347" },
        { upTo: "106890", rate: "0.166", k: "3407" },
        { upTo: "142520", rate: "0.1762", k: "4497" },
        { upTo: "200000", rate: "0.19", k: "6464" },
        { upTo: null, rate: "0.21", k: "10464" },
      ],
    },
  },
};

const EDITIONS: EditionRates[] = [RATES_2026_JUL, RATES_2026_JAN];

/** Resolve the T4127 edition in force on a pay date. */
export function ratesForPayDate(payDate: string): EditionRates {
  const edition = EDITIONS.find((e) => payDate >= e.effectiveFrom);
  if (!edition || payDate >= "2027-01-01") {
    throw new Error(
      `no T4127 constants for pay date ${payDate} — add the edition to engine/src/payroll/canada/rates.ts`,
    );
  }
  return edition;
}

/**
 * CPP per-period basic exemption ($3,500/P, truncated). Table 6.1 canonical
 * values for the standard frequencies; truncation for anything else.
 */
export const CPP_EXEMPTION_BY_P: Record<number, string> = {
  1: "3500.00", 2: "1750.00", 4: "875.00", 10: "350.00", 12: "291.66",
  13: "269.23", 22: "159.09", 24: "145.83", 26: "134.61", 27: "129.62",
  52: "67.30", 53: "66.03", 240: "14.58", 2000: "1.75",
};

/** TD1 claim code → total claim amount (code 0 = no claim; code 1 = the BPA). */
export function claimCodeAmount(codes: string[], code: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 10) {
    throw new Error(`claim code must be an integer 0..10, got ${code}`);
  }
  return code === 0 ? "0" : codes[code - 1]!;
}
