/**
 * T4127 2024 conformance goldens.
 *
 * External goldens: the CRA's OWN published claim-code K1/K1P columns
 * (Chapter 8 tables, 119th edition — the only 2024 edition) and hand-worked
 * full stubs through the guide's formulas (round at each parenthesis),
 * independent of the engine code. Follows
 * engine/src/payroll/canada/t4127.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { unfilledPaths } from "../unfilled.ts";
import { calculateT4127 } from "./t4127.ts";
import { claimCodeAmount, ratesForPayDate } from "./rates.ts";
import { RATES_2024_JAN } from "./rates-2024.ts";

const money = (value: string) => `${value}00`; // "2355.75" -> "2355.7500"

test("2024 T4127 constants are transcribed, not scaffolded", () => {
  const unfilled = unfilledPaths(RATES_2024_JAN);
  assert.deepEqual(
    unfilled, [],
    "transcribe every 2024 figure from T4127 — still unfilled: " + unfilled.join(", "),
  );
  assert.equal(RATES_2024_JAN.status, "published");
  assert.equal(RATES_2024_JAN.edition, 119);
  assert.equal(ratesForPayDate("2024-01-15").year, 2024);
});

test("edition resolution: 119th all year (no July delta in 2024)", () => {
  assert.equal(ratesForPayDate("2024-01-01").edition, 119);
  assert.equal(ratesForPayDate("2024-12-31").edition, 119);
});

test("2024 published federal claim-code K1 values (119th Table 8.9)", () => {
  // K1 = 0.15 × TC — CRA publishes both columns; verify the pairing exactly.
  const publishedK1 = [
    "2355.75", "2558.63", "2964.38", "3370.13", "3775.88",
    "4181.63", "4587.38", "4993.13", "5398.88", "5804.63",
  ];
  for (let code = 1; code <= 10; code++) {
    const tc = claimCodeAmount(RATES_2024_JAN.federal.claimCodes, code);
    const result = calculateT4127({
      payDate: "2024-01-15", province: "ON", periodsPerYear: 26,
      income: "1.00", federalClaim: tc, provincialClaimCode: 0,
      cppExempt: true, eiExempt: true,
    });
    assert.equal(result.factors.K1, money(publishedK1[code - 1]!), `claim code ${code}`);
  }
});

test("2024 published provincial claim-code K1P endpoints", () => {
  // CC1 and CC10 K1P for every jurisdiction, straight from the CRA tables.
  const cases: [string, string, number, string, string][] = [
    // province, payDate, code, TCP (published), K1P (published)
    ["AB", "2024-01-15", 1, "21885.00", "2188.50"],
    ["AB", "2024-01-15", 10, "48490.00", "4849.00"],
    ["BC", "2024-01-15", 1, "12580.00", "636.55"],
    ["BC", "2024-01-15", 10, "36643.50", "1854.16"],
    ["MB", "2024-01-15", 1, "15780.00", "1704.24"],
    ["MB", "2024-01-15", 10, "30170.50", "3258.41"],
    ["NB", "2024-01-15", 1, "13044.00", "1226.14"],
    ["NB", "2024-01-15", 10, "35739.00", "3359.47"],
    ["NL", "2024-01-15", 1, "10818.00", "941.17"],
    ["NL", "2024-01-15", 10, "30674.00", "2668.64"],
    ["NS", "2024-01-15", 1, "11481.00", "1009.18"],
    ["NS", "2024-01-15", 10, "25081.00", "2204.62"],
    ["NT", "2024-01-15", 1, "17373.00", "1025.01"],
    ["NT", "2024-01-15", 10, "42762.50", "2522.99"],
    ["NU", "2024-01-15", 1, "18767.00", "750.68"],
    ["NU", "2024-01-15", 10, "44564.50", "1782.58"],
    ["ON", "2024-01-15", 1, "12399.00", "626.15"],
    ["ON", "2024-01-15", 10, "35102.50", "1772.68"],
    ["PE", "2024-01-15", 1, "13500.00", "1302.75"],
    ["PE", "2024-01-15", 10, "27100.00", "2615.15"],
    ["SK", "2024-01-15", 1, "18491.00", "1941.56"],
    ["SK", "2024-01-15", 10, "38721.00", "4065.71"],
    ["YT", "2024-01-15", 1, "15705.00", "1005.12"],
    ["YT", "2024-01-15", 10, "38697.50", "2476.64"],
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

test("Ontario biweekly $2,000, claim code 1 — full hand-worked stub (119th)", () => {
  const result = calculateT4127({
    payDate: "2024-02-13", province: "ON", periodsPerYear: 26,
    income: "2000.00", federalClaimCode: 1, provincialClaimCode: 1,
  });
  // C = 0.0595 × (2000 − 134.61) = 110.99
  assert.equal(result.cpp, "110.9900");
  assert.equal(result.cpp2, "0.0000");
  // EI = 0.0166 × 2000 = 33.20; employer 33.20 × 1.4 = 46.48
  assert.equal(result.ei, "33.2000");
  assert.equal(result.eiEmployer, "46.4800");
  // F5 = 110.99 × (0.01/0.0595) = 18.65 → A = 26 × 1981.35 = 51,515.10
  assert.equal(result.factors.F5, money("18.65"));
  assert.equal(result.factors.A, "51515.1000");
  // Federal (15% bracket): K1 = 0.15 × 15705 = 2355.75;
  // K2 = 0.15 × 2400.74 + 0.15 × 863.20 = 360.11 + 129.48 = 489.59;
  // K4 = 0.15 × 1433 = 214.95;
  // T3 = 0.15 × 51515.10 − 0 − 2355.75 − 489.59 − 214.95
  //    = 7727.27 − 3060.29 = 4666.98
  assert.equal(result.factors.K1, money("2355.75"));
  assert.equal(result.factors.K2, money("489.59"));
  assert.equal(result.factors.K4, money("214.95"));
  assert.equal(result.factors.T3, money("4666.98"));
  assert.equal(result.factors.T1, money("4666.98"));
  // ON (9.15% bracket): K1P = 0.0505 × 12399 = 626.15;
  // K2P = 0.0505 × 2400.74 + 0.0505 × 863.20 = 121.24 + 43.59 = 164.83;
  // T4 = 0.0915 × 51515.10 − 2109 − 626.15 − 164.83
  //    = 4713.63 − 2899.98 = 1813.65;
  // V1 = 0 (T4 ≤ 5554); V2 = min(600, 450 + 0.25 × 3515.10) = 600;
  // S = 0 (2 × 286 < T4); T2 = 1813.65 + 600 = 2413.65
  assert.equal(result.factors.K1P, money("626.15"));
  assert.equal(result.factors.K2P, money("164.83"));
  assert.equal(result.factors.T4, money("1813.65"));
  assert.equal(result.factors.V1, money("0.00"));
  assert.equal(result.factors.V2, money("600.00"));
  assert.equal(result.factors.S, money("0.00"));
  assert.equal(result.factors.T2, money("2413.65"));
  // T = (4666.98 + 2413.65) / 26 = 272.33
  assert.equal(result.periodicTax, money("272.33"));
});

test("PEI biweekly $2,500, claim code 1 — new 2024 five-bracket system (119th)", () => {
  const result = calculateT4127({
    payDate: "2024-03-14", province: "PE", periodsPerYear: 26,
    income: "2500.00", federalClaimCode: 1, provincialClaimCode: 1,
  });
  // C = 0.0595 × (2500 − 134.61) = 140.74
  assert.equal(result.cpp, "140.7400");
  // EI = 0.0166 × 2500 = 41.50; employer 41.50 × 1.4 = 58.10
  assert.equal(result.ei, "41.5000");
  assert.equal(result.eiEmployer, "58.1000");
  // F5 = 140.74 × (0.01/0.0595) = 23.65 → A = 26 × 2476.35 = 64,385.10
  assert.equal(result.factors.F5, money("23.65"));
  assert.equal(result.factors.A, "64385.1000");
  // Federal (20.5% bracket): K1 = 2355.75;
  // K2 = 0.15 × 3044.24 + 0.15 × 1049.12 = 456.64 + 157.37 = 614.01
  //   (EI annualizes past the 1049.12 maximum);
  // K4 = 214.95;
  // T3 = 0.205 × 64385.10 − 3073 − 2355.75 − 614.01 − 214.95
  //    = 13198.95 − 6257.71 = 6941.24
  assert.equal(result.factors.K1, money("2355.75"));
  assert.equal(result.factors.K2, money("614.01"));
  assert.equal(result.factors.T3, money("6941.24"));
  // PE (16.65% bracket): K1P = 0.0965 × 13500 = 1302.75;
  // K2P = 0.0965 × 3044.24 + 0.0965 × 1049.12 = 293.77 + 101.24 = 395.01;
  // T4 = 0.1665 × 64385.10 − 3242 − 1302.75 − 395.01
  //    = 10720.12 − 4939.76 = 5780.36;
  // V1 = 0 — the old surtax system is gone in 2024 (no `surtax` on PE).
  assert.equal(result.factors.K1P, money("1302.75"));
  assert.equal(result.factors.K2P, money("395.01"));
  assert.equal(result.factors.T4, money("5780.36"));
  assert.equal(result.factors.V1, money("0.00"));
  assert.equal(result.factors.T2, money("5780.36"));
  // T = (6941.24 + 5780.36) / 26 = 489.29
  assert.equal(result.periodicTax, money("489.29"));
});

test("Manitoba 2024 has no BPAMB phase-out (high earner keeps the flat BPA)", () => {
  // $11,538.46 × 26: C = 0.0595 × (11538.46 − 134.61) = 678.53 (room to spare);
  // EI = 0.0166 × 11538.46 = 191.54; F5 = 678.53 × (0.01/0.0595) = 114.04;
  // A = 26 × (11538.46 − 114.04) = 297,034.92 — past the 2025 phase-out band,
  // yet TCP must stay flat: the phase-out starts in 2025, not 2024.
  const result = calculateT4127({
    payDate: "2024-03-14", province: "MB", periodsPerYear: 26,
    income: "11538.46",
  });
  assert.equal(result.factors.A, "297034.9200");
  // Federal BPAF floors at its 2024 minimum past $246,752…
  assert.equal(result.factors.TC, "14156.0000");
  // …while Manitoba stays at the flat $15,780 (no `bpamb` field on 2024).
  assert.equal(result.factors.TCP, "15780.0000");
});
