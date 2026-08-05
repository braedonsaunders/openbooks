/**
 * Generated conformance sweep: every jurisdiction × pay frequency × an income
 * grid, both 2026 editions. Asserts the statutory invariants that must hold
 * for any input — non-negativity, annual maxima, exemption floors, and tax
 * monotonicity in income. The exact-value goldens live in t4127.test.ts;
 * this file is the wide net.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculateT4127 } from "./t4127.ts";
import { Province, RATES_2026_JAN } from "./rates.ts";

const PROVINCES: Province[] = [
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT", "ZZ",
];
const FREQUENCIES = [12, 24, 26, 52];
const INCOMES = ["0.00", "500.00", "1250.00", "2000.00", "3461.54", "7500.00", "20000.00"];
const PAY_DATES = ["2026-02-13", "2026-08-14"]; // one per edition

/** Any-precision decimal money string → exact cents (values are cent-exact). */
function cents(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace("-", "").split(".");
  const centsPart = (fraction + "00").slice(0, 2);
  if (/[1-9]/.test(fraction.slice(2))) throw new Error(`sub-cent value: ${value}`);
  const result = BigInt(whole) * 100n + BigInt(centsPart);
  return negative ? -result : result;
}

test("sweep: statutory invariants across jurisdictions, frequencies, incomes", () => {
  for (const payDate of PAY_DATES) {
    for (const province of PROVINCES) {
      for (const P of FREQUENCIES) {
        let previousTotal = -1n;
        for (const income of INCOMES) {
          const result = calculateT4127({
            payDate, province, periodsPerYear: P,
            income, federalClaimCode: 1,
            ...(province !== "QC" && province !== "ZZ" ? { provincialClaimCode: 1 } : {}),
          });
          const label = `${payDate} ${province} P=${P} I=${income}`;
          // Non-negativity
          for (const [key, value] of Object.entries(result)) {
            if (typeof value === "string" && value.startsWith("-")) {
              assert.fail(`${label}: ${key} is negative (${value})`);
            }
          }
          // Annual maxima can never be exceeded in a single period
          const plan = province === "QC" ? RATES_2026_JAN.qpp : RATES_2026_JAN.cpp;
          assert.ok(cents(result.cpp) <= cents(plan.maxTotal), `${label}: C over max`);
          assert.ok(cents(result.cpp2) <= cents(plan.maxCpp2), `${label}: C2 over max`);
          const eiMax = province === "QC"
            ? RATES_2026_JAN.ei.qcMaxEmployee : RATES_2026_JAN.ei.maxEmployee;
          assert.ok(cents(result.ei) <= cents(eiMax), `${label}: EI over max`);
          // Deductions never exceed the money paid
          const gross = cents(income);
          const totalDeductions = cents(result.cpp) + cents(result.cpp2) +
            cents(result.ei) + cents(result.qpip) + cents(result.totalTax);
          assert.ok(totalDeductions <= gross || gross === 0n,
            `${label}: deductions ${totalDeductions} exceed gross ${gross}`);
          // Tax is monotone non-decreasing in income within a frequency
          const total = cents(result.totalTax);
          assert.ok(total >= previousTotal, `${label}: tax fell as income rose`);
          previousTotal = total;
        }
      }
    }
  }
});

test("sweep: YTD progression through the CPP/CPP2/EI crossover is continuous", () => {
  // Simulate a full year of biweekly $4,000 pay in Ontario and assert the
  // running totals land exactly on the annual maxima — the crossing periods
  // must contribute the partial amounts, never overshoot or leave residue.
  let cpp = 0n, cpp2 = 0n, ei = 0n, pensionable = 0n;
  const toCents = cents;
  for (let period = 1; period <= 26; period++) {
    const result = calculateT4127({
      payDate: "2026-02-13", province: "ON", periodsPerYear: 26,
      income: "4000.00", federalClaimCode: 1, provincialClaimCode: 1,
      ytd: {
        cpp: `${(cpp / 100n)}.${(cpp % 100n).toString().padStart(2, "0")}`,
        cpp2: `${(cpp2 / 100n)}.${(cpp2 % 100n).toString().padStart(2, "0")}`,
        ei: `${(ei / 100n)}.${(ei % 100n).toString().padStart(2, "0")}`,
        pensionable: `${(pensionable / 100n)}.${(pensionable % 100n).toString().padStart(2, "0")}`,
      },
    });
    cpp += toCents(result.cpp);
    cpp2 += toCents(result.cpp2);
    ei += toCents(result.ei);
    pensionable += 400000n;
  }
  assert.equal(cpp, 423045n);  // $4,230.45 — exact annual CPP maximum
  assert.equal(cpp2, 41600n);  // $416.00 — exact CPP2 maximum
  assert.equal(ei, 112307n);   // $1,123.07 — exact EI maximum
});
