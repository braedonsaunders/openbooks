/**
 * CRA T4127 payroll deductions constants for 2025.
 *
 * Sources (fetched from canada.ca, not memory):
 *   120th edition, effective January 1, 2025 (T4127(E) Rev. 25 (24)):
 *     canada.ca/.../t4127-payroll-deductions-formulas/t4127-jan.html
 *     plus the machine-readable CSVs
 *     canada.ca/content/dam/cra-arc/formspubs/pub/t4127-jan/*-01-25e.csv
 *     (claim codes cc-{fd,ab,bc,mb,nb,nl,ns,nt,nu,on,pei,sk,yt}-01-25e.csv,
 *     cpp-qpp-{br,addntl,scnd-addntl,ttl}-01-25e.csv, ei-01-25e.csv,
 *     qpip-01-25e.csv, thrrtsmnts-01-25e.csv, rtsncmtrshldcnstnt-01-25e.csv).
 *   121st edition, effective July 1, 2025 (T4127(E) Rev. 25 (25/05)):
 *     canada.ca/.../t4127-payroll-deductions-formulas/t4127-jul.html
 *     plus t4127-jul/*-07-25e.csv (claim codes cc-{fd,ab,mb,ns,pe,sk}-07-25e.csv,
 *     rates-income-thresholds-constants-25e.csv, other-rates-amounts-25e.csv).
 *
 * The July edition is a delta: only Federal, AB, MB, NS, PE, SK change
 * (Option-1 prorated for Jul–Dec). Everything else carries forward from the
 * 120th unchanged, exactly as the 2026 pair does.
 *
 * Cross-verification (part of transcription, 2026-09-20):
 *   - Every province's K/KP chain reproduces under round-half-up running
 *     totals (AB Jan: 3024.68→3025, 4839.49→4839, 7259.23→7259,
 *     10888.84→10889; NL 8-bracket chain to 22575; NU K4 8276.495→8276…).
 *   - Federal July K is NOT naive-cumulative: the July constants offset six
 *     months already withheld at 15%, so K(Jul) = 2×K(full-year at 14%) −
 *     K(Jan), rounded: K2 = 2×3728.75−3155.625 = 4301.875… verified instead as
 *     K2 = 3729, K3 = 2×9753.75−9467 = 10040.50→10041,
 *     K4 = 2×15090.21−14803 = 15377.42→15377,
 *     K5 = 2×25226.77−24940 = 25513.54→25514. All four match the published
 *     rates-income-thresholds-constants-25e.csv exactly.
 *   - July claim-code K1/K1P all reproduce as TC×prorated-rate half-up
 *     (AB 22323×0.06 = 1339.38; MB 15591×0.108 = 1683.83; …).
 *   - CPP/QPP maxima consistent with rates and YMPE/YAMPE
 *     (67800×0.0595 = 4034.10; 67800×0.064 = 4339.20; 9900×0.04 = 396.00).
 *   - SOURCE QUIRK (January NS table): even claim codes print K1P 1¢ below
 *     the formula value (CC2: 12569×0.0879 = 1104.8151, table says 1104.81;
 *     CC10: 25769×0.0879 = 2265.0951, table says 2265.09), while CC1
 *     (1032.2976→1032.30) needs round-up — no single rounding rule produces
 *     the January column. The July table prints the formula values
 *     (1104.82, 2265.10). This module stores TCP amounts (identical in both
 *     editions); the engine computes K1P by the formula, matching July.
 */
import type { EditionRates, ProvincialRates, Province } from "./rates.ts";

/** January federal claim-code TC amounts, codes 1..10 (cc-fd-01-25e.csv). */
const FEDERAL_TC_2025 = [
  "16129.00", "17518.00", "20296.00", "23074.00", "25852.00",
  "28630.00", "31408.00", "34186.00", "36964.00", "39742.00",
];

/** January AB / July AB share one TCP chart (only the rate is prorated). */
const AB_TCP_2025 = [
  "22323.00", "23919.50", "27112.50", "30305.50", "33498.50",
  "36691.50", "39884.50", "43077.50", "46270.50", "49463.50",
];

/** January NS / July NS share one TCP chart (the BPANS catch-up is in K1P). */
const NS_TCP_2025 = [
  "11744.00", "12569.00", "14219.00", "15869.00", "17519.00",
  "19169.00", "20819.00", "22469.00", "24119.00", "25769.00",
];

