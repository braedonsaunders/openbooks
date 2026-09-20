/**
 * CRA T4127 payroll deductions constants for 2024.
 *
 * Sources (fetched from canada.ca, not memory):
 *   119th edition, effective January 1, 2024 (T4127(E) Rev. 24 (23/11)):
 *     canada.ca/.../t4127-payroll-deductions-formulas/t4127-jan.html
 *     plus the machine-readable CSVs
 *     canada.ca/content/dam/cra-arc/formspubs/pub/t4127-jan/*-01-24e.csv
 *     (claim codes cc-{fd,ab,bc,mb,nb,nl,ns,nt,nu,on,pei,sk,yt}-01-24e.csv,
 *     cpp-qpp-{br,addntl,scnd-addntl,ttl}-01-24e.csv, ei-01-24e.csv,
 *     qpip-01-24e.csv, thrrtsmnts-01-24e.csv, rtsncmtrshldcnstnt-01-24e.csv).
 *
 * 2024 is a single-edition year: no July delta was issued (the 119th is
 * followed directly by the 120th, January 2025), so one module covers the
 * whole year.
 *
 * Cross-verification (part of transcription, 2026-09-20):
 *   - Every federal and provincial K/KP chain reproduces under round-half-up
 *     running totals (Federal: 3072.685→3073, 9218.00→9218, 14414.15→14414,
 *     24284.23→24284; MB: 916.50→917, 5566.50→5567; NL 8-bracket chain to
 *     22067; PE: 1299.7088→1300, 3241.9614→3242, 4659.4614→4659,
 *     5709.4614→5709; YT K5 17866.364→17866…).
 *   - All claim-code K1/K1P reproduce as TC×lowest-rate half-up, including
 *     the half-cent claims (federal CC3: 19762.50×0.15 = 2964.375→2964.38).
 *   - CPP/QPP maxima consistent with rates and YMPE/YAMPE
 *     (65000×0.0595 = 3867.50; 65000×0.064 = 4160.00; 4700×0.04 = 188.00).
 *   - Manitoba has NO BPAMB formula in 2024 (the 200,000–400,000 phase-out
 *     was announced April 2, 2024, effective 2025): tcpDefault is the flat
 *     $15,780, with no `bpamb` field — the formula path must never trigger
 *     for 2024 (pinned by the high-income golden in rates-2024.test.ts).
 */
import type { EditionRates, ProvincialRates, Province } from "./rates.ts";

/** Federal claim-code TC amounts, codes 1..10 (cc-fd-01-24e.csv). */
const FEDERAL_TC_2024 = [
  "15705.00", "17057.50", "19762.50", "22467.50", "25172.50",
  "27877.50", "30582.50", "33287.50", "35992.50", "38697.50",
];

