/**
 * IE 2026 conformance goldens: every expected figure is the authority's own
 * published number (revenue.ie, gov.ie, DSP SW14) or, where no worked example
 * exists, hand-worked from the transcribed tables with the arithmetic shown.
 * Authority errata are pinned at the exact-arithmetic figure, never absorbed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculateIeStatutory, type IeStatutoryInput, type IeStatutoryResult } from "./compute.ts";

/** `pay` sets taxable and reckonable pay for the period together. */
type Input = Partial<IeStatutoryInput> & { pay?: string };

function run({ pay, ...input }: Input): IeStatutoryResult {
  return calculateIeStatutory({
    payDate: "2026-03-15", periodsPerYear: 52, basis: "cumulative", hasRpn: true,
    taxCreditsAnnual: "4000", rateBandAnnual: "44000", uscCutoffAnnual: "70044",
    taxablePayPeriod: pay ?? "0", taxablePayYtd: "0", taxPaidYtd: "0", reckonablePayPeriod: pay ?? "0",
    grossPayYtd: "0", uscPaidYtd: "0", uscExempt: false, uscReducedEligible: false, prsiClass: "A",
    elapsedPeriods: 1, ...input,
  });
}

const PAYE_EMPLOYER = "Revenue, PAYE employer pages (cumulative / week 1 basis)";
const PAYE_EXPLAINER = "Revenue, 'How your tax is calculated' employee explainer";
const USC_PAGE = "Revenue, 'Calculating USC' page";
const SW14 = "DSP SW14 (2026) weekly PRSI credit table";
const EMPLOYER_GUIDE = "DSP PRSI Employer Guide 2026, four-week table";
const OCTOBER = "gov.ie Budget 2026 PRSI notice: Class A employee 4.2% → 4.35% from 1 October";
const ANNUAL = { payDate: "2026-12-31", elapsedPeriods: 52 } as const;

interface Golden {
  year: number;
  label: string;
  citation: string;
  input: Input;
  expected: Partial<IeStatutoryResult>;
}