const PROVINCES_2025_JAN: Partial<Record<Province, ProvincialRates>> = {
  AB: {
    brackets: [
      { upTo: "151234", rate: "0.10", k: "0" },
      { upTo: "181481", rate: "0.12", k: "3025" },
      { upTo: "241974", rate: "0.13", k: "4839" },
      { upTo: "362961", rate: "0.14", k: "7259" },
      { upTo: null, rate: "0.15", k: "10889" },
    ],
    lowestRate: "0.10",
    tcpDefault: "22323",
    claimCodes: AB_TCP_2025,
    // No K5P in January: the supplemental credit arrives with the July
    // edition's new 8% bracket (see RATES_2025_JUL).
  },
  BC: {
    brackets: [
      { upTo: "49279", rate: "0.0506", k: "0" },
      { upTo: "98560", rate: "0.077", k: "1301" },
      { upTo: "113158", rate: "0.105", k: "4061" },
      { upTo: "137407", rate: "0.1229", k: "6086" },
      { upTo: "186306", rate: "0.147", k: "9398" },
      { upTo: "259829", rate: "0.168", k: "13310" },
      { upTo: null, rate: "0.205", k: "22924" },
    ],
    lowestRate: "0.0506",
    tcpDefault: "12932",
    claimCodes: [
      "12932.00", "14387.00", "17297.00", "20207.00", "23117.00",
      "26027.00", "28937.00", "31847.00", "34757.00", "37667.00",
    ],
    bcReduction: { basic: "562", phaseStart: "25020", phaseEnd: "40807", phaseRate: "0.0356" },
  },
  MB: {
    brackets: [
      { upTo: "47564", rate: "0.108", k: "0" },
      { upTo: "101200", rate: "0.1275", k: "927" },
      { upTo: null, rate: "0.174", k: "5633" },
    ],
    lowestRate: "0.108",
    tcpDefault: "BPAMB",
    // 120th ed. Ch. 2: BPAMB = $15,969, phased to $0 over $200,000–$400,000.
    bpamb: {
      max: "15969", min: "0",
      phaseStart: "200000", phaseEnd: "400000",
      slopeNum: "15969", slopeDen: "200000",
    },
    claimCodes: [
      "15969.00", "16815.50", "18508.50", "20201.50", "21894.50",
      "23587.50", "25280.50", "26973.50", "28666.50", "30359.50",
    ],
    lcp: { cap: "1800", rate: "0.15" },
  },
  NB: {
    brackets: [
      { upTo: "51306", rate: "0.094", k: "0" },
      { upTo: "102614", rate: "0.14", k: "2360" },
      { upTo: "190060", rate: "0.16", k: "4412" },
      { upTo: null, rate: "0.195", k: "11286" },
    ],
    lowestRate: "0.094",
    tcpDefault: "13396",
    claimCodes: [
      "13396.00", "14767.50", "17510.50", "20253.50", "22996.50",
      "25739.50", "28482.50", "31225.50", "33968.50", "36711.50",
    ],
    lcp: { cap: "2000", rate: "0.20" },
  },
  NL: {
    brackets: [
      { upTo: "44192", rate: "0.087", k: "0" },
      { upTo: "88382", rate: "0.145", k: "2563" },
      { upTo: "157792", rate: "0.158", k: "3712" },
      { upTo: "220910", rate: "0.178", k: "6868" },
      { upTo: "282214", rate: "0.198", k: "11286" },
      { upTo: "564429", rate: "0.208", k: "14108" },
      { upTo: "1128858", rate: "0.213", k: "16930" },
      { upTo: null, rate: "0.218", k: "22575" },
    ],
    lowestRate: "0.087",
    tcpDefault: "11067",
    claimCodes: [
      "11067.00", "12262.00", "14652.00", "17042.00", "19432.00",
      "21822.00", "24212.00", "26602.00", "28992.00", "31382.00",
    ],
  },
  NS: {
    brackets: [
      { upTo: "30507", rate: "0.0879", k: "0" },
      { upTo: "61015", rate: "0.1495", k: "1879" },
      { upTo: "95883", rate: "0.1667", k: "2929" },
      { upTo: "154650", rate: "0.175", k: "3725" },
      { upTo: null, rate: "0.21", k: "9137" },
    ],
    lowestRate: "0.0879",
    // Flat 11,744 (the maximum BPANS): the engine models no BPANS formula in
    // any year — the same level as the landed 2026 module. The January BPANS
    // formula (11,744 − (A−25,000)×6%, floor 8,744) and the July catch-up
    // formula (+6%, cap 14,744) refine high earners only.
    tcpDefault: "11744",
    claimCodes: NS_TCP_2025,
    lcp: { cap: "2000", rate: "0.20" },
  },
  NT: {
    brackets: [
      { upTo: "51964", rate: "0.059", k: "0" },
      { upTo: "103930", rate: "0.086", k: "1403" },
      { upTo: "168967", rate: "0.122", k: "5145" },
      { upTo: null, rate: "0.1405", k: "8270" },
    ],
    lowestRate: "0.059",
    tcpDefault: "17842",
    claimCodes: [
      "17842.00", "19376.00", "22444.00", "25512.00", "28580.00",
      "31648.00", "34716.00", "37784.00", "40852.00", "43920.00",
    ],
  },
  NU: {
    brackets: [
      { upTo: "54707", rate: "0.04", k: "0" },
      { upTo: "109413", rate: "0.07", k: "1641" },
      { upTo: "177881", rate: "0.09", k: "3829" },
      { upTo: null, rate: "0.115", k: "8276" },
    ],
    lowestRate: "0.04",
    tcpDefault: "19274",
    claimCodes: [
      "19274.00", "20832.50", "23949.50", "27066.50", "30183.50",
      "33300.50", "36417.50", "39534.50", "42651.50", "45768.50",
    ],
  },
  ON: {
    brackets: [
      { upTo: "52886", rate: "0.0505", k: "0" },
      { upTo: "105775", rate: "0.0915", k: "2210" },
      { upTo: "150000", rate: "0.1116", k: "4376" },
      { upTo: "220000", rate: "0.1216", k: "5876" },
      { upTo: null, rate: "0.1316", k: "8076" },
    ],
    lowestRate: "0.0505",
    tcpDefault: "12747",
    claimCodes: [
      "12747.00", "14120.00", "16866.00", "19612.00", "22358.00",
      "25104.00", "27850.00", "30596.00", "33342.00", "36088.00",
    ],
    surtax: { thresholds: ["5710", "7307"], rates: ["0.20", "0.36"] },
    healthPremium: true,
    ontarioReduction: { basic: "294", perDependant: "544" },
  },
  PE: {
    brackets: [
      { upTo: "33328", rate: "0.095", k: "0" },
      { upTo: "64656", rate: "0.1347", k: "1323" },
      { upTo: "105000", rate: "0.166", k: "3407" },
      { upTo: "140000", rate: "0.1762", k: "4418" },
      { upTo: null, rate: "0.19", k: "6350" },
    ],
    lowestRate: "0.095",
    tcpDefault: "14250",
    claimCodes: [
      "14250.00", "15050.00", "16650.00", "18250.00", "19850.00",
      "21450.00", "23050.00", "24650.00", "26250.00", "27850.00",
    ],
  },
  SK: {
    brackets: [
      { upTo: "53463", rate: "0.105", k: "0" },
      { upTo: "152750", rate: "0.125", k: "1069" },
      { upTo: null, rate: "0.145", k: "4124" },
    ],
    lowestRate: "0.105",
    tcpDefault: "18991",
    claimCodes: [
      "18991.00", "20213.00", "22657.00", "25101.00", "27545.00",
      "29899.00", "32433.00", "34877.00", "37321.00", "39765.00",
    ],
    lcp: { cap: "875", rate: "0.175" },
  },
  YT: {
    brackets: [
      { upTo: "57375", rate: "0.064", k: "0" },
      { upTo: "114750", rate: "0.09", k: "1492" },
      { upTo: "177882", rate: "0.109", k: "3672" },
      { upTo: "500000", rate: "0.128", k: "7052" },
      { upTo: null, rate: "0.15", k: "18193" },
    ],
    lowestRate: "0.064",
    tcpDefault: "BPAF",
    claimCodes: FEDERAL_TC_2025,
    hasK4p: true,
  },
  // QC: provincial income tax is administered by Revenu Québec (TP-1015) —
  // transcribed in ./quebec/rates-2025.ts, not here.
};

