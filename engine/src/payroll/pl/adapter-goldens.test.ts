/**
 * PL adapter goldens: the full monthly payslip through the push path.
 *
 * `goldens.test.ts` proves the pure calculators; this file proves the
 * ADAPTER — `computePlStatutory` pushing every line through the same
 * declaration consult production uses. The push closure is the real
 * `createPushStatutory` (country "PL" against the registered pack), so an
 * undeclared systemKey throws `PayrollPackError` here exactly as it would
 * in a live run. Only the component-row lookup (`need`) is stubbed — unit
 * tests have no database. A recording stub would NOT catch a missing
 * declaration; this closure does.
 *
 * Ten lines, enumerated so the next addition fails loudly this same way.
 *
 * Run with `node --import tsx` on this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { computePlStatutory } from "./compute-statutory.ts";
import type {
  PayrollStatutoryComputeContext,
  StubLine,
} from "../statutory-context.ts";
import { createPushStatutory } from "../push-statutory.ts";

interface RunLines {
  ctx: PayrollStatutoryComputeContext;
  lines: StubLine[];
}

function plAdapterContext(payDate: string): RunLines {
  const lines: StubLine[] = [];
  const pushStatutory = createPushStatutory({
    country: "PL",
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
    region: "PL",
    run: { pay_date: payDate },
    emp: { pl_rok_urodzenia: "1990" },
    income: "8000.00",
    nonPeriodic: "",
    pensionable: "8000.00",
    insurable: "0",
    periodsPerYear: 12,
    pushStatutory,
    certificateFor: (key: string) =>
      key === "pl_pit2"
        ? { answers: { pomniejszenie: "1/12", kup: "miejscowy" } }
        : null,
    assertRegionSupported: () => {},
  } as unknown as PayrollStatutoryComputeContext;
  return { ctx, lines };
}

function lineKey(line: StubLine): string {
  // The stub need() encodes `${systemKey}:${kind}` as the component id.
  return line.componentId ?? "";
}

test("adapter: June payslip pushes PIT plus all nine ZUS lines, assessed honestly", async () => {
  const { ctx, lines } = plAdapterContext("2026-06-15");
  const result = await computePlStatutory(ctx);
  // 8 000 brutto, PIT-2 filed (300 zł), KUP 250: dochód 6 653, no 120k
  // crossing — zaliczka 498 zł. ZUS ee 1 096,80; zdrowotna 621,29.
  // Employer: emerytalne 780,80 + rentowe 520,00 + FP 80,00 + FS 116,00
  // + FGŚP 8,00. Wypadkowe has no channel: unpushed.
  assert.equal(result["ZALICZKA"], "498.0000");
  assert.equal(result["ZUS_EE"], "1096.8000");
  assert.equal(result["ZDR"], "621.2900");
  assert.equal(result["EMERYT_ER"], "780.8000");
  assert.equal(result["RENT_ER"], "520.0000");
  assert.equal(result["FP"], "80.0000");
  assert.equal(result["FS"], "116.0000");
  assert.equal(result["FGSP"], "8.0000");
  // PIT moves with pre-tax deductions; every contribution is rate × base.
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
      ["pit:deduction", "deduction", "Zaliczka na podatek dochodowy (PIT)", "498.0000", 110, "taxable_income"],
      ["zus_emeryt:deduction", "deduction", "Składka emerytalna (pracownik)", "780.8000", 120, "earnings"],
      ["zus_rent:deduction", "deduction", "Składka rentowa (pracownik)", "120.0000", 121, "earnings"],
      ["zus_chor:deduction", "deduction", "Składka chorobowa (pracownik)", "196.0000", 122, "earnings"],
      ["zus_zdr:deduction", "deduction", "Składka zdrowotna (NFZ)", "621.2900", 123, "earnings"],
      ["zus_emeryt_er:employer_contribution", "employer_contribution", "Składka emerytalna (pracodawca)", "780.8000", 210, "earnings"],
      ["zus_rent_er:employer_contribution", "employer_contribution", "Składka rentowa (pracodawca)", "520.0000", 211, "earnings"],
      ["fp_er:employer_contribution", "employer_contribution", "Fundusz Pracy (pracodawca)", "80.0000", 212, "earnings"],
      ["fs_er:employer_contribution", "employer_contribution", "Fundusz Solidarnościowy (pracodawca)", "116.0000", 213, "earnings"],
      ["fgsp_er:employer_contribution", "employer_contribution", "FGŚP (pracodawca)", "8.0000", 214, "earnings"],
    ],
  );
  assert.deepEqual(
    lines.map(lineKey).sort(),
    [
      "fgsp_er:employer_contribution",
      "fp_er:employer_contribution",
      "fs_er:employer_contribution",
      "pit:deduction",
      "zus_chor:deduction",
      "zus_emeryt:deduction",
      "zus_emeryt_er:employer_contribution",
      "zus_rent:deduction",
      "zus_rent_er:employer_contribution",
      "zus_zdr:deduction",
    ].sort(),
  );
});

test("adapter refuses an undeclared certificate answer instead of guessing", async () => {
  const { ctx } = plAdapterContext("2026-06-15");
  const noCert = {
    ...ctx,
    certificateFor: () => null,
  } as PayrollStatutoryComputeContext;
  // No certificate on file must not fall through to the 300 zł reduction
  // or the 250 zł KUP — the adapter refuses the first undeclared answer.
  await assert.rejects(() => computePlStatutory(noCert), /pl_pit2/);
  const noBirthYear = {
    ...ctx,
    emp: {},
  } as unknown as PayrollStatutoryComputeContext;
  await assert.rejects(() => computePlStatutory(noBirthYear), /pl_rok_urodzenia/);
  const wrongYear = {
    ...ctx,
    taxYear: 2027,
  } as PayrollStatutoryComputeContext;
  await assert.rejects(() => computePlStatutory(wrongYear), /has not been transcribed/);
});
