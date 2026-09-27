/**
 * ES conformance goldens: one table per layer.
 *
 * GOLDENS proves the pure calculators (IRPF, escala, Seguridad Social,
 * Sistema Especial Hogar): the ALGORITMO's own worked example to the cent,
 * plus hand-worked cases (arithmetic in the row comments, each cross-checked
 * against a second implementation before encoding) and the TABLA 1 / TABLA 2 /
 * SS-clamp edges. The ALGORITMO publishes no full-tipo worked example, so
 * full-tipo proof is the hand-worked rows.
 *
 * ADAPTER_GOLDENS proves `computeEsStatutory` pushing every line through the
 * real `createPushStatutory` (country "ES" against the registered pack), so
 * an undeclared systemKey throws `PayrollPackError` here exactly as in a live
 * run. Only the component-row lookup (`need`) is stubbed: unit tests have no
 * database, and a recording stub would not catch a missing declaration.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { computeEsStatutory } from "./compute-statutory.ts";
import { calculateEsIrpf2026, escalaIrpf2026, type EsIrpfInput } from "./irpf-2026.ts";
import { calculateEsHogar2026, type EsHogarInput } from "./seguridad-social-hogar-2026.ts";
import { calculateEsSeguridadSocial2026, type EsSeguridadSocialInput } from "./seguridad-social-2026.ts";
import { ES_CERTIFICATES } from "./certificates.ts";
import type { PayrollStatutoryComputeContext, StubLine } from "../statutory-context.ts";
import { createPushStatutory } from "../push-statutory.ts";

type Expected = Record<string, string | boolean | null>;
type Golden = { year: number; label: string; expected: Expected; citation: string } & (
  | { engine: "irpf"; input: EsIrpfInput }
  | { engine: "escala"; input: string }
  | { engine: "ss"; input: EsSeguridadSocialInput }
  | { engine: "hogar"; input: EsHogarInput }
);

function compute(row: Golden): Record<string, unknown> {
  switch (row.engine) {
    case "irpf": return { ...calculateEsIrpf2026(row.input) };
    case "escala": return { cuota: escalaIrpf2026(row.input) };
    case "ss": return { ...calculateEsSeguridadSocial2026(row.input) };
    case "hogar": return { ...calculateEsHogar2026(row.input) };
  }
}

function assertFields(actual: Record<string, unknown>, expected: Expected, where: string): void {
  for (const [field, want] of Object.entries(expected)) {
    assert.equal(actual[field], want, `${where}: ${field} expected ${want}, got ${actual[field]}`);
  }
}

const sit3 = { situacionFamiliar: "3", birthYear: 1990 } as const;
const sit2 = { situacionFamiliar: "2", birthYear: 1990 } as const;
const HAND = "hand-worked, ALGORITMO 2026 procedimiento general";
const SS = "hand-worked, Orden PJC/297/2026 tipos and bases";
const TABLA2 = "ALGORITMO 2026 TABLA 2 (escala)";

const GOLDENS: Golden[] = [
  { year: 2026, engine: "escala", label: "CUOTA1 base 24.000 → 5.365,50", input: "24000",
    expected: { cuota: "5365.5000" }, citation: "ALGORITMO p.30 worked example: 4.225,50 + 3.800,00 × 0,30" },
  ...(
    [["0", "0.0000"], ["12450", "2365.5000"], ["20200", "4225.5000"], ["35200", "8725.5000"],
      ["60000", "17901.5000"], ["300000", "125901.5000"], ["400000", "172901.5000"]] as const
  ).map(([base, cuota]): Golden => ({
    year: 2026, engine: "escala", label: `TABLA 2 edge ${base} → ${cuota}`, input: base,
    expected: { cuota }, citation: base === "400000" ? `${TABLA2}, open 47% row` : TABLA2,
  })),
  // Exención cell 15.876 < 24.000; RNTREDU 22.000; CUOTA 4.765,50 − 1.054,50 = 3.711,00,
  // but the 43% cap (24.000−15.876)×0,43 = 3.493,32 binds; TIPO trunc(14,5555).
  { year: 2026, engine: "irpf", label: "sit3 bare 24.000 → tipo 14,55 (43% cap binds)",
    input: { payDate: "2026-03-15", retribuciones: "24000", ...sit3 },
    expected: { edition: "2026-early", exento: false, base: "22000.0000", minimoPersonalFamiliar: "5550.0000",
      cuota: "3493.3200", tipo: "14.55", importeAnual: "3492.0000" }, citation: HAND },
  // RED20 band 2: 7.302 − 1,75×(16.000−14.852) = 5.293; 43% cap (16.000−15.876)×0,43 = 53,32.
  { year: 2026, engine: "irpf", label: "sit3 16.000 → RED20 5.293, tipo 0,33",
    input: { payDate: "2026-05-01", retribuciones: "16000", ...sit3 },
    expected: { exento: false, base: "8707.0000", cuota: "53.3200", tipo: "0.33", importeAnual: "52.8000" }, citation: HAND },
  // Cell 19.262; MINDES 2.400 + 2.700×0,5; CUOTA 9.206,50 − 1.767,00; no cap (40.000 > 35.200).
  { year: 2026, engine: "irpf", label: "sit2 family 40.000 → tipo 18,59",
    input: { payDate: "2026-11-20", retribuciones: "40000", cotizaciones: "1500", situacionFamiliar: "2", birthYear: 1985,
      descendientes: [
        { birthYear: 2018, entero: 1, discapacidad: "none", movilidadReducida: false },
        { birthYear: 2021, entero: 0.5, discapacidad: "none", movilidadReducida: false },
      ] },
    expected: { edition: "2026", base: "36500.0000", minimoPersonalFamiliar: "9300.0000", cuota: "7439.5000",
      tipo: "18.59", importeAnual: "7436.0000" }, citation: HAND },
  { year: 2026, engine: "irpf", label: "sit2 17.000 is exento under TABLA 1 (cell 17.197)",
    input: { payDate: "2026-02-01", retribuciones: "17000", ...sit2 },
    expected: { exento: true, tipo: "0.00", importeAnual: "0.0000" }, citation: `${HAND}, TABLA 1` },
  ...(["17196.99", "17197", "17197.01"] as const).map((retribuciones): Golden => ({
    year: 2026, engine: "irpf", label: `TABLA 1 sit2/0 cliff at ${retribuciones}`,
    input: { payDate: "2026-03-15", retribuciones, ...sit2 },
    expected: { exento: retribuciones !== "17197.01" }, citation: "ALGORITMO 2026 TABLA 1, sit.2 cell 17.197",
  })),
  // MINOPAGO trunc(2% × 20.000) = 400,00; cap 1.773,32; DIF 1.373,32.
  { year: 2026, engine: "irpf", label: "presVivienda 20.000 → tipo 6,86",
    input: { payDate: "2026-04-01", retribuciones: "20000", ...sit3, presVivienda: true },
    expected: { cuota: "1773.3200", tipo: "6.86", importeAnual: "1372.0000" }, citation: `${HAND}, RD 1975/2008 vivienda` },
  // DIF = 1.773,32 × 0,40 − 400,00 = 309,328.
  { year: 2026, engine: "irpf", label: "Ceuta 20.000 + vivienda → tipo 1,54",
    input: { payDate: "2026-04-01", retribuciones: "20000", ...sit3, presVivienda: true, zona: "ceuta-melilla", rendimientosZona: true },
    expected: { tipo: "1.54", importeAnual: "308.0000" }, citation: `${HAND}, CEUMELI` },
  { year: 2026, engine: "irpf", label: "La Palma claim accepted from 10 September",
    input: { payDate: "2026-09-10", retribuciones: "24000", ...sit3, zona: "la-palma", rendimientosZona: true },
    expected: { edition: "2026", exento: false }, citation: "RD-Ley 23/2026 window" },
  { year: 2026, engine: "ss", label: "grupo 7 base 2.000 → EE 130,00 / ER 613,00",
    input: { payDate: "2026-04-10", grupo: 7, base: "2000", contratoTemporal: false },
    expected: { baseContingenciasComunes: "2000.0000", ccTrabajador: "94.0000", ccEmpresa: "472.0000",
      desempleoTrabajador: "31.0000", desempleoEmpresa: "110.0000", fogasaEmpresa: "4.0000",
      formacionTrabajador: "2.0000", formacionEmpresa: "12.0000", meiTrabajador: "3.0000", meiEmpresa: "15.0000",
      solidaridadTrabajador: "0.0000", solidaridadEmpresa: "0.0000", atEpEmpresa: null,
      trabajadorTotal: "130.0000", empresaTotal: "613.0000" }, citation: SS },
  // 510,12 € @1,15% + 388,68 € @1,25% (https://www.boe.es/boe/dias/2026/03/31/pdfs/BOE-A-2026-7296.pdf).
  { year: 2026, engine: "ss", label: "solidaridad on 6.000 → EE 1,79 / ER 8,94",
    input: { payDate: "2026-06-10", grupo: 1, base: "5101.20", retribucionMensual: "6000", contratoTemporal: false },
    expected: { solidaridadTrabajador: "1.7900", solidaridadEmpresa: "8.9400" }, citation: "Orden PJC/297/2026 art. 17.2" },
  { year: 2026, engine: "ss", label: "solidaridad grupo 9 daily 170,04 × 31 días on 5.200 → none",
    input: { payDate: "2026-06-10", grupo: 9, base: "170.04", dias: 31, retribucionMensual: "5200", contratoTemporal: false },
    expected: { solidaridadTrabajador: "0.0000" }, citation: "Orden PJC/297/2026 art. 17.2 (daily proration)" },
  // CC EE 1.989,30 × 4,70% = 93,4971, half-up to the cent.
  { year: 2026, engine: "ss", label: "grupo 1 base 1.500 clamps to the 1.989,30 mínima",
    input: { payDate: "2026-01-15", grupo: 1, base: "1500", contratoTemporal: false },
    expected: { baseContingenciasComunes: "1989.3000", ccTrabajador: "93.5000", ccEmpresa: "469.4700" }, citation: SS },
  { year: 2026, engine: "ss", label: "grupo 9 diaria-temporal 60 × 30 → desempleo 28,80/120,60",
    input: { payDate: "2026-07-10", grupo: 9, base: "60", dias: 30, contratoTemporal: true },
    expected: { baseContingenciasComunes: "1800.0000", desempleoTrabajador: "28.8000", desempleoEmpresa: "120.6000" },
    citation: `${SS}, desempleo temporal 8,30%` },
  ...([["1000", 4, "1424.4000"], ["1424.40", 4, "1424.4000"], ["9000", 1, "5101.2000"]] as const).map(
    ([base, grupo, clamped]): Golden => ({
      year: 2026, engine: "ss", label: `grupo ${grupo} base ${base} clamps to ${clamped}`,
      input: { payDate: "2026-03-15", grupo, base, contratoTemporal: false },
      expected: { baseContingenciasComunes: clamped },
      citation: clamped === "5101.2000" ? "Orden PJC/297/2026 tope máximo" : "Orden PJC/297/2026 grupo 4 base mínima",
    }),
  ),
  // Tramo 2 (base 436,00; the SMI floor band ties, never undercuts).
  { year: 2026, engine: "hogar", label: "hogar tramo 2: 450,00 alta_20 → base 436,00 fully priced",
    input: { retribucionMensual: "450.00", horasMes: 40, retribucionPorHoras: false, contratoTemporal: false,
      beneficioCc: "alta_20", atEpRate: "1.50" },
    expected: { base: "436.0000", ccTrabajador: "20.4900", ccEmpresa: "82.3200", desempleoTrabajador: "6.7600",
      desempleoEmpresa: "4.8000", fogasaEmpresa: "0.1700", meiTrabajador: "0.6500", meiEmpresa: "3.2700",
      atEpEmpresa: "6.5400", trabajadorTotal: "27.9000", empresaTotal: "97.1000" },
    citation: "Orden PJC/297/2026 art. 15; OCU 2026 hogar table (employee 27,90, employer 97,10)" },
];

for (const row of GOLDENS) {
  test(`${row.year} ${row.label}`, () => {
    assertFields(compute(row), row.expected, `${row.year} ${row.label} [${row.citation}]`);
  });
}

const REFUSALS: Array<{ label: string; run: () => unknown; refusal: RegExp }> = [
  { label: "IRPF pay date 2025-12-31", refusal: /rates for 2025 aren't available in this pack version; update the pack/,
    run: () => calculateEsIrpf2026({ payDate: "2025-12-31", retribuciones: "24000", ...sit3 }) },
  { label: "IRPF pay date 2027-01-01", refusal: /rates for 2027 aren't available in this pack version; update the pack/,
    run: () => calculateEsIrpf2026({ payDate: "2027-01-01", retribuciones: "24000", ...sit3 }) },
  ...(["2025-12-31", "2027-01-01"] as const).map((payDate) => ({
    label: `SS pay date ${payDate}`, refusal: /2026 only/,
    run: () => calculateEsSeguridadSocial2026({ payDate, grupo: 7, base: "2000", contratoTemporal: false }),
  })),
  { label: "La Palma exceptional claim before 10 September", refusal: /La Palma exceptional regime/,
    run: () => calculateEsIrpf2026({ payDate: "2026-09-09", retribuciones: "24000", ...sit3, zona: "la-palma", rendimientosZona: true }) },
];

for (const row of REFUSALS) {
  test(`refuses: ${row.label}`, () => assert.throws(row.run, row.refusal, row.label));
}

test("TABLA 2 is continuous and non-decreasing across every edge", () => {
  const edges = GOLDENS.flatMap((row) => (row.engine === "escala" ? [Number(row.input)] : [])).sort((a, b) => a - b);
  const at = (base: number) => Number(escalaIrpf2026(Math.max(base, 0).toFixed(2)));
  let prev = -1;
  for (const edge of edges) {
    const [below, cuota, above] = [at(edge - 0.01), at(edge), at(edge + 0.01)];
    assert.ok(cuota >= prev, `escala not monotone at edge ${edge}: ${cuota} after ${prev}`);
    assert.ok(below <= cuota && cuota <= above && above - below <= 0.01, `escala jumps at edge ${edge}: ${below} / ${cuota} / ${above}`);
    prev = cuota;
  }
});

// --- Adapter: the full monthly payslip through the push path ---------------

interface AdapterCase {
  payDate: string;
  priorChanged?: boolean;
  annual?: string;
  periods?: string;
  categoria?: string;
  ctx?: Record<string, string>;
  emp?: Record<string, string>;
}

function esAdapterContext(c: AdapterCase): { ctx: PayrollStatutoryComputeContext; lines: StubLine[] } {
  const lines: StubLine[] = [];
  const pushStatutory = createPushStatutory({
    country: "ES",
    lines,
    emittedEarningsAssessed: new Set<string>(),
    // The component row is a stub; the statutoryAssessment consult inside
    // createPushStatutory is real, so an undeclared (systemKey, kind) throws.
    need: (systemKey: string, kind: string): Record<string, unknown> => ({ id: `${systemKey}:${kind}` }),
  });
  const cert = (key: string, answers: Record<string, string>) => ({
    certificate: ES_CERTIFICATES.certificates.find((item) => item.key === key)!,
    onFile: true, effectiveFrom: null, missing: [], answers,
  });
  const ctx = {
    tx: { execute: async () => ({ rows: [{ changed: c.priorChanged ?? false }] }) },
    orgId: "org", employeePartyId: "employee", documentId: "run", taxYear: 2026, region: "MD",
    run: { pay_date: c.payDate },
    emp: { es_situacion_laboral: "activo", es_grupo_cotizacion: "7", es_ano_nacimiento: "1990",
      es_contrato_temporal: "false", ...c.emp },
    income: "2000.00", nonPeriodic: "", pensionable: "2000.00", insurable: "2000.00", ...c.ctx,
    periodsPerYear: 12,
    pushStatutory,
    certificateFor: (key: string) =>
      key === "es_retribucion_anual"
        ? cert(key, { importe_anual_previsto: c.annual ?? "24000.00", periodos_recurrentes_esperados: c.periods ?? "12" })
        : key === "es_contrato" ? cert(key, { categoria_contrato: c.categoria ?? "general" })
        : key === "es_residencia_fiscal" ? { answers: { residencia: "residente" } }
        : { answers: { zona_residencia: "ninguna", rendimientos_en_zona: "false" } },
    assertRegionSupported: () => {},
  } as unknown as PayrollStatutoryComputeContext;
  return { ctx, lines };
}

const pay = (amount: string) => ({ income: amount, pensionable: amount, insurable: amount });

const ADAPTER_GOLDENS: Array<{
  year: number; label: string; input: AdapterCase; citation: string;
  result?: Record<string, string>;
  /** Partial: componentId → amount. */
  amounts?: Record<string, string>;
  /** Exhaustive, in push order: [componentId, kind, description, amount, sequence, assessedOn]. */
  pushed?: Array<[string, string, string, string, number, string]>;
}> = [
  // RETRIB 24.000, COTIZ 130×12 = 1.560, sit.3 bare → tipo 13,51; 2.000 × 13,51% = 270,20.
  { year: 2026, label: "March payslip pushes IRPF plus all nine SS lines, assessed honestly",
    input: { payDate: "2026-03-15" }, citation: HAND,
    result: { ES_TIPO_IRPF: "13.51", ES_IRPF_MES: "270.2000", ES_EDITION: "2026-early" },
    pushed: [
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
    ] },
  // 510,12 at 0,19%/0,96% plus 388,68 at 0,21%/1,04%, each half-up to the cent.
  { year: 2026, label: "solidaridad lines pushed when pay exceeds the tope máximo",
    input: { payDate: "2026-03-15", annual: "72000.00", ctx: pay("6000.00") }, citation: "Orden PJC/297/2026 art. 17.1",
    amounts: { "ss_solidaridad:deduction": "1.7900", "ss_solidaridad_er:employer_contribution": "8.9400" } },
  { year: 2026, label: "September resolves the late edition", input: { payDate: "2026-09-15" },
    citation: "ALGORITMO 2026 (10 September edition)", result: { ES_EDITION: "2026" } },
  { year: 2026, label: "100,00 non-FM overtime prices the additional 4,70% employee contribution",
    input: { payDate: "2026-09-15", emp: { es_horas_extra_resto: "100.00" } }, citation: "Orden PJC/297/2026 art. 5",
    amounts: { "ss_hex_resto:deduction": "4.7000" } },
  // A December starter's certified year is one month's pay (3.000): TABLA-1 exento for sit.3 (cell 15.876).
  { year: 2026, label: "December starter certified at 3.000 withholds nothing",
    input: { payDate: "2026-12-15", annual: "3000.00", periods: "1", ctx: pay("3000.00") }, citation: `${HAND}, TABLA 1`,
    result: { ES_IMPORTE_ANUAL: "0.0000" } },
  // RETRIB 16.000 prices at most 0,33 general; inferiorAno floors at 2,00.
  { year: 2026, label: "sub-one-year contract floors at the 2% minimum",
    input: { payDate: "2026-05-01", annual: "16000.00", categoria: "inferiorAno" }, citation: "ALGORITMO 2026, contrato inferior al año (2% floor)",
    result: { ES_TIPO_IRPF: "2.00" } },
];