const GOLDENS: Golden[] = [
  // PAYE. "(€44,000/52wks = €846.16)", "(€4,000/52 weeks = €76.92)".
  { year: 2026, label: "Mark: €850/wk → €93.85", citation: `${PAYE_EMPLOYER}, Mark`, input: { pay: "850" }, expected: { paye: "93.8500", edition: "2026-jan" } },
  { year: 2026, label: "Ann week 1: €400 → €3.08", citation: `${PAYE_EMPLOYER}, Ann`, input: { pay: "400", basis: "week1" }, expected: { paye: "3.0800" } },
  { year: 2026, label: "Ann week 2: €850 → €93.85", citation: `${PAYE_EMPLOYER}, Ann`, input: { pay: "850", basis: "week1" }, expected: { paye: "93.8500" } },
  { year: 2026, label: "Ann week 3: €250 → €0, no refund on week 1", citation: `${PAYE_EMPLOYER}, Ann`, input: { pay: "250", basis: "week1" }, expected: { paye: "0.0000" } },
  {
    year: 2026, label: "Fiona week 26: €22,500 cum, €2,500 paid → €100", citation: `${PAYE_EMPLOYER}, Fiona`,
    // PRSI A1: 1000 × 4.2% = 42.00 / × 11.25% = 112.50. USC at week-26 cut-offs:
    // 6006 × 0.5% = 30.03; 8344 × 2% = 166.88; 8150 × 3% = 244.50 → 441.41.
    input: { pay: "1000", taxablePayYtd: "21500", taxPaidYtd: "2500", grossPayYtd: "21500", elapsedPeriods: 26 },
    expected: { paye: "100.0000", prsiSubclass: "A1", prsiEmployee: "42.0000", prsiEmployer: "112.5000", usc: "441.4100" },
  },
  // Published credit €76.93 diverges 1c from the employer pages; max(0, 70.00 − 76.92) = 0 either way.
  { year: 2026, label: "John: single €350/wk → €0", citation: `${PAYE_EXPLAINER}, John`, input: { pay: "350", basis: "week1" }, expected: { paye: "0.0000" } },
  // Engine intermediates 203.85 + 32.30 − 152.88 = €83.27: output exact, ±1c inside.
  { year: 2026, label: "Sarah: married €1,100/wk → €83.27", citation: `${PAYE_EXPLAINER}, Sarah`, input: { pay: "1100", basis: "week1", taxCreditsAnnual: "7950", rateBandAnnual: "53000" }, expected: { paye: "83.2700" } },
  // Published €533.32 uses a €333.34 monthly credit; the employer rule (4000/12 half-up = 333.33) gives €533.33.
  { year: 2026, label: "Ruth: €4,000/mo → €533.33 (published €533.32, 1c credit erratum)", citation: `${PAYE_EXPLAINER}, Ruth`, input: { pay: "4000", payDate: "2026-03-31", periodsPerYear: 12 }, expected: { paye: "533.3300" } },
  // No published fortnightly example: band ceil(44000/26) = 1692.31, credits 153.85;
  // 338.46 + half-up(307.69 × 40%) = 123.08 → 461.54 − 153.85 = 307.69.
  { year: 2026, label: "fortnightly €2,000 → €307.69 (hand-worked)", citation: "Revenue employer-page method, divide by 26", input: { pay: "2000", periodsPerYear: 26, reckonablePayWeeks: ["1000", "1000"] }, expected: { paye: "307.6900" } },
  { year: 2026, label: "October edition leaves PAYE unchanged: Mark in November", citation: `${PAYE_EMPLOYER}, Mark; ${OCTOBER}`, input: { pay: "850", payDate: "2026-11-15" }, expected: { paye: "93.8500", edition: "2026-oct" } },
  // USC.
  { year: 2026, label: "Jacob: €25,000 → €319.82", citation: `${USC_PAGE}, Jacob`, input: { pay: "25000", ...ANNUAL }, expected: { usc: "319.8200" } },
  { year: 2026, label: "Sadhbh: €50,000 → €1,032.82", citation: `${USC_PAGE}, Sadhbh`, input: { pay: "50000", ...ANNUAL }, expected: { usc: "1032.8200" } },
  { year: 2026, label: "USC exemption on the RPN zeroes the charge", citation: "Revenue RPN USC exemption (income at or below €13,000)", input: { pay: "850", uscExempt: true }, expected: { usc: "0.0000" } },
  // PRSI.
  { year: 2026, label: "SW14 €377: credit €7.83, charge €8.00; employer 9.00% = 33.93", citation: `${SW14}, worked example`, input: { pay: "377" }, expected: { prsiSubclass: "AX", prsiEmployee: "8.0000", prsiEmployer: "33.9300" } },
  { year: 2026, label: "Class M has no employee or employer contribution", citation: "DSP PRSI Class M", input: { pay: "1000", prsiClass: "M" }, expected: { prsiSubclass: "M", prsiEmployee: "0.0000", prsiEmployer: "0.0000" } },
  // Each row: gross × 4.2% (half-up) minus [12.00 − half-up(excess/6)].
  ...Object.entries({
    "352.01": "2.7800", "355": "3.4100", "360": "4.4500", "370": "6.5400", "375": "7.5800", "385": "9.6700",
    "390": "10.7100", "395": "11.7600", "400": "12.8000", "405": "13.8400", "415": "15.9300", "420": "16.9700",
  }).map(([pay, charge]) => ({ year: 2026, label: `SW14 table row €${pay}`, citation: SW14, input: { pay }, expected: { prsiEmployee: charge } })),
  // Printed 5.49 / 8.62 / 14.88 / 17.80; exact arithmetic at 4.2% gives 1c more (424 × 4.2% = 17.808 → 17.81).
  ...Object.entries({ "365": "5.5000", "380": "8.6300", "410": "14.8900", "424": "17.8100" })
    .map(([pay, charge]) => ({ year: 2026, label: `SW14 erratum row €${pay} pinned 1c from print`, citation: `${SW14}, errata rows`, input: { pay }, expected: { prsiEmployee: charge } })),
  { year: 2026, label: "Employer Guide week 1: €350 A0 €0 / €31.50", citation: EMPLOYER_GUIDE, input: { pay: "350" }, expected: { prsiSubclass: "A0", prsiEmployee: "0.0000", prsiEmployer: "31.5000" } },
  { year: 2026, label: "Employer Guide week 2: €375 AX €7.58 / €33.75 (agrees with SW14)", citation: EMPLOYER_GUIDE, input: { pay: "375" }, expected: { prsiSubclass: "AX", prsiEmployee: "7.5800", prsiEmployer: "33.7500" } },
  // Employer cells exact (38.34, 62.66); printed employee €17.47 / €22.02 are errata: 426 × 4.2% = 17.89, 557 × 4.2% = 23.39.
  { year: 2026, label: "Employer Guide week 3: €426 employer €38.34, employee erratum €17.89", citation: `${EMPLOYER_GUIDE}, errata`, input: { pay: "426" }, expected: { prsiEmployee: "17.8900", prsiEmployer: "38.3400" } },
  { year: 2026, label: "Employer Guide week 4: €557 employer €62.66, employee erratum €23.39", citation: `${EMPLOYER_GUIDE}, errata`, input: { pay: "557" }, expected: { prsiEmployee: "23.3900", prsiEmployer: "62.6600" } },
  // 377 × 4.35% = 16.3995 → 16.40 − 7.83 credit = 8.57; employer 377 × 9.15% = 34.50.
  { year: 2026, label: "October edition €377 → €8.57 at 4.35%, credit unchanged", citation: OCTOBER, input: { pay: "377", payDate: "2026-11-15" }, expected: { edition: "2026-oct", prsiEmployee: "8.5700", prsiEmployer: "34.5000" } },
  // 750/2 = 375 per week, each SW14 row 375 (€7.58) → €15.16; employer 750 × 9% = 67.50.
  { year: 2026, label: "fortnightly PRSI decomposes to two weeks: €750 → €15.16", citation: "DSP: PRSI charged per week worked in the fortnight", input: { pay: "750", periodsPerYear: 26, reckonablePayWeeks: ["375", "375"] }, expected: { prsiSubclass: "AX", prsiEmployee: "15.1600", prsiEmployer: "67.5000" } },
  // Uneven fortnights price each week on the weekly bands, whatever band the total falls in.
  // €700 + €200 = €900 (fortnightly AL): week 1 A1 700 × 4.2% = 29.40, employer 700 × 11.25% = 78.75;
  // week 2 A0 nil, employer 200 × 9% = 18.00 → €29.40 / €96.75 (not 37.80 / 81.00 on the total).
  { year: 2026, label: "uneven fortnight above AX prices per week: €700 + €200 → €29.40 / €96.75", citation: "DSP: PRSI charged per week worked in the fortnight", input: { pay: "900", periodsPerYear: 26, reckonablePayWeeks: ["700", "200"] }, expected: { prsiSubclass: "A1", prsiEmployee: "29.4000", prsiEmployer: "96.7500" } },
  // €600 + €100 = €700 (fortnightly A0): week 1 A1 600 × 4.2% = 25.20, employer 600 × 11.25% = 67.50;
  // week 2 nil, employer 100 × 9% = 9.00 → €25.20 / €76.50 (not nil / 63.00 on the total).
  { year: 2026, label: "uneven fortnight inside A0 prices per week: €600 + €100 → €25.20 / €76.50", citation: "DSP: PRSI charged per week worked in the fortnight", input: { pay: "700", periodsPerYear: 26, reckonablePayWeeks: ["600", "100"] }, expected: { prsiSubclass: "A1", prsiEmployee: "25.2000", prsiEmployer: "76.5000" } },
  // AL monthly band €1,837.01–€2,392: 2000 × 4.2% = 84.00; × 9.00% = 180.00.
  { year: 2026, label: "monthly €2,000 AL → €84.00 / €180.00", citation: "DSP advance notice, monthly PRSI bands", input: { pay: "2000", payDate: "2026-03-31", periodsPerYear: 12 }, expected: { prsiSubclass: "AL", prsiEmployee: "84.0000", prsiEmployer: "180.0000" } },
];

