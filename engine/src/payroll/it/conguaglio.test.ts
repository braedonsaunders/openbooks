/**
 * Italy conguaglio di fine anno (art. 23 c. 3 DPR 600/1973) — settlement tests.
 *
 * What is proven here, and what is not. The monthly engine's tables are
 * pinned by their own goldens (tax-year-2025/2026.test.ts: Circ. 4/E Esempi
 * 1–3, the AdE cumulative figures 6.440/14.140/13.700). THESE tests pin the
 * settlement layer on top: year-to-date priors (built by running the monthly
 * engine, exactly as production priors are committed stubs) reconciled
 * against the annual recomputation — sign, kind, key, sequence, and
 * hand-worked euro figures with the arithmetic shown, never engine output
 * asserted against itself.
 *
 * Hand-worked goldens (2026 tables: IRPEF 23/33/43, L. 199/2025 art. 1 c. 3;
 * detrazione lavoro art. 13 TUIR; +65 c. 2; ulteriore detrazione L. 207/2024
 * c. 6; rates regionale 1,23% / comunale 0,8% — tenant-declared per D.Lgs.
 * 446/1997 and D.Lgs. 360/1998):
 *
 * - P=2000 full-year level, declaration filed: R = 24.000 − 2.205,60 INPS
 *   (9,19%) = 21.794,40. IRPEF lorda 23% x 21.794,40 = 5.012,71; detrazione
 *   lavoro band B 1.910 + 1.190 x trunc4(6.205,60/13.000 = 0,4773) =
 *   2.477,99; ulteriore 1.000 (R ≤ 32.000); netta 1.534,72. Monthly:
 *   1.534,72/12 = 127,89 (127,8933… truncated by cent rounding) x 12 =
 *   1.534,68, so the IRPEF delta is +0,04. Regionale 1,23% x 21.794,40 =
 *   268,07 vs 12 x 22,34 = 268,08: delta −0,01. Comunale 0,8% x 21.794,40 =
 *   174,36 = 12 x 14,53 exactly: delta ZERO, pushes nothing.
 * - Joiner P=4000 x 6 months, no family, declaration filed: monthly
 *   annualises 48.000 (R 43.588,80, netta 11.027,73, period 918,98);
 *   actual R = 24.000 − 2.205,60 = 21.794,40, netta 1.534,72 (as above).
 *   IRPEF delta 1.534,72 − 5.513,88 = −3.979,16: a refund credit.
 *   Regionale 268,07 − 268,08 = −0,01. Comunale 174,36 − 174,36 = 0.
 *   TI/somma annual and paid are both 0 (R bands), so the credit guard
 *   passes: the refund is payable, not refused.
 * - Bonus: 2.500 x 11 + (2.500 + 5.000) one-off, declaration filed.
 *   Normal months R = 30.000 − 2.757,00 = 27.243,00: lorda 6.265,89,
 *   detrazione 1.979,25 + 65 (R in art. 13 c. 2's R > 25.000–35.000 band), ulteriore 1.000, netta
 *   3.221,64, period 268,47. Bonus month R = 35.000 − 3.216,50 = 31.783,50:
 *   lorda 6.440 + 33% x 3.783,50 = 7.688,56; detrazione band C 1.910 x
 *   trunc4(18.216,50/22.000 = 0,8280) = 1.581,48 + 65; ulteriore 1.000
 *   (R ≤ 32.000); netta 5.042,08, period 420,17. Annual on 35.000 is the
 *   bonus-month figure 5.042,08; withheld 11 x 268,47 + 420,17 = 3.373,34.
 *   IRPEF delta +1.668,74: a collection deduction. Regionale +51,24,
 *   comunale +33,32 (same annual-minus-monthly shape). TI/somma 0/0.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { add } from "../../money/money.ts";
import {
  createSettlementPush,
  isFinalPeriodOfTaxYear,
  missingSettlementInputs,
  resolveAnnualSettlement,
} from "../annual-settlement.ts";
import type {
  PayrollStatutoryComputeContext,
  PushStatutoryFn,
} from "../statutory-context.ts";
import { computeItStatutoryWithRates } from "./compute-statutory.ts";
import {
  calculateItConguaglio,
  itAnnualSettlement,
  ItPayrollRefusal as ItConguaglioRefusal,
  type ItConguaglioDeclaration,
} from "./conguaglio.ts";
import { IT_PAYROLL_PACK } from "./pack.ts";

interface Pushed {
  systemKey: string;
  kind: string;
  amount: string;
  sequence: number;
}

const DECLARATION_FILED: ItConguaglioDeclaration = {
  hasDetrazioniDeclaration: true,
  hasFamilyCharges: false,
  isFixedTerm: false,
  isPost1995: false,
  presumedTotalIncome: null,
  comuneCode: "H501",
};

const RATES_123_08 = {
  regionalRate: "1.23",
  municipalRate: "0.8",
  municipalExemption: null,
} as const;

function monthlyCollector() {
  const pushed: Pushed[] = [];
  const ctx = {
    taxYear: 2026,
    region: "03",
    periodsPerYear: 12,
    pushStatutory: (
      systemKey: string,
      kind: string,
      _description: string,
      amount: string,
      sequence: number,
    ) => {
      pushed.push({ systemKey, kind, amount, sequence });
    },
    certificateFor: () => ({ answers: { domicilio_comune: "H501" } }),
    bool: (value: string | null) => value === "true",
  } as unknown as PayrollStatutoryComputeContext;
  return { ctx, pushed };
}

async function monthlyRun(income: string, nonPeriodic = "0.0000"): Promise<Pushed[]> {
  const { ctx, pushed } = monthlyCollector();
  await computeItStatutoryWithRates(
    { ...ctx, income, pensionable: income, nonPeriodic } as PayrollStatutoryComputeContext,
    { regionalRate: "1.23", municipalRate: "0.8", municipalExemption: null },
  );
  return pushed;
}

function sumBy(pushed: Pushed[], systemKey: string): string {
  return pushed
    .filter((line) => line.systemKey === systemKey)
    .map((line) => line.amount)
    .reduce((acc, amount) => add(acc, amount), "0.0000");
}

function settle(
  ytdGross: string,
  pushed: Pushed[],
  declaration: ItConguaglioDeclaration = DECLARATION_FILED,
): { seen: Pushed[]; factors: Record<string, string> } {
  const seen: Pushed[] = [];
  const spy: PushStatutoryFn = (systemKey, kind, _d, amount, sequence) => {
    seen.push({ systemKey, kind, amount, sequence });
  };
  const ytdBySystemKey: Record<string, string> = {};
  for (const line of pushed) {
    ytdBySystemKey[line.systemKey] = add(
      ytdBySystemKey[line.systemKey] ?? "0.0000",
      line.amount,
    );
  }
  const factors = calculateItConguaglio(
    {
      taxYear: 2026,
      regionCode: "03",
      ytdGross,
      ytdBySystemKey,
      declaration,
      rates: { ...RATES_123_08 },
    },
    createSettlementPush(spy),
  );
  return { seen, factors };
}

test("edition declared for transcribed years only, with the contract's fields", () => {
  for (const year of [2025, 2026]) {
    const edition = itAnnualSettlement(year);
    assert.ok(edition, `year ${year} declares a settlement`);
    assert.equal(edition.mode, "adjustment_line");
    assert.match(edition.label, /conguaglio/i);
    assert.match(edition.citation, /art\. 23/);
    assert.match(edition.citation, /DPR 29 settembre 1973, n\. 600/);
    assert.deepEqual([...edition.requiredEmployeeFacts], []);
    assert.deepEqual([...edition.requiredCertificates], []);
    assert.deepEqual([...edition.usesTenantRates], [
      "it_addizionale_regionale",
      "it_addizionale_comunale",
    ]);
    assert.equal(edition.settlementSystemKey, "income_tax");
  }
  assert.equal(itAnnualSettlement(2024), null, "2024 is not transcribed in this tree");
  assert.equal(itAnnualSettlement(2027), null);
  assert.equal(itAnnualSettlement(2030), null);
});

test("settlement wires against the pack's declared slots", () => {
  const edition = resolveAnnualSettlement(IT_PAYROLL_PACK, 2026);
  assert.ok(edition, "2026 resolves against the real pack slots");
  assert.equal(edition.settlementSystemKey, "income_tax");
  assert.equal(resolveAnnualSettlement(IT_PAYROLL_PACK, 2024), null);
});

test("December closes the calendar year; November does not", () => {
  assert.equal(isFinalPeriodOfTaxYear(IT_PAYROLL_PACK.taxYear, 12, "2026-12-15"), true);
  assert.equal(isFinalPeriodOfTaxYear(IT_PAYROLL_PACK.taxYear, 12, "2026-11-30"), false);
});

test("no per-employee declaration gate: absence computes without detrazioni", () => {
  const edition = itAnnualSettlement(2026);
  assert.ok(edition);
  assert.deepEqual(
    missingSettlementInputs(edition, { emp: {}, certificateFor: () => null }),
    [],
  );
});

test("full-year level pay: ADDCOM zero pushes nothing, IRPEF/ADDREG dust settles", async () => {
  const months: Pushed[] = [];
  for (let i = 0; i < 12; i++) months.push(...(await monthlyRun("2000.0000")));
  const { seen, factors } = settle("24000.0000", months);
  assert.equal(factors["CONG_IRPEF_ANNUAL"], "1534.7200");
  assert.equal(factors["CONG_IRPEF_DELTA"], "0.0400");
  assert.equal(factors["CONG_ADDREG_DELTA"], "-0.0100");
  assert.equal(factors["CONG_ADDCOM_DELTA"], "0.0000");
  assert.deepEqual(
    seen.map((line) => [line.systemKey, line.kind, line.amount, line.sequence]),
    [
      ["income_tax", "deduction", "0.0400", 110],
      ["regional_surtax", "credit", "0.0100", 115],
    ],
  );
  assert.equal(
    add(sumBy(months, "income_tax"), factors["CONG_IRPEF_DELTA"]!),
    factors["CONG_IRPEF_ANNUAL"],
    "withheld + conguaglio reconciles to the annual IRPEF",
  );
});

test("mid-year joiner: IRPEF over-withheld refunds as a credit", async () => {
  const months: Pushed[] = [];
  for (let i = 0; i < 6; i++) months.push(...(await monthlyRun("4000.0000")));
  const { seen, factors } = settle("24000.0000", months);
  assert.equal(factors["CONG_IRPEF_ANNUAL"], "1534.7200");
  assert.equal(sumBy(months, "income_tax"), "5513.8800");
  assert.equal(factors["CONG_IRPEF_DELTA"], "-3979.1600");
  assert.deepEqual(
    seen.map((line) => [line.systemKey, line.kind, line.amount, line.sequence]),
    [
      ["income_tax", "credit", "3979.1600", 110],
      ["regional_surtax", "credit", "0.0100", 115],
    ],
  );
  assert.equal(
    add(sumBy(months, "income_tax"), factors["CONG_IRPEF_DELTA"]!),
    factors["CONG_IRPEF_ANNUAL"],
  );
});

test("bonus year: IRPEF under-withheld collects as a deduction", async () => {
  const months: Pushed[] = [];
  for (let i = 0; i < 11; i++) months.push(...(await monthlyRun("2500.0000")));
  months.push(...(await monthlyRun("2500.0000", "5000.0000")));
  const { seen, factors } = settle("35000.0000", months);
  assert.equal(factors["CONG_IRPEF_ANNUAL"], "5042.0800");
  assert.equal(sumBy(months, "income_tax"), "3373.3400");
  assert.equal(factors["CONG_IRPEF_DELTA"], "1668.7400");
  assert.equal(factors["CONG_ADDREG_DELTA"], "51.2400");
  assert.equal(factors["CONG_ADDCOM_DELTA"], "33.3200");
  assert.deepEqual(
    seen.map((line) => [line.systemKey, line.kind, line.amount, line.sequence]),
    [
      ["income_tax", "deduction", "1668.7400", 110],
      ["regional_surtax", "deduction", "51.2400", 115],
      ["municipal_surtax", "deduction", "33.3200", 120],
    ],
  );
});

test("cent dust is a real difference and pushes exactly", () => {
  const seen: Pushed[] = [];
  const factors = calculateItConguaglio(
    {
      taxYear: 2026,
      regionCode: "03",
      ytdGross: "36000.0000",
      ytdBySystemKey: {
        income_tax: "5507.1000",
        regional_surtax: "402.1100",
        municipal_surtax: "261.5300",
        ti_payout: "0.0000",
        somma_payout: "0.0000",
      },
      declaration: DECLARATION_FILED,
      rates: { ...RATES_123_08 },
    },
    createSettlementPush((systemKey, kind, _d, amount, sequence) => {
      seen.push({ systemKey, kind, amount, sequence });
    }),
  );
  assert.equal(factors["CONG_IRPEF_ANNUAL"], "5507.1300");
  assert.deepEqual(
    seen.map((line) => [line.systemKey, line.kind, line.amount, line.sequence]),
    [["income_tax", "deduction", "0.0300", 110]],
  );
});

test("TI/somma indebito refuses the whole employee, naming figures and remedy", () => {
  const seen: Pushed[] = [];
  assert.throws(
    () =>
      calculateItConguaglio(
        {
          taxYear: 2026,
          regionCode: "03",
          ytdGross: "21000.0000",
          ytdBySystemKey: {
            income_tax: "4000.0000",
            regional_surtax: "200.0000",
            municipal_surtax: "150.0000",
            ti_payout: "1100.0000",
            somma_payout: "529.4300",
          },
          declaration: DECLARATION_FILED,
          rates: { ...RATES_123_08 },
        },
        createSettlementPush((systemKey, kind, _d, amount, sequence) => {
          seen.push({ systemKey, kind, amount, sequence });
        }),
      ),
    (error: unknown) =>
      error instanceof ItConguaglioRefusal
      && /trattamento integrativo/i.test(error.message)
      && /somma/i.test(error.message)
      && /1100/.test(error.message)
      && /dieci rate|10 rate/i.test(error.message),
  );
  assert.deepEqual(seen, [], "a refused settlement pushes nothing — all or nothing per employee");
});

test("unconfigured tenant rates refuse by name, never settle zero", () => {
  const base = {
    taxYear: 2026,
    regionCode: "03",
    ytdGross: "24000.0000",
    ytdBySystemKey: { income_tax: "1500.0000" },
    declaration: DECLARATION_FILED,
  } as const;
  const noop: PushStatutoryFn = () => {};
  assert.throws(
    () =>
      calculateItConguaglio(
        { ...base, rates: { ...RATES_123_08, regionalRate: null } },
        noop,
      ),
    /it_addizionale_regionale/,
  );
  assert.throws(
    () =>
      calculateItConguaglio(
        { ...base, rates: { ...RATES_123_08, municipalRate: null } },
        noop,
      ),
    /it_addizionale_comunale/,
  );
  assert.throws(
    () =>
      calculateItConguaglio(
        {
          ...base,
          declaration: { ...DECLARATION_FILED, comuneCode: null },
          rates: { ...RATES_123_08 },
        },
        noop,
      ),
    /comune/i,
  );
  assert.throws(
    () =>
      calculateItConguaglio(
        {
          ...base,
          declaration: { ...DECLARATION_FILED, comuneCode: "ROMA" },
          rates: { ...RATES_123_08 },
        },
        noop,
      ),
    /catastale/,
  );
  assert.throws(
    () => calculateItConguaglio({ ...base, regionCode: "XX", rates: { ...RATES_123_08 } }, noop),
    /regione/i,
  );
  assert.throws(
    () => calculateItConguaglio({ ...base, regionCode: "03" } as never, noop),
    /tenant rates/i,
  );
});

test("pension income refuses in parity with the monthly engine", () => {
  assert.throws(
    () =>
      calculateItConguaglio(
        {
          taxYear: 2026,
          regionCode: "03",
          ytdGross: "24000.0000",
          ytdBySystemKey: { income_tax: "1500.0000" },
          declaration: { ...DECLARATION_FILED, isPensioner: true },
          rates: { ...RATES_123_08 },
        },
        () => {},
      ),
    /pension/i,
  );
});

test("untranscribed year refuses in the pure core too", () => {
  assert.throws(
    () =>
      calculateItConguaglio(
        {
          taxYear: 2024,
          regionCode: "03",
          ytdGross: "24000.0000",
          ytdBySystemKey: {},
          declaration: DECLARATION_FILED,
          rates: { ...RATES_123_08 },
        },
        () => {},
      ),
    /2024/,
  );
});