for (const row of ADAPTER_GOLDENS) {
  test(`${row.year} adapter: ${row.label}`, async () => {
    const where = `${row.year} adapter: ${row.label} [${row.citation}]`;
    const { ctx, lines } = esAdapterContext(row.input);
    const result = await computeEsStatutory(ctx);
    assertFields(result, row.result ?? {}, where);
    for (const [id, amount] of Object.entries(row.amounts ?? {})) {
      assert.equal(lines.find((line) => line.componentId === id)?.amount, amount, `${where}: ${id}`);
    }
    if (row.pushed) {
      assert.deepEqual(
        lines.map((l) => [l.componentId, l.kind, l.description, l.amount, l.sequence, l.assessedOn]),
        row.pushed, where,
      );
    }
  });
}

test("adapter counts a pensionable one-off contribution once in annual COTIZACIONES", async () => {
  const { ctx } = esAdapterContext({ payDate: "2026-03-15", annual: "31000.00",
    ctx: { income: "2500.00", nonPeriodic: "1000.00", pensionable: "3500.00", pensionableNonPeriodic: "1000.00", insurable: "3500.00" } });
  const result = await computeEsStatutory(ctx);
  const irpf = (cotizaciones: string) =>
    calculateEsIrpf2026({ payDate: "2026-03-15", retribuciones: "31000", cotizaciones, ...sit3 }).tipo;
  assert.notEqual(irpf("2015"), irpf("2730"));
  assert.equal(result["ES_TIPO_IRPF"], irpf("2015"));
});

test("adapter refuses when committed same-year ordinary pay changed without Article 87 inputs", async () => {
  const { ctx, lines } = esAdapterContext({ payDate: "2026-07-15", priorChanged: true });
  await assert.rejects(
    () => computeEsStatutory(ctx),
    /prior committed pay in this tax year differs.*Article 87.*year-to-date retentions/,
  );
  assert.deepEqual(lines, []);
});
