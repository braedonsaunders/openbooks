/**
 * T4127 conformance tests.
 *
 * External goldens: the published CRA claim-code K1/K1P values (Chapter 8
 * tables, 122nd/123rd editions) and the Table 6.1 CPP exemptions — those
 * numbers come straight off canada.ca, so any drift in our constants or
 * credit arithmetic fails loudly. The full-stub cases are hand-worked
 * through the guide's formulas step by step (round at each parenthesis),
 * independent of the engine code.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculateT4127 } from "./t4127.ts";
import { claimCodeAmount, RATES_2026_JAN, RATES_2026_JUL, ratesForPayDate } from "./rates.ts";

const money = (value: string) => `${value}00`; // "254.83" -> "254.8300"

test("edition resolution: 122nd Jan–Jun, 123rd Jul–Dec, refuses unknown years", () => {
  assert.equal(ratesForPayDate("2026-01-01").edition, 122);
  assert.equal(ratesForPayDate("2026-06-30").edition, 122);
  assert.equal(ratesForPayDate("2026-07-01").edition, 123);
  assert.equal(ratesForPayDate("2026-12-31").edition, 123);
  assert.throws(() => ratesForPayDate("2027-01-01"));
  assert.throws(() => ratesForPayDate("2025-12-31"));
});

test("published federal claim-code K1 values (122nd edition Table 8.9)", () => {
  // K1 = 0.14 × TC — CRA publishes both columns; verify the pairing exactly.
  const publishedK1 = [
    "2303.28", "2501.59", "2898.21", "3294.83", "3691.45",
    "4088.07", "4484.69", "4881.31", "5277.93", "5674.55",
  ];
  for (let code = 1; code <= 10; code++) {
    const tc = claimCodeAmount(RATES_2026_JAN.federal.claimCodes, code);
    const result = calculateT4127({
      payDate: "2026-01-15", province: "ON", periodsPerYear: 26,
      income: "1.00", federalClaim: tc, provincialClaimCode: 0, cppExempt: true, eiExempt: true,
    });
    assert.equal(result.factors.K1, money(publishedK1[code - 1]!), `claim code ${code}`);
  }
});

test("published provincial claim-code K1P endpoints", () => {
  // CC1 and CC10 K1P for every jurisdiction, straight from the CRA tables.
  const cases: [string, string, number, string, string][] = [
    // province, payDate, code, TCP (published), K1P (published)
    ["AB", "2026-01-15", 1, "22769.00", "1821.52"],
    ["AB", "2026-01-15", 10, "50453.50", "4036.28"],
    ["BC", "2026-01-15", 1, "13216.00", "668.73"],
    ["BC", "2026-01-15", 10, "38495.00", "1947.85"],
    ["BC", "2026-07-15", 1, "13216.00", "811.46"],   // 123rd: prorated 6.14%
    ["BC", "2026-07-15", 10, "38495.00", "2363.59"],
    ["MB", "2026-01-15", 1, "15780.00", "1704.24"],
    ["MB", "2026-01-15", 10, "30170.50", "3258.41"],
    ["NB", "2026-01-15", 1, "13664.00", "1284.42"],
    ["NB", "2026-01-15", 10, "37438.50", "3519.22"],
    ["NL", "2026-01-15", 1, "11188.00", "973.36"],
    ["NL", "2026-01-15", 10, "31724.00", "2759.99"],
    ["NL", "2026-07-15", 1, "15000.00", "1305.00"],  // 123rd: prorated BPA
    ["NL", "2026-07-15", 10, "35536.00", "3091.63"],
    ["NS", "2026-01-15", 1, "11932.00", "1048.82"],
    ["NS", "2026-01-15", 10, "26178.00", "2301.05"],
    ["NT", "2026-01-15", 1, "18198.00", "1073.68"],
    ["NT", "2026-01-15", 10, "44794.50", "2642.88"],
    ["NU", "2026-01-15", 1, "19659.00", "786.36"],
    ["NU", "2026-01-15", 10, "46680.50", "1867.22"],
    ["ON", "2026-01-15", 1, "12989.00", "655.94"],
    ["ON", "2026-01-15", 10, "36772.00", "1856.99"],
    ["PE", "2026-01-15", 1, "15000.00", "1425.00"],
    ["PE", "2026-01-15", 10, "28600.00", "2717.00"],
    ["SK", "2026-01-15", 1, "20381.00", "2140.01"],
    ["SK", "2026-01-15", 10, "41571.50", "4365.01"],
    ["YT", "2026-01-15", 1, "16452.00", "1052.93"],
    ["YT", "2026-01-15", 10, "40532.50", "2594.08"],
  ];
  for (const [province, payDate, code, tcp, k1p] of cases) {
    const rates = ratesForPayDate(payDate);
    const provRates = rates.provinces[province as "AB"]!;
    assert.equal(claimCodeAmount(provRates.claimCodes, code), tcp, `${province} CC${code} TCP`);
    const result = calculateT4127({
      payDate, province: province as "AB", periodsPerYear: 26,
      income: "1.00", federalClaimCode: 0, provincialClaimCode: code,
      cppExempt: true, eiExempt: true,
    });
    assert.equal(result.factors.K1P, money(k1p), `${province} CC${code} K1P (${payDate})`);
  }
});

test("Ontario biweekly $2,000, claim code 1 — full hand-worked stub", () => {
  const result = calculateT4127({
    payDate: "2026-02-13", province: "ON", periodsPerYear: 26,
    income: "2000.00", federalClaimCode: 1, provincialClaimCode: 1,
  });
  // C = 0.0595 × (2000 − 134.61) = 110.99
  assert.equal(result.cpp, "110.9900");
  assert.equal(result.cpp2, "0.0000");
  // EI = 0.0163 × 2000 = 32.60
  assert.equal(result.ei, "32.6000");
  assert.equal(result.eiEmployer, "45.6400"); // 32.60 × 1.4
  // F5 = 110.99 × (0.0100/0.0595) = 18.65 → A = 26 × 1981.35 = 51,515.10
  assert.equal(result.f5, "18.6500");
  assert.equal(result.factors.A, "51515.1000");
  // K2 = 0.14×min(26×110.99×495/595, 3519.45) + 0.14×min(26×32.60, 1123.07)
  //    = 0.14×2400.74 + 0.14×847.60 = 336.10 + 118.66 = 454.76
  assert.equal(result.factors.K2, "454.7600");
  // T3 = 0.14×51515.10 − 2303.28 − 454.76 − 210.14 = 4243.93
  assert.equal(result.factors.T3, "4243.9300");
  // T4 = 0.0505×51515.10 − 655.94 − 164.04 = 1781.53; V2 (OHP) = 600; S = 0
  assert.equal(result.factors.T4, "1781.5300");
  assert.equal(result.factors.V2, "600.0000");
  assert.equal(result.factors.T2, "2381.5300");
  // T = (4243.93 + 2381.53)/26 = 254.83
  assert.equal(result.periodicTax, "254.8300");
  assert.equal(result.totalTax, "254.8300");
});

test("BC edition switch: same pay, higher prorated Jul–Dec deduction", () => {
  const base = {
    province: "BC" as const, periodsPerYear: 26,
    income: "2000.00", federalClaimCode: 1 as const, provincialClaimCode: 1,
  };
  const jan = calculateT4127({ ...base, payDate: "2026-06-15", federalClaimCode: 1 });
  const jul = calculateT4127({ ...base, payDate: "2026-07-15", federalClaimCode: 1 });
  assert.equal(jan.edition, 122);
  assert.equal(jul.edition, 123);
  // Jan: T4 = 0.077×51515.10 − 1330 − 668.73 − 164.37 = 1803.56 → T = 232.60
  assert.equal(jan.factors.T4, "1803.5600");
  assert.equal(jan.periodicTax, "232.6000");
  // Jul: T4 = 3966.66 − 786 − 811.46 − 199.45 = 2169.75 → T = 246.68
  assert.equal(jul.factors.T4, "2169.7500");
  assert.equal(jul.periodicTax, "246.6800");
});

test("CPP annual maximum and CPP2 band boundary", () => {
  const result = calculateT4127({
    payDate: "2026-11-06", province: "AB", periodsPerYear: 52,
    income: "3000.00", federalClaimCode: 1, provincialClaimCode: 1,
    ytd: { cpp: "4200.00", pensionable: "73000.00" },
  });
  // C = min(4230.45 − 4200, 0.0595×2932.70) = 30.45
  assert.equal(result.cpp, "30.4500");
  // C2: W = max(73000, 74600) = 74600; band = 1400 → 0.04×1400 = 56.00
  assert.equal(result.cpp2, "56.0000");
  assert.equal(result.cppEmployer, "86.4500"); // employer matches C + C2
  // K2 crossing period: max reached → base 3519.45; EI 0.0163×3000 = 48.90,
  // 52×48.90 caps at 1123.07. K2 = 0.14×3519.45 + 0.14×1123.07 = 492.72 + 157.23
  assert.equal(result.factors.K2, "649.9500");
});

test("EI annual maximum stops the premium at the cap", () => {
  const result = calculateT4127({
    payDate: "2026-11-06", province: "AB", periodsPerYear: 52,
    income: "3000.00", federalClaimCode: 1, provincialClaimCode: 1,
    ytd: { ei: "1120.00" },
  });
  assert.equal(result.ei, "3.0700"); // 1123.07 − 1120.00
});

test("bonus method: Ontario monthly $5,000 + $10,000 bonus", () => {
  const result = calculateT4127({
    payDate: "2026-03-31", province: "ON", periodsPerYear: 12,
    income: "5000.00", nonPeriodic: "10000.00",
    federalClaimCode: 1, provincialClaimCode: 1,
  });
  // C on PI 15,000: 0.0595×14708.34 = 875.15; F5 = 147.08 split 49.03/98.05
  assert.equal(result.cpp, "875.1500");
  assert.equal(result.f5A, "49.0300");
  assert.equal(result.f5B, "98.0500");
  // A(step1) = 12×4950.97 + 9901.95 = 69,313.59; A(step2) = 59,411.64
  assert.equal(result.factors.A, "69313.5900");
  assert.equal(result.factors.A_step2, "59411.6400");
  // Periodic T = (5212.02 + 2935.78)/12 = 678.98; TB = 11,083.72 − 8,147.80
  assert.equal(result.periodicTax, "678.9800");
  assert.equal(result.bonusTax, "2935.9200");
  assert.equal(result.totalTax, "3614.9000");
});

test("bonus flat 15% when annual income is $5,000 or less", () => {
  const result = calculateT4127({
    payDate: "2026-03-06", province: "ON", periodsPerYear: 52,
    income: "50.00", nonPeriodic: "400.00",
    federalClaimCode: 1, provincialClaimCode: 1,
  });
  assert.equal(result.bonusTax, "60.0000"); // 15% × 400
  assert.equal(result.periodicTax, "0.0000");
});

test("BPAF phase-out when no TD1 is filed (dynamic basic personal amount)", () => {
  const result = calculateT4127({
    payDate: "2026-01-30", province: "AB", periodsPerYear: 12,
    income: "20000.00", provincialClaimCode: 1,
  });
  // A = 12×(20000 − 197.08) = 237,635.04 → BPAF = 16452 − 56,195.04×1623/77042
  //   = 16452 − 1183.83 = 15,268.17 → K1 = 2,137.54
  assert.equal(result.factors.TC, "15268.1700");
  assert.equal(result.factors.K1, "2137.5400");
});

test("Quebec employment: QPP + QPIP + abatement, no provincial T2", () => {
  const result = calculateT4127({
    payDate: "2026-02-13", province: "QC", periodsPerYear: 26,
    income: "2000.00", federalClaimCode: 1,
  });
  // QPP: 0.0630 × (2000 − 134.61) = 117.52
  assert.equal(result.cpp, "117.5200");
  // EI at the Quebec-reduced rate: 0.0130 × 2000 = 26.00
  assert.equal(result.ei, "26.0000");
  // QPIP: 0.0043 × 2000 = 8.60; employer 0.00602 × 2000 = 12.04
  assert.equal(result.qpip, "8.6000");
  assert.equal(result.qpipEmployer, "12.0400");
  // No provincial tax through T4127; federal abated 16.5%
  assert.equal(result.factors.T2 ?? "0", "0");
  const t3 = result.factors.T3!;
  const t1 = result.factors.T1!;
  assert.ok(Number(t1) < Number(t3)); // display-only sanity on the abatement
});

test("tax-exempt (claim code E) still pays the Ontario Health Premium", () => {
  const result = calculateT4127({
    payDate: "2026-02-13", province: "ON", periodsPerYear: 26,
    income: "2000.00", taxExempt: true,
  });
  assert.equal(result.factors.T1, "0.0000");
  assert.equal(result.factors.T4, "0.0000");
  assert.equal(result.factors.V2, "600.0000");
  assert.equal(result.periodicTax, "23.0800"); // 600/26 — OHP survives exemption
  // Statutory contributions unaffected
  assert.equal(result.cpp, "110.9900");
  assert.equal(result.ei, "32.6000");
});

test("Manitoba BPAMB and Nova Scotia flat BPA defaults", () => {
  const mb = calculateT4127({
    payDate: "2026-01-30", province: "MB", periodsPerYear: 12,
    income: "20000.00", federalClaimCode: 1,
  });
  // NI = 237,635.04 > 200,000 → BPAMB = 15780 − 37,635.04×15780/200000
  //   = 15780 − 2969.40 = 12,810.60
  assert.equal(mb.factors.TCP, "12810.6000");
  const ns = calculateT4127({
    payDate: "2026-01-30", province: "NS", periodsPerYear: 12,
    income: "20000.00", federalClaimCode: 1,
  });
  assert.equal(ns.factors.TCP, "11932.0000"); // BPANS formula removed for 2026
});

test("Alberta K5P supplemental credit", () => {
  const result = calculateT4127({
    payDate: "2026-01-30", province: "AB", periodsPerYear: 26,
    income: "2000.00", federalClaimCode: 1, provincialClaimCode: 1,
  });
  // K1P = 0.08×22769 = 1821.52; K2P = 0.08×2400.74 + 0.08×847.60 = 192.06 + 67.81
  //     = 259.87; K5P = (1821.52 + 259.87 − 4896) × 0.25 → negative → 0
  assert.equal(result.factors.K5P, "0.0000");
  const high = calculateT4127({
    payDate: "2026-01-30", province: "AB", periodsPerYear: 26,
    income: "8000.00", federalClaimCode: 1, provincialClaim: "60000.00",
  });
  // C = 0.0595×7865.39 = 467.99; 26×467.99×495/595 caps at 3519.45;
  // EI 130.40, 26× caps at 1123.07 → K2P = 281.56 + 89.85 = 371.41
  // K5P = (0.08×60000 + 371.41 − 4896) × 0.25 = 275.41 × 0.25 = 68.85
  assert.equal(high.factors.K5P, "68.8500");
});

test("outside Canada (ZZ): 48% federal surtax, no provincial tax", () => {
  const result = calculateT4127({
    payDate: "2026-02-13", province: "ZZ", periodsPerYear: 26,
    income: "2000.00", federalClaimCode: 1,
  });
  const t3 = BigInt(result.factors.T3!.replace(".", ""));
  const t1 = BigInt(result.factors.T1!.replace(".", ""));
  assert.ok(t1 > t3);
  assert.equal(result.factors.T2, undefined);
});

test("zero and negative guards: tiny income yields no negative deductions", () => {
  const result = calculateT4127({
    payDate: "2026-02-13", province: "ON", periodsPerYear: 52,
    income: "50.00", federalClaimCode: 1, provincialClaimCode: 1,
  });
  assert.equal(result.cpp, "0.0000"); // below the $67.30 weekly exemption
  assert.equal(result.ei, "0.8200"); // 0.0163 × 50, first-dollar insurable
  assert.equal(result.periodicTax, "0.0000");
});

test("additional per-period tax L applies even when A is nil", () => {
  const result = calculateT4127({
    payDate: "2026-02-13", province: "ON", periodsPerYear: 26,
    income: "0.00", additionalTaxPerPeriod: "25.00",
    federalClaimCode: 1, provincialClaimCode: 1,
  });
  assert.equal(result.periodicTax, "25.0000");
});

test("123rd edition leaves untouched provinces identical to the 122nd", () => {
  for (const province of ["AB", "MB", "NB", "NS", "NT", "NU", "ON", "SK", "YT"] as const) {
    assert.deepEqual(RATES_2026_JUL.provinces[province], RATES_2026_JAN.provinces[province]);
  }
});
