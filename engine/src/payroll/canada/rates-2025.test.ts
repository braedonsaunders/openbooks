/**
 * T4127 2025 conformance goldens.
 *
 * External goldens: the CRA's OWN published claim-code K1/K1P columns
 * (Chapter 8 tables, 120th edition January + 121st edition July) and
 * hand-worked full stubs through the guide's formulas (round at each
 * parenthesis), independent of the engine code. Follows
 * engine/src/payroll/canada/t4127.test.ts.
 *
 * One documented source artifact: the January NS table prints even claim
 * codes 1¢ below the formula value (CC10: TCP 25,769.00 × 0.0879 =
 * 2,265.0951, table says 2,265.09), while CC1 (1,032.2976 → 1,032.30) needs
 * round-up — no single rounding rule produces the January column. The July
 * table prints the formula values (CC10: 2,265.10). The engine follows the
 * formula, so that one cell asserts 2265.10 with the published 2265.09 named
 * here; every other endpoint cell matches the publication exactly.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { unfilledPaths } from "../unfilled.ts";
import { calculateT4127 } from "./t4127.ts";
import { claimCodeAmount, ratesForPayDate } from "./rates.ts";
import { RATES_2025_JAN, RATES_2025_JUL } from "./rates-2025.ts";

const money = (value: string) => `${value}00`; // "2419.35" -> "2419.3500"

test("2025 T4127 constants are transcribed, not scaffolded", () => {
  assert.deepEqual(
    unfilledPaths(RATES_2025_JAN), [],
    "transcribe every 2025 figure from T4127 — still unfilled: "
    + unfilledPaths(RATES_2025_JAN).join(", "),
  );
  assert.deepEqual(
    unfilledPaths(RATES_2025_JUL), [],
    "transcribe every July 2025 figure from T4127 — still unfilled: "
    + unfilledPaths(RATES_2025_JUL).join(", "),
  );
  assert.equal(RATES_2025_JAN.status, "published");
  assert.equal(RATES_2025_JUL.status, "published");
  assert.equal(RATES_2025_JAN.edition, 120);
  assert.equal(RATES_2025_JUL.edition, 121);
  assert.equal(ratesForPayDate("2025-01-15").year, 2025);
});

test("edition resolution: 120th Jan–Jun, 121st Jul–Dec", () => {
  assert.equal(ratesForPayDate("2025-01-01").edition, 120);
  assert.equal(ratesForPayDate("2025-06-30").edition, 120);
  assert.equal(ratesForPayDate("2025-07-01").edition, 121);
  assert.equal(ratesForPayDate("2025-12-31").edition, 121);
});

test("2025 published federal claim-code K1 values (120th Table 8.9)", () => {
  // K1 = 0.15 × TC — CRA publishes both columns; verify the pairing exactly.
  const publishedK1 = [
    "2419.35", "2627.70", "3044.40", "3461.10", "3877.80",
    "4294.50", "4711.20", "5127.90", "5544.60", "5961.30",
  ];
  for (let code = 1; code <= 10; code++) {
    const tc = claimCodeAmount(RATES_2025_JAN.federal.claimCodes, code);
    const result = calculateT4127({
      payDate: "2025-01-15", province: "ON", periodsPerYear: 26,
      income: "1.00", federalClaim: tc, provincialClaimCode: 0,
      cppExempt: true, eiExempt: true,
    });
    assert.equal(result.factors.K1, money(publishedK1[code - 1]!), `claim code ${code}`);
  }
});

test("2025 published federal claim-code K1 values (121st Table 8.9, prorated 14%)", () => {
  // Same TC chart as January; K1 = 0.14 × TC for Jul–Dec.
  const publishedK1 = [
    "2258.06", "2452.52", "2841.44", "3230.36", "3619.28",
    "4008.20", "4397.12", "4786.04", "5174.96", "5563.88",
  ];
  for (let code = 1; code <= 10; code++) {
    const tc = claimCodeAmount(RATES_2025_JUL.federal.claimCodes, code);
    const result = calculateT4127({
      payDate: "2025-08-14", province: "ON", periodsPerYear: 26,
      income: "1.00", federalClaim: tc, provincialClaimCode: 0,
      cppExempt: true, eiExempt: true,
    });
    assert.equal(result.factors.K1, money(publishedK1[code - 1]!), `claim code ${code}`);
  }
});

test("2025 published provincial claim-code K1P endpoints", () => {
  // CC1 and CC10 K1P for every jurisdiction, straight from the CRA tables:
  // January (120th) for all, plus the July (121st) restatements.
  const cases: [string, string, number, string, string][] = [
    // province, payDate, code, TCP (published), K1P (published or formula)
    ["AB", "2025-01-15", 1, "22323.00", "2232.30"],
    ["AB", "2025-01-15", 10, "49463.50", "4946.35"],
    ["AB", "2025-08-14", 1, "22323.00", "1339.38"], // 121st: prorated 6%
    ["AB", "2025-08-14", 10, "49463.50", "2967.81"],
    ["BC", "2025-01-15", 1, "12932.00", "654.36"],
    ["BC", "2025-01-15", 10, "37667.00", "1905.95"],
    ["MB", "2025-01-15", 1, "15969.00", "1724.65"],
    ["MB", "2025-01-15", 10, "30359.50", "3278.83"],
    ["MB", "2025-08-14", 1, "15591.00", "1683.83"], // 121st: prorated BPAMB
    ["MB", "2025-08-14", 10, "29981.50", "3238.00"],
    ["NB", "2025-01-15", 1, "13396.00", "1259.22"],
    ["NB", "2025-01-15", 10, "36711.50", "3450.88"],
    ["NL", "2025-01-15", 1, "11067.00", "962.83"],
    ["NL", "2025-01-15", 10, "31382.00", "2730.23"],
    ["NS", "2025-01-15", 1, "11744.00", "1032.30"],
    // Published 2265.09 — the January-table artifact documented above;
    // the formula (and the July table) give 2265.10.
    ["NS", "2025-01-15", 10, "25769.00", "2265.10"],
    ["NS", "2025-08-14", 10, "25769.00", "2265.10"],
    ["NT", "2025-01-15", 1, "17842.00", "1052.68"],
    ["NT", "2025-01-15", 10, "43920.00", "2591.28"],
    ["NU", "2025-01-15", 1, "19274.00", "770.96"],
    ["NU", "2025-01-15", 10, "45768.50", "1830.74"],
    ["ON", "2025-01-15", 1, "12747.00", "643.72"],
    ["ON", "2025-01-15", 10, "36088.00", "1822.44"],
    ["PE", "2025-01-15", 1, "14250.00", "1353.75"],
    ["PE", "2025-01-15", 10, "27850.00", "2645.75"],
    ["PE", "2025-08-14", 1, "15050.00", "1429.75"], // 121st: prorated BPA
    ["PE", "2025-08-14", 10, "28650.00", "2721.75"],
    ["SK", "2025-01-15", 1, "18991.00", "1994.06"],
    ["SK", "2025-01-15", 10, "39765.00", "4175.33"],
    ["SK", "2025-08-14", 1, "19991.00", "2099.06"], // 121st: prorated BPA
    ["SK", "2025-08-14", 10, "40765.00", "4280.33"],
    ["YT", "2025-01-15", 1, "16129.00", "1032.26"],
    ["YT", "2025-01-15", 10, "39742.00", "2543.49"],
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

test("Manitoba biweekly $2,500, claim code 1 — full hand-worked stub (120th)", () => {
  const result = calculateT4127({
    payDate: "2025-02-13", province: "MB", periodsPerYear: 26,
    income: "2500.00", federalClaimCode: 1, provincialClaimCode: 1,
  });
  // C = 0.0595 × (2500 − 134.61) = 140.74; C2 = 0 (below YMPE)
  assert.equal(result.cpp, "140.7400");
  assert.equal(result.cpp2, "0.0000");
  // EI = 0.0164 × 2500 = 41.00; employer 41.00 × 1.4 = 57.40
  assert.equal(result.ei, "41.0000");
  assert.equal(result.eiEmployer, "57.4000");
  // F5 = 140.74 × (0.0100/0.0595) = 23.65 → A = 26 × 2476.35 = 64,385.10
  assert.equal(result.factors.F5, money("23.65"));
  assert.equal(result.factors.A, "64385.1000");
  // Federal (15% bracket): K1 = 0.15 × 16129 = 2419.35;
  // K2 = 0.15 × 3044.24 + 0.15 × 1066.00 = 456.64 + 159.90 = 616.54;
  // K4 = 0.15 × 1471 = 220.65;
  // T3 = 0.205 × 64385.10 − 3156 − 2419.35 − 616.54 − 220.65
  //    = 13198.95 − 6412.54 = 6786.41
  assert.equal(result.factors.K1, money("2419.35"));
  assert.equal(result.factors.K2, money("616.54"));
  assert.equal(result.factors.K4, money("220.65"));
  assert.equal(result.factors.T3, money("6786.41"));
  assert.equal(result.factors.T1, money("6786.41"));
  // MB (12.75% bracket): K1P = 0.108 × 15969 = 1724.65;
  // K2P = 0.108 × 3044.24 + 0.108 × 1066.00 = 328.78 + 115.13 = 443.91;
  // T4 = 0.1275 × 64385.10 − 927 − 1724.65 − 443.91
  //    = 8209.10 − 3095.56 = 5113.54
  assert.equal(result.factors.K1P, money("1724.65"));
  assert.equal(result.factors.K2P, money("443.91"));
  assert.equal(result.factors.T4, money("5113.54"));
  assert.equal(result.factors.T2, money("5113.54"));
  // T = (6786.41 + 5113.54) / 26 = 457.69
  assert.equal(result.periodicTax, money("457.69"));
});

test("Manitoba no-TD1 defaults use the edition's BPAMB (15969 Jan, 15591 Jul)", () => {
  const jan = calculateT4127({
    payDate: "2025-02-13", province: "MB", periodsPerYear: 26,
    income: "2500.00",
  });
  assert.equal(jan.factors.TCP, "15969.0000");
  assert.equal(jan.factors.TC, "16129.0000");
  const jul = calculateT4127({
    payDate: "2025-08-14", province: "MB", periodsPerYear: 26,
    income: "2500.00",
  });
  assert.equal(jul.factors.TCP, "15591.0000");
  assert.equal(jul.factors.TC, "16129.0000");
});

test("Alberta biweekly $3,000, claim code 1 — full hand-worked stub (121st)", () => {
  const result = calculateT4127({
    payDate: "2025-08-14", province: "AB", periodsPerYear: 26,
    income: "3000.00", federalClaimCode: 1, provincialClaimCode: 1,
  });
  // C = 0.0595 × (3000 − 134.61) = 170.49; EI = 49.20; employer 68.88
  assert.equal(result.cpp, "170.4900");
  assert.equal(result.ei, "49.2000");
  assert.equal(result.eiEmployer, "68.8800");
  // F5 = 170.49 × (0.0100/0.0595) = 28.65 → A = 26 × 2971.35 = 77,255.10
  assert.equal(result.factors.F5, money("28.65"));
  assert.equal(result.factors.A, "77255.1000");
  // Federal (prorated 14% lowest): K1 = 0.14 × 16129 = 2258.06;
  // K2 = 0.14 × 3356.10 + 0.14 × 1077.48 = 469.85 + 150.85 = 620.70
  //   (CPP base share 3687.74 caps at 3356.10; EI annualizes past 1077.48);
  // K4 = 0.14 × 1471 = 205.94;
  // T3 = 0.205 × 77255.10 − 3729 − 2258.06 − 620.70 − 205.94
  //    = 15837.30 − 6813.70 = 9023.60
  assert.equal(result.factors.K1, money("2258.06"));
  assert.equal(result.factors.K2, money("620.70"));
  assert.equal(result.factors.K4, money("205.94"));
  assert.equal(result.factors.T3, money("9023.60"));
  // AB (prorated 6% lowest): K1P = 0.06 × 22323 = 1339.38;
  // K2P = 0.06 × 3356.10 + 0.06 × 1077.48 = 201.37 + 64.65 = 266.02;
  // K5P = 0.666667 × max(0, 1339.38 + 266.02 − 3600) = 0;
  // T4 = 0.10 × 77255.10 − 2400 − 1339.38 − 266.02 = 7725.51 − 4005.40
  //    = 3720.11
  assert.equal(result.factors.K1P, money("1339.38"));
  assert.equal(result.factors.K2P, money("266.02"));
  assert.equal(result.factors.K5P, money("0.00"));
  assert.equal(result.factors.T4, money("3720.11"));
  // T = (9023.60 + 3720.11) / 26 = 490.14
  assert.equal(result.periodicTax, money("490.14"));
});

test("Alberta July K5P prices the supplemental credit (provincialClaim 60000)", () => {
  const result = calculateT4127({
    payDate: "2025-08-14", province: "AB", periodsPerYear: 26,
    income: "3000.00", federalClaimCode: 1, provincialClaim: "60000.00",
  });
  // K1P = 0.06 × 60000 = 3600.00; K2P = 266.02 (as above);
  // K5P = ((3600.00 + 266.02) − 3600) × (0.04/0.06) = 266.02 × 2/3
  //     = 177.3466… → 177.35 (the stored 0.666667 is cent-exact here);
  // T4 = 7725.51 − 2400 − 3600.00 − 266.02 − 177.35 = 1282.14;
  // T = (9023.60 + 1282.14) / 26 = 396.37
  assert.equal(result.factors.K5P, money("177.35"));
  assert.equal(result.factors.T4, money("1282.14"));
  assert.equal(result.periodicTax, money("396.37"));
});
