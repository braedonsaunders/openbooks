/**
 * BR adapter goldens: full monthly payslips through the push path.
 *
 * `tax-year-2026.test.ts` proves the pure calculators; this file proves the
 * ADAPTER — `computeBrStatutoryWithRates` pushing every line through the
 * same declaration consult production uses. The push closure is the real
 * `createPushStatutory` (country "BR" against the registered pack), so an
 * undeclared systemKey throws `PayrollPackError` here exactly as it would
 * in a live run. Only the component-row lookup (`need`) is stubbed — unit
 * tests have no database. A recording stub would NOT catch a missing
 * declaration; this closure does.
 *
 * Six lines, enumerated so the next addition fails loudly this same way.
 *
 * Run with `node --import tsx` on this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { computeBrStatutoryWithRates } from "./compute-statutory.ts";
import type {
  PayrollStatutoryComputeContext,
  StubLine,
} from "../statutory-context.ts";
import { createPushStatutory } from "../push-statutory.ts";

interface RunLines {
  ctx: PayrollStatutoryComputeContext;
  lines: StubLine[];
}

function brAdapterContext(salary: string, dependentes: string): RunLines {
  const lines: StubLine[] = [];
  const pushStatutory = createPushStatutory({
    country: "BR",
    lines,
    emittedEarningsAssessed: new Set<string>(),
    // No database in unit tests: the component row is a stub, but the
    // statutoryAssessment consult inside createPushStatutory is real — an
    // undeclared (systemKey, kind) throws before this row is ever read.
    need: (systemKey: string, kind: string): Record<string, unknown> => ({
      id: `${systemKey}:${kind}`,
    }),
  });
  const ctx = {
    taxYear: 2026,
    region: "BR",
    run: { pay_date: "2026-03-15" },
    emp: { br_dependentes: dependentes },
    income: salary,
    nonPeriodic: "",
    pensionable: salary,
    insurable: salary,
    periodsPerYear: 12,
    filingAccountId: null,
    pushStatutory,
    certificateFor: () => null,
    assertRegionSupported: () => {},
  } as unknown as PayrollStatutoryComputeContext;
  return { ctx, lines };
}

const RATES = { ratPct: "2", fap: "1", terceirosPct: "5.8" };

test("adapter: R$ 6.000 payslip pushes IRRF + INSS + all four employer lines, assessed honestly", async () => {
  const { ctx, lines } = brAdapterContext("6000.00", "0");
  const result = await computeBrStatutoryWithRates(ctx, RATES);
  // INSS slices: 121,57 + 115,36 + 174,17 + (1645,72 × 14% → 230,40) =
  // 641,50 — the legal arm wins (641,50 > 607,20): base 5358,50 → bruto
  // 564,85; redutor on gross 6000 = 179,75; final 385,10.
  assert.equal(result["BR_INSS"], "641.5000");
  assert.equal(result["BR_DEDUCAO_VIA"], "legal");
  assert.equal(result["BR_BASE_IRRF"], "5358.5000");
  assert.equal(result["BR_IMPOSTO_BRUTO"], "564.8500");
  assert.equal(result["BR_REDUCAO"], "179.7500");
  assert.equal(result["BR_IRRF"], "385.1000");
  // Employer cost on 6000: patronal 20% = 1200; RAT 2% × FAP 1 = 120;
  // terceiros 5,8% = 348; FGTS 8% = 480.
  assert.equal(result["BR_PATRONAL"], "1200.0000");
  assert.equal(result["BR_RAT"], "120.0000");
  assert.equal(result["BR_TERCEIROS"], "348.0000");
  assert.equal(result["BR_FGTS"], "480.0000");
  // IRRF moves with pre-tax deductions; everything else is rate × base.
  // FGTS is an employer obligation, never a deduction.
  assert.deepEqual(
    lines.map((line) => [
      line.componentId,
      line.kind,
      line.description,
      line.amount,
      line.sequence,
      line.assessedOn,
    ]),
    [
      ["irrf:deduction", "deduction", "IRRF", "385.1000", 110, "taxable_income"],
      ["inss:deduction", "deduction", "INSS (segurado)", "641.5000", 120, "earnings"],
      ["inss_patronal:employer_contribution", "employer_contribution", "INSS patronal (20%)", "1200.0000", 210, "earnings"],
      ["inss_rat:employer_contribution", "employer_contribution", "RAT × FAP", "120.0000", 211, "earnings"],
      ["inss_terceiros:employer_contribution", "employer_contribution", "Terceiros", "348.0000", 212, "earnings"],
      ["fgts:employer_contribution", "employer_contribution", "FGTS (8%)", "480.0000", 220, "earnings"],
    ],
  );
});

test("adapter: R$ 5.000 Maria payslip — IRRF zeroes, INSS and employer cost remain", async () => {
  const { ctx, lines } = brAdapterContext("5000.00", "0");
  const result = await computeBrStatutoryWithRates(ctx, RATES);
  // INSS: 121,57 + 115,36 + 174,17 + (645,72 × 14% → 90,40) = 501,50.
  // IRRF: base 4392,80 → bruto 312,89 → redução 312,89 → zero.
  assert.equal(result["BR_INSS"], "501.5000");
  assert.equal(result["BR_IRRF"], "0.0000");
  assert.equal(result["BR_REDUCAO"], "312.8900");
  assert.equal(result["BR_PATRONAL"], "1000.0000");
  assert.equal(result["BR_RAT"], "100.0000");
  assert.equal(result["BR_TERCEIROS"], "290.0000");
  assert.equal(result["BR_FGTS"], "400.0000");
  // A zeroed IRRF pushes NO line (createPushStatutory skips zero amounts):
  // five lines, and the irrf key provably absent rather than zero-valued.
  assert.equal(lines.length, 5);
  assert.deepEqual(
    lines.map((line) => line.componentId).sort(),
    [
      "fgts:employer_contribution",
      "inss:deduction",
      "inss_patronal:employer_contribution",
      "inss_rat:employer_contribution",
      "inss_terceiros:employer_contribution",
    ].sort(),
  );
});

test("adapter: undeclared employer rates refuse by slot name", async () => {
  const { ctx } = brAdapterContext("6000.00", "0");
  await assert.rejects(
    computeBrStatutoryWithRates(ctx, { ratPct: null, fap: "1", terceirosPct: "5.8" }),
    /br_rat/,
  );
  await assert.rejects(
    computeBrStatutoryWithRates(ctx, { ratPct: "2", fap: null, terceirosPct: "5.8" }),
    /br_fap/,
  );
  await assert.rejects(
    computeBrStatutoryWithRates(ctx, { ratPct: "2", fap: "1", terceirosPct: null }),
    /br_terceiros/,
  );
});