for (const row of GOLDENS) {
  test(`${row.year} ${row.label}`, () => {
    const result = run(row.input);
    for (const [key, want] of Object.entries(row.expected)) {
      const got = result[key as keyof IeStatutoryResult];
      assert.equal(got, want, `${row.label}: ${key} is ${got}, expected ${want} (${row.citation})`);
    }
  });
}

const REFUSALS: { label: string; input: Input; refusal: RegExp }[] = [
  { label: "no RPN refuses with the emergency-basis instruction", input: { pay: "850", hasRpn: false }, refusal: /Emergency Tax/ },
  { label: "a 2027 pay date refuses instead of extrapolating", input: { pay: "850", payDate: "2027-01-05" }, refusal: /2027/ },
  { label: "a 2025 pay date refuses instead of extrapolating", input: { pay: "850", payDate: "2025-12-31" }, refusal: /2025/ },
  { label: "reduced USC eligibility refuses instead of charging standard bands", input: { pay: "850", uscReducedEligible: true }, refusal: /reduced USC/ },
  { label: "monthly AX pay refuses (no published monthly credit)", input: { pay: "1600", payDate: "2026-03-31", periodsPerYear: 12 }, refusal: /monthly.*AX|AX.*monthly/ },
  { label: "sub-€38 weekly pay refuses as Class J", input: { pay: "30" }, refusal: /Class J/ },
  { label: "an unsupported frequency refuses", input: { pay: "850", periodsPerYear: 24 }, refusal: /not implemented/ },
  { label: "week-1 basis past period 1 refuses", input: { pay: "850", basis: "week1", elapsedPeriods: 5 }, refusal: /on its own/ },
];

for (const row of REFUSALS) {
  test(`refuses: ${row.label}`, () => {
    assert.throws(() => run(row.input), row.refusal, row.label);
  });
}
