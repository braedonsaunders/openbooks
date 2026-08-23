/**
 * Maryland withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from the 2026 Maryland Employer
 * Withholding Guide (Revised December 2025), Withholding Tax Facts
 * January 2026–December 2026 (COM/RAD-098 Revised 12/25), or Form
 * MW507 (COM/RAD-036 07/25) — or is those publications' own arithmetic
 * on their own printed numbers. Nothing here was produced by running
 * the engine and pasting the answer.
 *
 * The Guide prints no worked dollar example of the percentage method
 * ("an employee earning $X … withhold $Y"). Annual-table cells and the
 * weekly first-bracket plus amount are official printed numbers. Period
 * compute goldens are labelled substitutes in the same sense as
 * Colorado / Ohio / Michigan.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import { pctToRate } from "./transcription.ts";
import {
  MD_CERTIFICATE, MD_MW507_NR, MD_RECIPROCITY_AGREEMENTS, MD_REGION, MD_COUNTIES_2026,
  MD_RATES_2026, MD_WITHHOLDING, addPrintedPercents, mdAnneArundelLocal, mdAnnualCombinedTax,
  mdCombinedRate, mdCounty, mdFrederickLocal, mdLumpSumBonus, mdScheduleFor,
} from "./md.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(MD_CERTIFICATE, answers);

test("MD certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(MD_CERTIFICATE), null);
  assert.equal(certificateDeclarationProblem(MD_MW507_NR), null);
  assert.equal(MD_REGION.implemented, true);
  assert.equal(MD_REGION.certificateKey, "us_md_mw507");
  assert.equal(MD_REGION.residentWithholdingImplemented, false);
  assert.equal(MD_REGION.subRegions.length, 24);
  for (const field of MD_CERTIFICATE.fields) {
    assert.ok(field.help.length > 20, `${field.key} help is too thin`);
  }
  for (const field of MD_MW507_NR.fields) {
    assert.ok(field.help.length > 20, `${field.key} help is too thin`);
  }
});

test("MD reciprocity is DC / VA / WV on MW507 line 4 — not Pennsylvania", () => {
  assert.deepEqual(
    MD_RECIPROCITY_AGREEMENTS.map((row) => row.residenceRegion).sort(),
    ["DC", "VA", "WV"],
  );
  assert.ok(MD_RECIPROCITY_AGREEMENTS.every((row) => row.certificateKey === "us_md_mw507_nr"));
  assert.ok(MD_RECIPROCITY_AGREEMENTS.every((row) => row.relievesSubRegionLevies === true));
  assert.equal(
    MD_MW507_NR.fields[0]!.choices!.map((choice) => choice.value).sort().join(","),
    "DC,VA,WV",
  );
});

test("MD 3.20% annual SINGLE table — official plus amounts", () => {
  // Guide p. 39, 3.20% local, (b) Single annual:
  //   $0–$100,000          7.95%
  //   $100,000             $7,950.00 plus 8.20%
  //   $125,000            $10,000.00 plus 8.45%
  //   $150,000            $12,112.50 plus 8.70%
  //   $250,000            $20,812.50 plus 8.95%
  //   $500,000            $43,187.50 plus 9.45%
  //   $1,000,000          $90,437.50 plus 9.70%
  const at = (taxable: string) => mdAnnualCombinedTax({
    taxable: U(taxable), schedule: "single", localPercent: "3.20",
  });
  assert.equal(D(at("100000").tax), money("7950"));
  assert.equal(D(at("125000").tax), money("10000"));
  assert.equal(D(at("150000").tax), money("12112.50"));
  assert.equal(D(at("250000").tax), money("20812.50"));
  assert.equal(D(at("500000").tax), money("43187.50"));
  assert.equal(D(at("1000000").tax), money("90437.50"));
  assert.equal(at("100000").combinedRate, pctToRate("7.95"));
  assert.notEqual(at("100000").combinedRate, pctToRate("8"));
});

test("MD 3.20% annual JOINT table — official plus amounts", () => {
  // Guide p. 39, 3.20% local, (a) Married Filing Joint or Head of Household:
  //   $0–$150,000          7.95%
  //   $150,000            $11,925.00 plus 8.20%
  //   $175,000            $13,975.00 plus 8.45%
  //   $225,000            $18,200.00 plus 8.70%
  //   $300,000            $24,725.00 plus 8.95%
  //   $600,000            $51,575.00 plus 9.45%
  //   $1,200,000         $108,275.00 plus 9.70%
  const at = (taxable: string) => mdAnnualCombinedTax({
    taxable: U(taxable), schedule: "joint", localPercent: "3.20",
  });
  assert.equal(D(at("150000").tax), money("11925"));
  assert.equal(D(at("175000").tax), money("13975"));
  assert.equal(D(at("225000").tax), money("18200"));
  assert.equal(D(at("300000").tax), money("24725"));
  assert.equal(D(at("600000").tax), money("51575"));
  assert.equal(D(at("1200000").tax), money("108275"));
});

test("MD 2.25% annual SINGLE table — official plus amounts (Worcester / nonresident)", () => {
  // Guide p. 15, 2.25% local, (b) Single annual:
  //   $0–$100,000          7.00%
  //   $100,000             $7,000.00 plus 7.25%
  //   $125,000             $8,812.50 plus 7.50%
  //   $150,000            $10,687.50 plus 7.75%
  //   $250,000            $18,437.50 plus 8.00%
  //   $500,000            $38,437.50 plus 8.50%
  //   $1,000,000          $80,937.50 plus 8.75%
  const at = (taxable: string) => mdAnnualCombinedTax({
    taxable: U(taxable), schedule: "single", localPercent: "2.25",
  });
  assert.equal(D(at("100000").tax), money("7000"));
  assert.equal(D(at("125000").tax), money("8812.50"));
  assert.equal(D(at("150000").tax), money("10687.50"));
  assert.equal(D(at("250000").tax), money("18437.50"));
  assert.equal(D(at("500000").tax), money("38437.50"));
  assert.equal(D(at("1000000").tax), money("80937.50"));
});

test("MD weekly 3.20% SINGLE first-bracket plus is the table's $152.88", () => {
  // Guide p. 37 weekly (b): $0–$1,923 at 7.95%; next line "$152.88 plus 8.20%".
  assert.equal(mdCombinedRate("4.75", "3.20"), pctToRate("7.95"));
  assert.equal(D(mulRateCents(U("1923"), pctToRate("7.95"))), money("152.88"));
  assert.notEqual(D(mulRateCents(U("1923"), pctToRate("8"))), money("152.88"));
});

test("MD $3,400 / $3,200 and the printed period constants are the Guide's own figures", () => {
  assert.equal(MD_RATES_2026.standardDeduction, "3400");
  assert.equal(MD_RATES_2026.exemption, "3200");
  assert.equal(MD_RATES_2026.periods.weekly.exemption, "61.54");
  assert.equal(MD_RATES_2026.periods.weekly.standardDeduction, "65.38");
  assert.equal(MD_RATES_2026.periods.weekly.minimumGross, "96.00");
  assert.equal(MD_RATES_2026.periods.semimonthly.standardDeduction, "141.66");
  assert.equal(MD_RATES_2026.periods.daily.exemption, "8.77");
  assert.equal(MD_RATES_2026.periods.annual.exemption, "3200.00");
  assert.notEqual(MD_RATES_2026.standardDeduction, "3200");
});

test("MD Tax Facts 2026 publishes 24 local jurisdictions and the table-grouping rule", () => {
  assert.equal(MD_COUNTIES_2026.length, 24);
  assert.equal(new Set(MD_COUNTIES_2026.map((c) => c.code)).size, 24);
  assert.equal(mdCounty("16").name, "Montgomery");
  assert.equal(mdCounty("MG").rate, "3.20");
  assert.equal(mdCounty("24").rate, "2.25"); // Worcester — lowest
  assert.equal(mdCounty("10").rate, "3.30"); // Dorchester
  assert.equal(mdCounty("15").rate, "3.30"); // Kent
  assert.equal(mdCounty("07").rate, "3.03"); // Carroll actual
  assert.equal(mdCounty("07").tablePercent, "3.05"); // next printed table
  assert.equal(mdCounty("08").tablePercent, "2.75"); // Cecil 2.74
  assert.equal(mdCounty("13").tablePercent, "3.10"); // Harford 3.06
  assert.equal(mdCounty("22").tablePercent, "3.00"); // Washington 2.95
  assert.equal(mdCounty("02").rate, "graduated");
  assert.equal(mdCounty("11").rate, "graduated");
  assert.throws(() => mdCounty("99"), /not a Maryland county/);
});

test("MD 4.75% + 3.20% is the table's 7.95% — a 4.75-only or 8% guess fails", () => {
  assert.equal(addPrintedPercents("4.75", "3.20"), "7.95");
  assert.equal(addPrintedPercents("4.75", "2.25"), "7");
  assert.equal(addPrintedPercents("6.50", "3.30"), "9.8");
  assert.notEqual(mdCombinedRate("4.75", "3.20"), pctToRate("4.75"));
});

test("MD MW507 status boxes map onto the Guide's two schedules", () => {
  assert.equal(mdScheduleFor("single"), "single");
  assert.equal(mdScheduleFor("married_single_rate"), "single");
  assert.equal(mdScheduleFor("married_joint_hoh"), "joint");
  assert.equal(mdScheduleFor(null), "single");
});

test("MD annual 3.20% SINGLE table cell through compute — $7,950.00", () => {
  // LABELLED SUBSTITUTE of the p. 39 $100,000 / $7,950.00 cell:
  // annual wages $103,400 − $3,400 − (0 × $3,200) = $100,000 taxable.
  const result = MD_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 1, wages: "103400.00", basis: "resident",
    certificate: cert({
      filing_status: "single", exemptions: "0", residence_county: "16",
    }),
  });
  assert.equal(result.factors.MD_TAXABLE, money("100000"));
  assert.equal(result.factors.MD_LOCAL_TABLE, "3.20");
  assert.equal(result.tax, money("7950"));
});

test("MD weekly substitute — $1,000, one exemption, Montgomery 3.20%, single: $69.41", () => {
  // LABELLED SUBSTITUTE. Guide formula: $52,000 − $3,400 − $3,200 = $45,400
  // taxable × 7.95% (p. 39 first band) = $3,609.30 ÷ 52.
  // 7.95% × $45,400 = $3,609.30 (the 3.20% table's own 7.95%).
  assert.equal(D(mulRateCents(U("45400"), pctToRate("7.95"))), money("3609.30"));
  const result = MD_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert({
      filing_status: "single", exemptions: "1", residence_county: "16",
    }),
  });
  assert.equal(result.factors.MD_ANNUAL_WAGES, money("52000"));
  assert.equal(result.factors.MD_ANNUAL_EXEMPTION, money("6600"));
  assert.equal(result.factors.MD_TAXABLE, money("45400"));
  assert.equal(result.tax, money("69.41"));
});

test("MD Carroll uses the 3.05% table, not the 3.03% actual rate", () => {
  // Tax Facts: Carroll actual 3.03%; "use the table that agrees with, or is
  // closest to, without going below" → 3.05% table (first band 7.80%).
  const carroll = MD_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert({
      filing_status: "single", exemptions: "1", residence_county: "07",
    }),
  });
  assert.equal(carroll.factors.MD_LOCAL_TABLE, "3.05");
  assert.equal(D(mulRateCents(U("45400"), pctToRate("7.80"))), money("3541.20"));
  assert.equal(carroll.tax, money("68.10"));
  // 3.03% actual would be 7.78% × $45,400 = $3,532.12 ÷ 52 = $67.93.
  assert.notEqual(carroll.tax, money("67.93"));
});

test("MD nonresident uses the special 2.25% table — no county local", () => {
  // Guide p. 6: Nonresident rate includes no local tax but does include
  // the Special 2.25% Nonresident rate. First annual band is 7.00%.
  const result = MD_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00",
    basis: "nonresident",
    certificate: cert({ filing_status: "single", exemptions: "1" }),
  });
  assert.equal(result.factors.MD_LOCAL_TABLE, "2.25");
  assert.equal(D(mulRateCents(U("45400"), pctToRate("7.00"))), money("3178"));
  assert.equal(result.tax, money("61.12"));
});

test("MD with no MW507 county is refused — the Guide does not default 3.30%", () => {
  assert.throws(
    () => MD_WITHHOLDING.compute({
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00",
      basis: "resident",
      certificate: resolveCertificate({ certificate: MD_CERTIFICATE }),
    }),
    /needs the MW507 county of residence/,
  );
});

test("MD no-certificate default is ONE exemption, not zero", () => {
  const one = MD_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert({ residence_county: "16" }),
  });
  const zero = MD_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert({ residence_county: "16", exemptions: "0" }),
  });
  assert.equal(one.factors.MD_ANNUAL_EXEMPTION, money("6600"));
  assert.equal(zero.factors.MD_ANNUAL_EXEMPTION, money("3400"));
  assert.notEqual(one.tax, zero.tax);
});

test("MD extra withholding is added AFTER the combined rate", () => {
  const result = MD_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert({
      filing_status: "single", exemptions: "1", residence_county: "16",
      additional_per_period: "10.00",
    }),
  });
  assert.equal(result.tax, money("79.41"));
});

test("MD MW507 lines 3, 4 and 8 stop withholding", () => {
  for (const flag of ["exempt", "reciprocal_exempt", "military_spouse_exempt"] as const) {
    assert.equal(MD_WITHHOLDING.compute({
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
      certificate: cert({ [flag]: "true", residence_county: "16" }),
    }).tax, money("0"));
  }
});

test("MD MW507 line 5 withholds LOCAL only; lines 6 and 7 withhold nothing", () => {
  // Line 5: PA domiciliary — state exempt, local at the work county's
  // actual rate on taxable income (Tax Facts: local is on taxable, not
  // on Maryland state tax). Montgomery actual 3.20% × $45,400.
  const line5 = MD_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert({
      filing_status: "single", exemptions: "1", residence_county: "16",
      pa_state_exempt: "true",
    }),
  });
  assert.equal(D(mulRateCents(U("45400"), pctToRate("3.20"))), money("1452.80"));
  assert.equal(line5.tax, money("27.94"));
  assert.notEqual(line5.tax, money("69.41"));

  assert.equal(MD_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert({
      residence_county: "16", pa_york_adams_local_exempt: "true",
    }),
  }).tax, money("0"));
  assert.equal(MD_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert({
      residence_county: "16", pa_other_local_exempt: "true",
    }),
  }).tax, money("0"));
});

test("MD Anne Arundel local is the Guide's own marginal slices", () => {
  // Guide p. 9 / Tax Facts 2026, Single: .0270 of $1–$50,000; .0294 of
  // $50,001–$400,000. On $60,000 taxable:
  //   $50,000 × 2.70% = $1,350.00; $10,000 × 2.94% = $294.00; local $1,644.00.
  assert.equal(D(mdAnneArundelLocal(U("60000"), "single")), money("1644"));
  assert.equal(D(mulRateCents(U("50000"), pctToRate("2.70"))), money("1350"));
  assert.equal(D(mulRateCents(U("10000"), pctToRate("2.94"))), money("294"));
  // Joint first slice is $75,000, so $60,000 stays at 2.70%.
  assert.equal(D(mdAnneArundelLocal(U("60000"), "joint")), money("1620"));

  const result = MD_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 1, wages: "63400.00", basis: "resident",
    certificate: cert({
      filing_status: "single", exemptions: "0", residence_county: "02",
    }),
  });
  // State withholding $60,000 × 4.75% = $2,850; + local $1,644 = $4,494.
  assert.equal(result.factors.MD_TAXABLE, money("60000"));
  assert.equal(result.factors.MD_STATE_TAX, money("2850"));
  assert.equal(result.factors.MD_LOCAL_TAX, money("1644"));
  assert.equal(result.tax, money("4494"));
});

test("MD Frederick local is a flat band rate, not a marginal slice", () => {
  // Guide p. 9: ".0275 for taxpayers who have a taxable net income of at
  // least $25,001 and not exceeding $50,000" — the whole taxable, not a
  // 2.25% slice plus 2.75% of the excess.
  assert.equal(D(mdFrederickLocal(U("40000"), "single")), money("1100"));
  assert.notEqual(
    D(mulRateCents(U("25000"), pctToRate("2.25")) + mulRateCents(U("15000"), pctToRate("2.75"))),
    money("1100"),
  );

  const result = MD_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 1, wages: "43400.00", basis: "resident",
    certificate: cert({
      filing_status: "single", exemptions: "0", residence_county: "11",
    }),
  });
  // State $40,000 × 4.75% = $1,900; local $40,000 × 2.75% = $1,100.
  assert.equal(result.factors.MD_TAXABLE, money("40000"));
  assert.equal(result.tax, money("3000"));
});

test("MD weekly wages under the printed $96.00 floor withhold nothing", () => {
  const result = MD_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "90.00", basis: "resident",
    certificate: cert({ residence_county: "16" }),
  });
  assert.equal(result.factors.MD_BELOW_MINIMUM, "1");
  assert.equal(result.tax, money("0"));
});

test("MD lump-sum annual bonus is 6.50% + highest local — exported, not compute", () => {
  // Guide p. 9. Montgomery highest local is 3.20%; combined 9.70%.
  // $1,000 × 9.70% = $97.00. Compute aggregates a bonus into regular wages.
  assert.equal(
    mdLumpSumBonus({
      payDate: "2026-03-06", amount: "1000.00",
      county: mdCounty("16"), basis: "resident",
    }),
    money("97"),
  );
  const aggregated = MD_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00",
    supplemental: "1000.00", basis: "resident",
    certificate: cert({
      filing_status: "single", exemptions: "1", residence_county: "16",
    }),
  });
  const together = MD_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "2000.00",
    basis: "resident",
    certificate: cert({
      filing_status: "single", exemptions: "1", residence_county: "16",
    }),
  });
  assert.equal(aggregated.tax, together.tax);
  assert.equal(aggregated.taxSupplemental, money("0"));
  assert.notEqual(aggregated.tax, money("97"));
});

test("MD refuses a year it has not transcribed", () => {
  assert.throws(
    () => MD_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "1000",
      basis: "resident", certificate: cert({ residence_county: "16" }),
    }),
    /2027 Maryland income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