const PROVINCES_2024_JAN: Partial<Record<Province, ProvincialRates>> = {
  AB: {
    brackets: [
      { upTo: "148269", rate: "0.10", k: "0" },
      { upTo: "177922", rate: "0.12", k: "2965" },
      { upTo: "237230", rate: "0.13", k: "4745" },
      { upTo: "355845", rate: "0.14", k: "7117" },
      { upTo: null, rate: "0.15", k: "10675" },
    ],
    lowestRate: "0.10",
    tcpDefault: "21885",
    claimCodes: [
      "21885.00", "23450.00", "26580.00", "29710.00", "32840.00",
      "35970.00", "39100.00", "42230.00", "45360.00", "48490.00",
    ],
  },
  BC: {
    brackets: [
      { upTo: "47937", rate: "0.0506", k: "0" },
      { upTo: "95875", rate: "0.077", k: "1266" },
      { upTo: "110076", rate: "0.105", k: "3950" },
      { upTo: "133664", rate: "0.1229", k: "5920" },
      { upTo: "181232", rate: "0.147", k: "9142" },
      { upTo: "252752", rate: "0.168", k: "12948" },
      { upTo: null, rate: "0.205", k: "22299" },
    ],
    lowestRate: "0.0506",
    tcpDefault: "12580",
    claimCodes: [
      "12580.00", "13995.50", "16826.50", "19657.50", "22488.50",
      "25319.50", "28150.50", "30981.50", "33812.50", "36643.50",
    ],
    bcReduction: { basic: "547", phaseStart: "24338", phaseEnd: "39703", phaseRate: "0.0356" },
  },
  MB: {
    brackets: [
      { upTo: "47000", rate: "0.108", k: "0" },
      { upTo: "100000", rate: "0.1275", k: "917" },
      { upTo: null, rate: "0.174", k: "5567" },
    ],
    lowestRate: "0.108",
    // Flat $15,780 — see the module header: no BPAMB formula in 2024.
    tcpDefault: "15780",
    claimCodes: [
      "15780.00", "16626.50", "18319.50", "20012.50", "21705.50",
      "23398.50", "25091.50", "26784.50", "28477.50", "30170.50",
    ],
    lcp: { cap: "1800", rate: "0.15" },
  },
  NB: {
    brackets: [
      { upTo: "49958", rate: "0.094", k: "0" },
      { upTo: "99916", rate: "0.14", k: "2298" },
      { upTo: "185064", rate: "0.16", k: "4296" },
      { upTo: null, rate: "0.195", k: "10774" },
    ],
    lowestRate: "0.094",
    tcpDefault: "13044",
    claimCodes: [
      "13044.00", "14379.00", "17049.00", "19719.00", "22389.00",
      "25059.00", "27729.00", "30399.00", "33069.00", "35739.00",
    ],
    lcp: { cap: "2000", rate: "0.20" },
  },
  NL: {
    brackets: [
      { upTo: "43198", rate: "0.087", k: "0" },
      { upTo: "86395", rate: "0.145", k: "2505" },
      { upTo: "154244", rate: "0.158", k: "3629" },
      { upTo: "215943", rate: "0.178", k: "6713" },
      { upTo: "275870", rate: "0.198", k: "11032" },
      { upTo: "551739", rate: "0.208", k: "13791" },
      { upTo: "1103478", rate: "0.213", k: "16550" },
      { upTo: null, rate: "0.218", k: "22067" },
    ],
    lowestRate: "0.087",
    tcpDefault: "10818",
    claimCodes: [
      "10818.00", "11986.00", "14322.00", "16658.00", "18994.00",
      "21330.00", "23666.00", "26002.00", "28338.00", "30674.00",
    ],
  },
  NS: {
    brackets: [
      { upTo: "29590", rate: "0.0879", k: "0" },
      { upTo: "59180", rate: "0.1495", k: "1823" },
      { upTo: "93000", rate: "0.1667", k: "2841" },
      { upTo: "150000", rate: "0.175", k: "3613" },
      { upTo: null, rate: "0.21", k: "8863" },
    ],
    lowestRate: "0.0879",
    // Flat 11,481 (the maximum BPANS): the engine models no BPANS formula in
    // any year — the same level as the landed 2025/2026 modules. The 2024
    // BPANS formula (11,481 − (A−25,000)×6%, floor 8,481) refines high
    // earners only.
    tcpDefault: "11481",
    claimCodes: [
      "11481.00", "12281.00", "13881.00", "15481.00", "17081.00",
      "18681.00", "20281.00", "21881.00", "23481.00", "25081.00",
    ],
    lcp: { cap: "2000", rate: "0.20" },
  },
  NT: {
    brackets: [
      { upTo: "50597", rate: "0.059", k: "0" },
      { upTo: "101198", rate: "0.086", k: "1366" },
      { upTo: "164525", rate: "0.122", k: "5009" },
      { upTo: null, rate: "0.1405", k: "8053" },
    ],
    lowestRate: "0.059",
    tcpDefault: "17373",
    claimCodes: [
      "17373.00", "18866.50", "21853.50", "24840.50", "27827.50",
      "30814.50", "33801.50", "36788.50", "39775.50", "42762.50",
    ],
  },
  NU: {
    brackets: [
      { upTo: "53268", rate: "0.04", k: "0" },
      { upTo: "106537", rate: "0.07", k: "1598" },
      { upTo: "173205", rate: "0.09", k: "3729" },
      { upTo: null, rate: "0.115", k: "8059" },
    ],
    lowestRate: "0.04",
    tcpDefault: "18767",
    claimCodes: [
      "18767.00", "20284.50", "23319.50", "26354.50", "29389.50",
      "32424.50", "35459.50", "38494.50", "41529.50", "44564.50",
    ],
  },
  ON: {
    brackets: [
      { upTo: "51446", rate: "0.0505", k: "0" },
      { upTo: "102894", rate: "0.0915", k: "2109" },
      { upTo: "150000", rate: "0.1116", k: "4177" },
      { upTo: "220000", rate: "0.1216", k: "5677" },
      { upTo: null, rate: "0.1316", k: "7877" },
    ],
    lowestRate: "0.0505",
    tcpDefault: "12399",
    claimCodes: [
      "12399.00", "13734.50", "16405.50", "19076.50", "21747.50",
      "24418.50", "27089.50", "29760.50", "32431.50", "35102.50",
    ],
    surtax: { thresholds: ["5554", "7108"], rates: ["0.20", "0.36"] },
    healthPremium: true,
    ontarioReduction: { basic: "286", perDependant: "529" },
  },
  PE: {
    // New five-bracket system for 2024 (the three-bracket + surtax V1 system
    // is gone — no `surtax` here, and the 119th ed. says so explicitly).
    brackets: [
      { upTo: "32656", rate: "0.0965", k: "0" },
      { upTo: "64313", rate: "0.1363", k: "1300" },
      { upTo: "105000", rate: "0.1665", k: "3242" },
      { upTo: "140000", rate: "0.18", k: "4659" },
      { upTo: null, rate: "0.1875", k: "5709" },
    ],
    lowestRate: "0.0965",
    tcpDefault: "13500",
    claimCodes: [
      "13500.00", "14300.00", "15900.00", "17500.00", "19100.00",
      "20700.00", "22300.00", "23900.00", "25500.00", "27100.00",
    ],
  },
  SK: {
    brackets: [
      { upTo: "52057", rate: "0.105", k: "0" },
      { upTo: "148734", rate: "0.125", k: "1041" },
      { upTo: null, rate: "0.145", k: "4016" },
    ],
    lowestRate: "0.105",
    tcpDefault: "18491",
    claimCodes: [
      "18491.00", "19681.00", "22061.00", "24441.00", "26821.00",
      "29201.00", "31581.00", "33961.00", "36341.00", "38721.00",
    ],
    lcp: { cap: "875", rate: "0.175" },
  },
  YT: {
    brackets: [
      { upTo: "55867", rate: "0.064", k: "0" },
      { upTo: "111733", rate: "0.09", k: "1453" },
      { upTo: "173205", rate: "0.109", k: "3575" },
      { upTo: "500000", rate: "0.128", k: "6866" },
      { upTo: null, rate: "0.15", k: "17866" },
    ],
    lowestRate: "0.064",
    tcpDefault: "BPAF",
    claimCodes: FEDERAL_TC_2024,
    hasK4p: true,
  },
  // QC: provincial income tax is administered by Revenu Québec (TP-1015) —
  // transcribed in ./quebec/rates-2024.ts, not here.
};

