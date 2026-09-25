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
import { calculateEsIrpf2026 } from "./irpf-2026.ts";
import { ES_CERTIFICATES } from "./certificates.ts";
import type {
  PayrollStatutoryComputeContext,
  StubLine,
} from "../statutory-context.ts";
import { createPushStatutory } from "../push-statutory.ts";

interface RunLines {
  ctx: PayrollStatutoryComputeContext;
  lines: StubLine[];
}

function esAdapterContext(
  payDate: string,
  priorChanged = false,
  zone: "ninguna" | "ceuta-melilla" | "la-palma" = "ninguna",
  incomeInZone = false,
  expectedAnnual = "24000.00",
  expectedPeriods = "12",
  categoria = "general",
): RunLines {
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
    tx: { execute: async () => ({ rows: [{ changed: priorChanged }] }) },
    orgId: "org",
    employeePartyId: "employee",
    documentId: "run",
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
    certificateFor: (key: string) => key === "es_retribucion_anual" ? {
      certificate: ES_CERTIFICATES.certificates.find((item) => item.key === key)!,
      onFile: true, effectiveFrom: null, missing: [],
      answers: { importe_anual_previsto: expectedAnnual, periodos_recurrentes_esperados: expectedPeriods },
    } : key === "es_contrato" ? {
      certificate: ES_CERTIFICATES.certificates.find((item) => item.key === key)!,
      onFile: true, effectiveFrom: null, missing: [],
      answers: { categoria_contrato: categoria },
    } : { answers: { zona_residencia: zone, rendimientos_en_zona: String(incomeInZone) } },
    assertRegionSupported: () => {},
  } as unknown as PayrollStatutoryComputeContext;
  return { ctx, lines };
}

test("adapter: March payslip pushes IRPF plus all nine SS lines, assessed honestly", async () => {
  const { ctx, lines } = esAdapterContext("2026-03-15");
  const result = await computeEsStatutory(ctx);
  // Annual RETRIB 24.000, COTIZ 130×12 = 1.560, sit.3 bare → tipo 13,51;
  // the month takes 2.000 × 13,51 % = 270,20 half-up to the cent.
  assert.equal(result["ES_TIPO_IRPF"], "13.51");
  assert.equal(result["ES_IRPF_MES"], "270.2000");
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

test("adapter resolves the September late edition", async () => {
  const { ctx } = esAdapterContext("2026-09-15");
  const result = await computeEsStatutory(ctx);
  assert.equal(result["ES_EDITION"], "2026");
  // I6-payroll-43: €100 of classified non-FM overtime prices the art. 5
  // additional 4,70 % employee contribution through the adapter.
  const overtime = esAdapterContext("2026-09-15");
  Object.assign(overtime.ctx, { emp: { ...overtime.ctx.emp, es_horas_extra_resto: "100.00" } });
  await computeEsStatutory(overtime.ctx);
  assert.equal(overtime.lines.find((line) => line.componentId === "ss_hex_resto:deduction")?.amount, "4.7000");
});

test("adapter counts a pensionable one-off contribution once in annual COTIZACIONES", async () => {
  const { ctx } = esAdapterContext("2026-03-15", false, "ninguna", false, "31000.00", "12");
  Object.assign(ctx, { income: "2500.00", nonPeriodic: "1000.00", pensionable: "3500.00", pensionableNonPeriodic: "1000.00", insurable: "3500.00" });
  const result = await computeEsStatutory(ctx);
  const expected = calculateEsIrpf2026({ payDate: "2026-03-15", retribuciones: "31000", cotizaciones: "2015", situacionFamiliar: "3", birthYear: 1990 });
  const annualizedWrongly = calculateEsIrpf2026({ payDate: "2026-03-15", retribuciones: "31000", cotizaciones: "2730", situacionFamiliar: "3", birthYear: 1990 });
  assert.notEqual(expected.tipo, annualizedWrongly.tipo);
  assert.equal(result["ES_TIPO_IRPF"], expected.tipo);
  const december = esAdapterContext("2026-12-15", false, "ninguna", false, "3000.00", "1");
  Object.assign(december.ctx, { income: "3000.00", pensionable: "3000.00", insurable: "3000.00" });
  // A December starter's certified year is one month's pay (3.000), which is
  // TABLA-1 exento for sit.3 (cell 15.876) — so the annual WITHHOLDING is
  // zero, not the 3.000 gross the I6-payroll-117 golden asserted.
  assert.equal((await computeEsStatutory(december.ctx)).ES_IMPORTE_ANUAL, "0.0000");
});

test("adapter floors a sub-one-year contract at the 2% minimum", async () => {
  const { ctx } = esAdapterContext("2026-05-01", false, "ninguna", false, "16000.00", "12", "inferiorAno");
  const result = await computeEsStatutory(ctx);
  // RETRIB 16.000 prices at most 0,33 general (hand-worked golden at zero
  // cotizaciones, lower still with them); inferiorAno floors at 2,00.
  assert.equal(result["ES_TIPO_IRPF"], "2.00");
});

test("adapter refuses when committed same-year ordinary pay changed without Article 87 inputs", async () => {
  const { ctx, lines } = esAdapterContext("2026-07-15", true);
  await assert.rejects(
    () => computeEsStatutory(ctx),
    /prior committed pay in this tax year differs.*Article 87.*year-to-date retentions/,
  );
  assert.deepEqual(lines, []);
});
