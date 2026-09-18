/**
 * IE 2026 conformance goldens.
 *
 * Mechanism 1 (external goldens): every figure below is the AUTHORITY's own
 * published number — quoted with its source — hardcoded here, with the
 * engine asserted against it. A golden generated from our own code would
 * prove nothing; these come off revenue.ie, gov.ie and DSP's SW14.
 *
 * Mechanism 2 (hand-worked cases): where no worked example exists
 * (fortnightly PAYE, October-edition PRSI, monthly PRSI), the expected
 * figure is derived by hand from the tables with the arithmetic shown in
 * comments, independent of the engine code.
 *
 * Known 1c divergences (authority errata, all quoted, none absorbed):
 * - Ruth (employee explainer): monthly credits €333.34 vs the employer
 *   pages' half-up €333.33 → payable €533.32 vs engine €533.33.
 * - SW14 table rows 365/380/410/424 and Employer Guide weeks 3–4: see
 *   individual tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateIeStatutory, type IeStatutoryInput } from "./compute.ts";

const RPN_4000_44000 = {
  taxCreditsAnnual: "4000",
  rateBandAnnual: "44000",
} as const;

function weekly(input: Partial<IeStatutoryInput>): IeStatutoryInput {
  return {
    payDate: "2026-03-15",
    periodsPerYear: 52,
    basis: "cumulative",
    hasRpn: true,
    ...RPN_4000_44000,
    taxablePayPeriod: "0",
    taxablePayYtd: "0",
    taxPaidYtd: "0",
    reckonablePayPeriod: "0",
    grossPayYtd: "0",
    uscPaidYtd: "0",
    uscExempt: false,
    uscReducedEligible: false,
    elapsedPeriods: 1,
    ...input,
  };
}

describe("IE conformance: Revenue PAYE worked examples", () => {
  it("Mark (employer cumulative page): €850/wk → €93.85", () => {
    // "Taxed at 20%: €846.16 → €169.23 … Taxed at 40%: €3.84 → €1.54 …
    // Gross tax €170.77 … Less tax credits €76.92 … Tax payable €93.85"
    // with "(€44,000/52wks = €846.16)" and "(€4,000/52 weeks = €76.92)".
    const r = calculateIeStatutory({
      ...weekly({}),
      taxablePayPeriod: "850",
      reckonablePayPeriod: "850",
    });
    assert.equal(r.paye, "93.8500");
    assert.equal(r.edition, "2026-jan");
  });

  it("Ann (employer week-1 page): €400 → €3.08, €850 → €93.85, €250 → €0", () => {
    // "Tax full pay of €400 at 20%: €80.00 … Less weekly tax credit €76.92 …
    // Tax to deduct for week 1: €3.08". Week 2 repeats Mark (€93.85).
    // "In week 3 you do not refund any tax to Ann … Tax to deduct: €0.00".
    const wk1 = calculateIeStatutory({
      ...weekly({ basis: "week1" }),
      taxablePayPeriod: "400",
      reckonablePayPeriod: "400",
    });
    assert.equal(wk1.paye, "3.0800");
    const wk2 = calculateIeStatutory({
      ...weekly({ basis: "week1" }),
      taxablePayPeriod: "850",
      reckonablePayPeriod: "850",
    });
    assert.equal(wk2.paye, "93.8500");
    const wk3 = calculateIeStatutory({
      ...weekly({ basis: "week1" }),
      taxablePayPeriod: "250",
      reckonablePayPeriod: "250",
    });
    assert.equal(wk3.paye, "0.0000");
  });

  it("Fiona (employer cumulative page): week 26, €22,500 cum, €2,500 paid → €100", () => {
    // "Cumulative pay at week 26: €22,500 … Cumulative cut-off point at week
    // 26: €22,000 … Cumulative tax credits at week 26: €2,000 … Gross
    // cumulative tax €4,600 … Cumulative tax payable €2,600 … Cumulative tax
    // paid €2,500 … Tax payable this week €100.00".
    // "(€44,000 / 52 weeks x 26 weeks = €22,000)" — scale annual × n/P.
    const r = calculateIeStatutory({
      ...weekly({}),
      taxablePayPeriod: "1000",
      taxablePayYtd: "21500",
      taxPaidYtd: "2500",
      reckonablePayPeriod: "1000",
      grossPayYtd: "21500",
      elapsedPeriods: 26,
    });
    assert.equal(r.paye, "100.0000");
    // PRSI on the €1,000 week (A1): hand arithmetic.
    // ee: 1000 × 4.2% = 42.00; er: 1000 × 11.25% = 112.50.
    assert.equal(r.prsiSubclass, "A1");
    assert.equal(r.prsiEmployee, "42.0000");
    assert.equal(r.prsiEmployer, "112.5000");
    // USC on cumulative €22,500 at week-26 cut-offs (hand-worked):
    // widths 12012×26/52 = 6006 → 6006 × 0.5% = 30.03;
    // 16688×26/52 = 8344 → 8344 × 2% = 166.88;
    // balance 22500 − 6006 − 8344 = 8150 → 8150 × 3% = 244.50;
    // cumulative USC = 441.41 (no USC paid YTD in this fixture).
    assert.equal(r.usc, "441.4100");
  });

  it("John (employee explainer): €350/wk single → €0 payable", () => {
    // "€350 at 20%: €70.00 … Deduct tax credits €76.93 … Tax payable €0".
    // The €76.93 display diverges 1c from the employer pages' €76.92, but
    // the OUTPUT is €0 either way: max(0, 70.00 − 76.92) = 0.
    const r = calculateIeStatutory({
      ...weekly({ basis: "week1" }),
      taxablePayPeriod: "350",
      reckonablePayPeriod: "350",
    });
    assert.equal(r.paye, "0.0000");
  });

  it("Sarah (employee explainer): married €1,100/wk → €83.27 payable", () => {
    // Credits €7,950 (€4,000 + €2,000 + €1,950), band €53,000;
    // "€1019.24 at 20%: €203.85 … €80.76 at 40%: €32.31 … Gross €236.16 …
    // Deduct €152.89 … Tax payable €83.27".
    // Engine intermediates (rounded-band method): 203.85 + 32.30 = 236.15,
    // credits 152.88 → 236.15 − 152.88 = €83.27: output exact, ±1c inside.
    const r = calculateIeStatutory({
      ...weekly({ basis: "week1" }),
      taxCreditsAnnual: "7950",
      rateBandAnnual: "53000",
      taxablePayPeriod: "1100",
      reckonablePayPeriod: "1100",
    });
    assert.equal(r.paye, "83.2700");
  });

  it("Ruth (employee explainer): €4,000/mo single → engine €533.33 vs published €533.32", () => {
    // Published: "€3,666.67 at 20%: €733.33 … €333.33 at 40%: €133.33 …
    // Gross €866.66 … Deduct €333.34 … Tax payable €533.32".
    // The €333.34 monthly credit contradicts the employer pages' rule
    // (€4,000/12 half-up = €333.33, as Mark's €76.92 does weekly). The
    // engine follows the employer instruction: 866.66 − 333.33 = €533.33.
    // This test pins the 1c divergence so any drift fails loudly.
    const r = calculateIeStatutory({
      ...weekly({}),
      payDate: "2026-03-31",
      periodsPerYear: 12,
      taxablePayPeriod: "4000",
      reckonablePayPeriod: "4000",
    });
    assert.equal(r.paye, "533.3300");
  });

  it("fortnightly PAYE (hand-worked from the tables): €2,000 → €307.69", () => {
    // No authority fortnightly PAYE example exists. By hand from the
    // transcribed tables with the employer-page method (divide by 26):
    // band = ceil(44000/26) = ceil(1692.3077) = 1692.31;
    // credits = half-up(4000/26) = half-up(153.8462) = 153.85;
    // standard = half-up(1692.31 × 20%) = half-up(338.462) = 338.46;
    // higher base = 2000 − 1692.31 = 307.69;
    // higher = half-up(307.69 × 40%) = half-up(123.076) = 123.08;
    // gross = 461.54 → payable 461.54 − 153.85 = 307.69.
    const r = calculateIeStatutory({
      ...weekly({}),
      periodsPerYear: 26,
      taxablePayPeriod: "2000",
      reckonablePayPeriod: "2000",
    });
    assert.equal(r.paye, "307.6900");
  });
});

describe("IE conformance: Revenue USC worked examples", () => {
  function annualUsc(income: string) {
    return calculateIeStatutory({
      ...weekly({}),
      payDate: "2026-12-31",
      elapsedPeriods: 52,
      taxablePayPeriod: income,
      reckonablePayPeriod: income,
    });
  }

  it("Jacob (calculating-USC page): €25,000 → €319.82", () => {
    // "0.5% on the first €12,012: €60.06 … 2% on the next €12,988:
    // €259.76 … Total €319.82".
    assert.equal(annualUsc("25000").usc, "319.8200");
  });

  it("Sadhbh (calculating-USC page): €50,000 → €1,032.82", () => {
    // "0.5% on the first €12,012: €60.06 … 2% on the next €16,688:
    // €333.76 … 3% on the balance of €21,300: €639.00 … Total €1,032.82".
    assert.equal(annualUsc("50000").usc, "1032.8200");
  });

  it("USC exemption flag zeroes the charge at any income", () => {
    // The RPN states the exemption ("The RPN states the employee is exempt
    // from USC (e.g. income at or below the €13,000 annual exemption)").
    const r = calculateIeStatutory({
      ...weekly({}),
      taxablePayPeriod: "850",
      reckonablePayPeriod: "850",
      uscExempt: true,
    });
    assert.equal(r.usc, "0.0000");
  });
});

describe("IE conformance: DSP PRSI worked figures", () => {
  function week(pay: string, payDate = "2026-03-15") {
    return calculateIeStatutory({
      ...weekly({}),
      payDate,
      taxablePayPeriod: pay,
      reckonablePayPeriod: pay,
    });
  }

  it("SW14 €377 example: credit €7.83, charge €8.00", () => {
    // "(377.00 − 352.01 = 24.99 ÷ 6) (€4.17) … Reduced PRSI Credit €7.83 …
    // PRSI at 4.2% €15.83 … 2026 Weekly PRSI Charge €8.00".
    const r = week("377");
    assert.equal(r.prsiSubclass, "AX");
    assert.equal(r.prsiEmployee, "8.0000");
    // Employer: 377 × 9.00% = 33.93.
    assert.equal(r.prsiEmployer, "33.9300");
  });

  it("SW14 illustrative table: engine reproduces every charge to the penny except four 1c errata rows", () => {
    // Each row: gross × 4.2% (half-up) minus [12.00 − half-up(excess/6)].
    // Printed charges match everywhere except 365 (5.49), 380 (8.62),
    // 410 (14.88) and 424 (17.80) — see the errata test below.
    const expected: Readonly<Record<string, string>> = {
      "352.01": "2.7800", // 14.78 − 12.00
      "355": "3.4100", // 14.91 − 11.50
      "360": "4.4500", // 15.12 − 10.67
      "370": "6.5400", // 15.54 − 9.00
      "375": "7.5800", // 15.75 − 8.17
      "385": "9.6700", // 16.17 − 6.50
      "390": "10.7100", // 16.38 − 5.67
      "395": "11.7600", // 16.59 − 4.83 (printed intermediates differ; charge matches)
      "400": "12.8000", // 16.80 − 4.00
      "405": "13.8400", // 17.01 − 3.17
      "415": "15.9300", // 17.43 − 1.50
      "420": "16.9700", // 17.64 − 0.67
    };
    for (const [pay, charge] of Object.entries(expected)) {
      assert.equal(week(pay).prsiEmployee, charge, `weekly pay €${pay}`);
    }
  });

  it("SW14 errata rows are pinned 1c from print (365/380/410/424)", () => {
    // Printed: 5.49 / 8.62 / 14.88 / 17.80. Exact arithmetic at the stated
    // 4.2% with the €377 method gives 5.50 / 8.63 / 14.89 / 17.81 (e.g.
    // 424 × 4.2% = 17.808 → 17.81, credit nil). Pinned, not absorbed.
    assert.equal(week("365").prsiEmployee, "5.5000");
    assert.equal(week("380").prsiEmployee, "8.6300");
    assert.equal(week("410").prsiEmployee, "14.8900");
    assert.equal(week("424").prsiEmployee, "17.8100");
  });

  it("Employer Guide four-week table: weeks 1–2 exact, employer cells exact", () => {
    // "Week Gross Pay … 1 €350 A0 0% €0 9.0% €31.50 / 2 €375 AX 4.2%*
    // €7.58* 9.0% €33.75". Week 2 matches SW14 row 375 exactly —
    // cross-publication agreement on the credit method.
    const wk1 = week("350");
    assert.equal(wk1.prsiSubclass, "A0");
    assert.equal(wk1.prsiEmployee, "0.0000");
    assert.equal(wk1.prsiEmployer, "31.5000");
    const wk2 = week("375");
    assert.equal(wk2.prsiSubclass, "AX");
    assert.equal(wk2.prsiEmployee, "7.5800");
    assert.equal(wk2.prsiEmployer, "33.7500");
    // Employer cells weeks 3–4: 426 × 9.00% = 38.34; 557 × 11.25% = 62.66.
    assert.equal(week("426").prsiEmployer, "38.3400");
    assert.equal(week("557").prsiEmployer, "62.6600");
  });

  it("Employer Guide weeks 3–4 employee cells are irreproducible errata", () => {
    // Printed "€17.47" (€426 AL) and "€22.02" (€557 A1) against a stated
    // 4.2% rate: exact arithmetic gives 426 × 4.2% = 17.892 → €17.89 and
    // 557 × 4.2% = 23.394 → €23.39. Not rounding, not a boundary: errata.
    assert.equal(week("426").prsiEmployee, "17.8900");
    assert.equal(week("557").prsiEmployee, "23.3900");
  });

  it("October edition (hand-worked): €377 → €8.57 at 4.35%, credit unchanged", () => {
    // "The Class A employee rate of 4.2% will increase by 0.15% to 4.35%" +
    // "There is no change to the employee PRSI Credit": E = 377 × 4.35% =
    // 16.3995 → 16.40; D = 7.83; charge = 8.57. Employer: 377 × 9.15% =
    // 34.4955 → 34.50.
    const r = week("377", "2026-11-15");
    assert.equal(r.edition, "2026-oct");
    assert.equal(r.prsiEmployee, "8.5700");
    assert.equal(r.prsiEmployer, "34.5000");
  });

  it("October edition leaves PAYE unchanged (Mark inputs, November)", () => {
    const r = calculateIeStatutory({
      ...weekly({}),
      payDate: "2026-11-15",
      taxablePayPeriod: "850",
      reckonablePayPeriod: "850",
    });
    assert.equal(r.edition, "2026-oct");
    assert.equal(r.paye, "93.8500");
  });

  it("fortnightly PRSI decomposes to two exact weeks: €750 → €15.16", () => {
    // "The PRSI charge is calculated on the amount paid … in respect of
    // each week worked during that fortnight": 750/2 = 375 per week, each
    // charged as SW14 row 375 (€7.58) → €15.16. Employer: 750 × 9% = 67.50.
    const r = calculateIeStatutory({
      ...weekly({}),
      periodsPerYear: 26,
      taxablePayPeriod: "750",
      reckonablePayPeriod: "750",
    });
    assert.equal(r.prsiSubclass, "AX");
    assert.equal(r.prsiEmployee, "15.1600");
    assert.equal(r.prsiEmployer, "67.5000");
  });

  it("monthly PRSI on published bands: €2,000 AL → €84.00 / €180.00", () => {
    // AL monthly band €1,837.01–€2,392 (advance notice): ee 2000 × 4.2% =
    // 84.00; er 2000 × 9.00% = 180.00.
    const r = calculateIeStatutory({
      ...weekly({}),
      payDate: "2026-03-31",
      periodsPerYear: 12,
      taxablePayPeriod: "2000",
      reckonablePayPeriod: "2000",
    });
    assert.equal(r.prsiSubclass, "AL");
    assert.equal(r.prsiEmployee, "84.0000");
    assert.equal(r.prsiEmployer, "180.0000");
  });
});

describe("IE conformance: named refusals fire", () => {
  const base = weekly({ taxablePayPeriod: "850", reckonablePayPeriod: "850" });

  it("no RPN refuses with the emergency-basis instruction", () => {
    assert.throws(
      () => calculateIeStatutory({ ...base, hasRpn: false }),
      /Emergency Tax/,
    );
  });

  it("pay dates outside 2026 refuse instead of extrapolating", () => {
    assert.throws(() => calculateIeStatutory({ ...base, payDate: "2027-01-05" }), /2026/);
    assert.throws(() => calculateIeStatutory({ ...base, payDate: "2025-12-31" }), /2026/);
  });

  it("reduced USC eligibility refuses instead of charging standard bands", () => {
    assert.throws(
      () => calculateIeStatutory({ ...base, uscReducedEligible: true }),
      /reduced USC/,
    );
  });

  it("monthly AX pay refuses (no published monthly credit)", () => {
    assert.throws(
      () =>
        calculateIeStatutory({
          ...base,
          payDate: "2026-03-31",
          periodsPerYear: 12,
          taxablePayPeriod: "1600",
          reckonablePayPeriod: "1600",
        }),
      /monthly.*AX|AX.*monthly/,
    );
  });

  it("sub-€38 weekly pay refuses as Class J", () => {
    assert.throws(
      () =>
        calculateIeStatutory({ ...base, taxablePayPeriod: "30", reckonablePayPeriod: "30" }),
      /Class J/,
    );
  });

  it("unsupported frequencies and week-1 misuse refuse", () => {
    assert.throws(
      () => calculateIeStatutory({ ...base, periodsPerYear: 24 }),
      /not implemented/,
    );
    assert.throws(
      () => calculateIeStatutory({ ...base, basis: "week1", elapsedPeriods: 5 }),
      /on its own/,
    );
  });
});