export const RATES_2024_JAN: EditionRates = {
  year: 2024,
  edition: 119,
  effectiveFrom: "2024-01-01",
  status: "published",
  federal: {
    brackets: [
      { upTo: "55867", rate: "0.15", k: "0" },
      { upTo: "111733", rate: "0.205", k: "3073" },
      { upTo: "173205", rate: "0.26", k: "9218" },
      { upTo: "246752", rate: "0.29", k: "14414" },
      { upTo: null, rate: "0.33", k: "24284" },
    ],
    lowestRate: "0.15",
    // 119th ed. Ch. 2: BPAF = $15,705, phased to $14,156 over
    // $173,205–$246,752 (slopes exact: 15705−14156 = 1549;
    // 246752−173205 = 73547).
    bpaf: {
      max: "15705", min: "14156",
      phaseStart: "173205", phaseEnd: "246752",
      slopeNum: "1549", slopeDen: "73547",
    },
    cea: "1433",
    lcf: { cap: "750", rate: "0.15" },
    abatementQc: "0.165",
    outsideCanadaSurtax: "0.48",
    claimCodes: FEDERAL_TC_2024,
  },
  cpp: {
    ympe: "68500", yampe: "73200", basicExemption: "3500",
    totalRate: "0.0595", maxTotal: "3867.50",
    baseRate: "0.0495", maxBase: "3217.50",
    addlRate: "0.01", maxAddl: "650.00",
    cpp2Rate: "0.04", maxCpp2: "188.00",
  },
  qpp: {
    ympe: "68500", yampe: "73200", basicExemption: "3500",
    totalRate: "0.064", maxTotal: "4160.00",
    baseRate: "0.054", maxBase: "3510.00",
    addlRate: "0.01", maxAddl: "650.00",
    cpp2Rate: "0.04", maxCpp2: "188.00",
  },
  ei: {
    mie: "63200",
    employeeRate: "0.0166", maxEmployee: "1049.12",
    qcEmployeeRate: "0.0132", qcMaxEmployee: "834.24",
    employerMultiple: "1.4",
  },
  qpip: {
    mie: "94000",
    employeeRate: "0.00494", maxEmployee: "464.36",
    employerRate: "0.00692", maxEmployer: "650.48",
  },
  provinces: PROVINCES_2024_JAN,
};