export const RATES_2025_JAN: EditionRates = {
  year: 2025,
  edition: 120,
  effectiveFrom: "2025-01-01",
  status: "published",
  federal: {
    brackets: [
      { upTo: "57375", rate: "0.15", k: "0" },
      { upTo: "114750", rate: "0.205", k: "3156" },
      { upTo: "177882", rate: "0.26", k: "9467" },
      { upTo: "253414", rate: "0.29", k: "14803" },
      { upTo: null, rate: "0.33", k: "24940" },
    ],
    lowestRate: "0.15",
    // 120th ed. Ch. 2: BPAF = $16,129, phased to $14,538 over
    // $177,882–$253,414 (slopes exact: 16129−14538 = 1591;
    // 253414−177882 = 75532; "no rounding on this division").
    bpaf: {
      max: "16129", min: "14538",
      phaseStart: "177882", phaseEnd: "253414",
      slopeNum: "1591", slopeDen: "75532",
    },
    cea: "1471",
    lcf: { cap: "750", rate: "0.15" },
    abatementQc: "0.165",
    outsideCanadaSurtax: "0.48",
    claimCodes: FEDERAL_TC_2025,
  },
  cpp: {
    ympe: "71300", yampe: "81200", basicExemption: "3500",
    totalRate: "0.0595", maxTotal: "4034.10",
    baseRate: "0.0495", maxBase: "3356.10",
    addlRate: "0.0100", maxAddl: "678.00",
    cpp2Rate: "0.04", maxCpp2: "396.00",
  },
  qpp: {
    ympe: "71300", yampe: "81200", basicExemption: "3500",
    totalRate: "0.064", maxTotal: "4339.20",
    baseRate: "0.054", maxBase: "3661.20",
    addlRate: "0.0100", maxAddl: "678.00",
    cpp2Rate: "0.04", maxCpp2: "396.00",
  },
  ei: {
    mie: "65700",
    employeeRate: "0.0164", maxEmployee: "1077.48",
    qcEmployeeRate: "0.0131", qcMaxEmployee: "860.67",
    employerMultiple: "1.4",
  },
  qpip: {
    mie: "98000",
    employeeRate: "0.00494", maxEmployee: "484.12",
    employerRate: "0.00692", maxEmployer: "678.16",
  },
  provinces: PROVINCES_2025_JAN,
};

