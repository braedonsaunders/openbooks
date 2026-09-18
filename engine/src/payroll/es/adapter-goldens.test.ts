/**
 * ES adapter goldens: the full monthly payslip through the push path.
 *
 * `goldens.test.ts` proves the pure calculators; this file proves the
 * ADAPTER — `computeEsStatutory` pushing every line through the same
 * declaration consult production uses. The push closure is the real
 * `createPushStatutory` (country "ES" against the registered pack), so an
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
import { computeEsStatutory } from "./compute-statutory.ts";
import type {
  PayrollStatutoryComputeContext,
  StubLine,
} from "../statutory-context.ts";
import { createPushStatutory } from "../push-statutory.ts";

interface RunLines {
  ctx: PayrollStatutoryComputeContext;
  lines: StubLine[];
}

function esAdapterContext(payDate: string): RunLines {
  const lines: StubLine[] = [];
  const pushStatutory = createPushStatutory({
    country: "ES",
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
    region: "MD",
    run: { pay_date: payDate },
    emp: {
      es_situacion_laboral: "activo",
      es_grupo_cotizacion: "7",
      es_ano_nacimiento: "1990",
    },
    income: "2000.00",
    nonPeriodic: "",
    pensionable: "2000.00",
    insurable: "2000.00",
    periodsPerYear: 12,
    pushStatutory,
    certificateFor: () => null,
    assertRegionSupported: () => {},
  } as unknown as PayrollStatutoryComputeContext;
  return { ctx, lines };
}

function lineKey(line: StubLine): string {
  // The stub need() encodes `${systemKey}:${kind}` as the component id.
  return line.componentId ?? "";
}

test("adapter: March payslip pushes IRPF plus all nine SS lines, assessed honestly", async () => {
  const { ctx, lines } = esAdapterContext("2026-03-15");
  const result = await computeEsStatutory(ctx);
  // Annual RETRIB 24.000, COTIZ 130×12 = 1.560, sit.3 bare → tipo 13,51;
  // the month takes 2.000 × 13,51 % = 270,20 half-up to the cent.
  assert.equal(result["ES_TIPO_IRPF"], "13.51");
  assert.equal(result["ES_IRPF_MES"], "270.2000");
  // Base 2.000 (grupo 7, indefinite contract) at the transcribed Orden
  // tipos — contingencias comunes 4,70 % / 23,60 %; desempleo 1,55 % /
  // 5,50 %; formación 0,10 % / 0,60 %; MEI 0,15 % / 0,75 %; FOGASA 0,20 %
  // empresa — half-up to the cent per cuota.
  assert.equal(result["ES_SS_EE"], "130.0000");
  assert.equal(result["ES_SS_ER"], "613.0000");
  assert.equal(result["ES_EDITION"], "2026-early");
  // IRPF moves with pre-tax deductions; every SS cuota is rate × base.
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
      ["irpf:deduction", "deduction", "IRPF withholding", "270.2000", 110, "taxable_income"],
      ["ss_cc:deduction", "deduction", "Seguridad Social (employee)", "94.0000", 120, "earnings"],
      ["ss_des:deduction", "deduction", "Desempleo (employee)", "31.0000", 121, "earnings"],
      ["ss_for:deduction", "deduction", "Formación profesional (employee)", "2.0000", 122, "earnings"],
      ["ss_mei:deduction", "deduction", "MEI (employee)", "3.0000", 123, "earnings"],
      ["ss_cc_er:employer_contribution", "employer_contribution", "Seguridad Social (employer)", "472.0000", 210, "earnings"],
      ["ss_des_er:employer_contribution", "employer_contribution", "Desempleo (employer)", "110.0000", 211, "earnings"],
      ["ss_fogasa_er:employer_contribution", "employer_contribution", "FOGASA (employer)", "4.0000", 212, "earnings"],
      ["ss_for_er:employer_contribution", "employer_contribution", "Formación profesional (employer)", "12.0000", 213, "earnings"],
      ["ss_mei_er:employer_contribution", "employer_contribution", "MEI (employer)", "15.0000", 214, "earnings"],
    ],
  );
});

test("adapter: September (late edition) pushes the same ten declared keys", async () => {
  const { ctx, lines } = esAdapterContext("2026-09-15");
  const result = await computeEsStatutory(ctx);
  assert.equal(result["ES_EDITION"], "2026");
  // The La Palma edition changes nothing for an MD payslip: same tipo,
  // same month, same employee/employer totals.
  assert.equal(result["ES_TIPO_IRPF"], "13.51");
  assert.equal(result["ES_IRPF_MES"], "270.2000");
  assert.equal(result["ES_SS_EE"], "130.0000");
  assert.equal(result["ES_SS_ER"], "613.0000");
  // Same ten (systemKey, kind) pairs — a future edition-dependent push
  // without a declaration throws above instead of slipping through.
  assert.deepEqual(
    lines.map(lineKey).sort(),
    [
      "irpf:deduction",
      "ss_cc:deduction",
      "ss_cc_er:employer_contribution",
      "ss_des:deduction",
      "ss_des_er:employer_contribution",
      "ss_fogasa_er:employer_contribution",
      "ss_for:deduction",
      "ss_for_er:employer_contribution",
      "ss_mei:deduction",
      "ss_mei_er:employer_contribution",
    ].sort(),
  );
});