/**
 * 121st edition: Federal, AB, MB, PE, SK change (Option-1 prorated for
 * Jul–Dec); NS restates its claim-code K1P column at the formula values.
 * "Please refer to the 120th edition for any sections that have not been
 * reproduced" — so everything else spreads forward from RATES_2025_JAN.
 */
export const RATES_2025_JUL: EditionRates = {
  ...RATES_2025_JAN,
  edition: 121,
  effectiveFrom: "2025-07-01",
  federal: {
    ...RATES_2025_JAN.federal,
    brackets: [
      { upTo: "57375", rate: "0.14", k: "0" },
      { upTo: "114750", rate: "0.205", k: "3729" },
      { upTo: "177882", rate: "0.26", k: "10041" },
      { upTo: "253414", rate: "0.29", k: "15377" },
      { upTo: null, rate: "0.33", k: "25514" },
    ],
    lowestRate: "0.14",
    // BPAF is NOT restated: the July Table 8.9 is "using maximum BPAF and
    // prorated tax rate" (TC chart identical, K1 = TC × 0.14).
  },
  provinces: {
    ...PROVINCES_2025_JAN,
    AB: {
      ...PROVINCES_2025_JAN.AB!,
      brackets: [
        { upTo: "60000", rate: "0.06", k: "0" },
        { upTo: "151234", rate: "0.10", k: "2400" },
        { upTo: "181481", rate: "0.12", k: "5425" },
        { upTo: "241974", rate: "0.13", k: "7239" },
        { upTo: "362961", rate: "0.14", k: "9659" },
        { upTo: null, rate: "0.15", k: "13289" },
      ],
      lowestRate: "0.06",
      // 121st ed. "What's new": K5P = ((K1P + K2P) − $3,600.00) × (0.04/0.06).
      // 0.04/0.06 = 2/3 repeating; the engine multiplies at 6-decimal rate
      // precision, and "0.666667" is provably cent-exact for every real input:
      // K1P/K2P/threshold are all cent-quantized, and for any integer number
      // of cents C, C×2/3 lands on a whole or third-cent (never within the
      // 0.0033¢ band where the 7th-decimal truncation could flip rounding).
      k5p: { threshold: "3600", rate: "0.666667" },
    },
    MB: {
      ...PROVINCES_2025_JAN.MB!,
      brackets: [
        { upTo: "46513", rate: "0.108", k: "0" },
        { upTo: "98796", rate: "0.1275", k: "907" },
        { upTo: null, rate: "0.174", k: "5501" },
      ],
      // 121st ed. Ch. 2: prorated BPAMB = $15,591, same $200,000–$400,000
      // phase-out ("$15,591 – (NI* – $200,000) × ($15,591/$200,000)").
      bpamb: {
        max: "15591", min: "0",
        phaseStart: "200000", phaseEnd: "400000",
        slopeNum: "15591", slopeDen: "200000",
      },
      claimCodes: [
        "15591.00", "16437.50", "18130.50", "19823.50", "21516.50",
        "23209.50", "24902.50", "26595.50", "28288.50", "29981.50",
      ],
    },
    PE: {
      ...PROVINCES_2025_JAN.PE!,
      // Prorated BPA $15,050 (April 10 announcement: $14,250 → $14,650
      // retroactive to Jan 1; July chart catches up the first-half shortfall).
      tcpDefault: "15050",
      claimCodes: [
        "15050.00", "15850.00", "17450.00", "19050.00", "20650.00",
        "22250.00", "23850.00", "25450.00", "27050.00", "28650.00",
      ],
    },
    SK: {
      ...PROVINCES_2025_JAN.SK!,
      // Prorated BPA $19,991 (Dec 5, 2024 announcement: $18,491 → $19,491
      // retroactive to Jan 1).
      tcpDefault: "19991",
      claimCodes: [
        "19991.00", "21213.00", "23657.00", "26101.00", "28545.00",
        "30989.00", "33433.00", "35877.00", "38321.00", "40765.00",
      ],
    },
  },
};
