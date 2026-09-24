/**
 * ES 2026 conformance goldens — the four parity mechanisms.
 *
 * 1. Agency outputs: the ALGORITMO's own worked example (base 24.000 →
 *    CUOTA1 5.365,50) reproduced to the cent. The ALGORITMO publishes no
 *    full-tipo worked example — the cuadro informativo only confirms fixed
 *    special-case rates (consejeros 35%, cursos 15%, atrasos 15%) and
 *    "Variable según procdmto. general (algoritmo)" for employment income —
 *    so full-tipo proof is mechanism 2.
 * 2. Hand-worked cases independent of the engine, arithmetic shown, each
 *    cross-checked against a second implementation before encoding.
 * 3. Date resolution throws on both sides of 2026; 9 September and
 *    10 September resolve to different editions; La Palma is refused early,
 *    accepted late.
 * 4. Sweeps at, below and above every TABLA 2 edge and every TABLA 1 cliff,
 *    plus monotonicity and the SS clamp edges.
 *
 * Run with `node --import tsx` on this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculateEsIrpf2026, escalaIrpf2026 } from "./irpf-2026.ts";
import { calculateEsSeguridadSocial2026 } from "./seguridad-social-2026.ts";

// --- Mechanism 1: the agency's own outputs --------------------------------
// "Para una base de 24.000,00: Hasta 20.200,00: 4.225,50 / Resto:
// 24.000,00 – 20.200,00 = 3.800,00: 3.800,00* 0,30 = 1.140,00 / CUOTA 1=
// 4.225,50 + 1.140, 00 = 5.365,50" (ALGORITMO p.30).
test("agency CUOTA1 example: base 24.000 → 5.365,50", () => {
  assert.equal(escalaIrpf2026("24000"), "5365.5000");
});

// --- Mechanism 2: hand-worked full-tipo cases ------------------------------
// Sit.3, no descendientes, born 1990, RETRIB 24.000, no cotizaciones:
// exención cell 15.876 < 24.000; OTROS 2.000; RNT 24.000; RED20 0 (above
// 19.747,50); RNTREDU 22.000; BASE 22.000; CUOTA1 4.225,50 + 1.800×0,30 =
// 4.765,50; MINPERFA 5.550; CUOTA2 5.550×0,19 = 1.054,50; CUOTA 3.711,00;
// 43% cap binds: (24.000−15.876)×0,43 = 3.493,32; TIPO trunc(14,5555) =
// 14,55; IMPORTE 24.000×14,55% = 3.492,00.
test("hand-worked: sit3 bare 24.000 → tipo 14,55 (43% cap binds)", () => {
  const r = calculateEsIrpf2026({
    payDate: "2026-03-15",
    retribuciones: "24000",
    situacionFamiliar: "3",
    birthYear: 1990,
  });
  assert.equal(r.edition, "2026-early");
  assert.equal(r.exento, false);
  assert.equal(r.base, "22000.0000");
  assert.equal(r.minimoPersonalFamiliar, "5550.0000");
  assert.equal(r.cuota, "3493.3200");
  assert.equal(r.tipo, "14.55");
  assert.equal(r.importeAnual, "3492.0000");
});

// Sit.3, RETRIB 16.000: above the 15.876 cell, RED20 band 2 gives
// 7.302 − 1,75×(16.000−14.852) = 5.293; RNTREDU 16.000−2.000−5.293 = 8.707;
// CUOTA1 8.707×0,19 = 1.654,33; CUOTA2 1.054,50; CUOTA 599,83; 43% cap:
// (16.000−15.876)×0,43 = 53,32; TIPO trunc(0,33325) = 0,33; IMPORTE 52,80.
test("hand-worked: sit3 16.000 → RED20 5.293, tipo 0,33", () => {
  const r = calculateEsIrpf2026({
    payDate: "2026-05-01",
    retribuciones: "16000",
    situacionFamiliar: "3",
    birthYear: 1990,
  });
  assert.equal(r.exento, false);
  assert.equal(r.base, "8707.0000");
  assert.equal(r.cuota, "53.3200");
  assert.equal(r.tipo, "0.33");
  assert.equal(r.importeAnual, "52.8000");
});

// Sit.2, two descendientes (2018 whole, 2021 half), born 1985, RETRIB
// 40.000, COTIZ 1.500: cell 19.262; RNT 38.500; RED20 0; RNTREDU 36.500;
// BASE 36.500; MINDES 2.400 + 2.700×0,5 = 3.750 (neither under 3);
// MINPERFA 9.300; CUOTA1 8.725,50 + 1.300×0,37 = 9.206,50; CUOTA2
// 9.300×0,19 = 1.767,00; CUOTA 7.439,50; no 43% cap (40.000 > 35.200);
// TIPO trunc(18,59875) = 18,59; IMPORTE 7.436,00.
test("hand-worked: sit2 family 40.000 → tipo 18,59", () => {
  const r = calculateEsIrpf2026({
    payDate: "2026-11-20",
    retribuciones: "40000",
    cotizaciones: "1500",
    situacionFamiliar: "2",
    descendientes: [
      { birthYear: 2018, entero: 1, discapacidad: "none", movilidadReducida: false },
      { birthYear: 2021, entero: 0.5, discapacidad: "none", movilidadReducida: false },
    ],
    birthYear: 1985,
  });
  assert.equal(r.edition, "2026");
  assert.equal(r.base, "36500.0000");
  assert.equal(r.minimoPersonalFamiliar, "9300.0000");
  assert.equal(r.cuota, "7439.5000");
  assert.equal(r.tipo, "18.59");
  assert.equal(r.importeAnual, "7436.0000");
});

// Exención: sit.2 no descendientes, RETRIB 17.000 ≤ 17.197 → EXENTOS.
test("hand-worked: sit2 17.000 is exento under TABLA 1", () => {
  const r = calculateEsIrpf2026({
    payDate: "2026-02-01",
    retribuciones: "17000",
    situacionFamiliar: "2",
    birthYear: 1990,
  });
  assert.equal(r.exento, true);
  assert.equal(r.tipo, "0.00");
  assert.equal(r.importeAnual, "0.0000");
});

// Vivienda habitual (RD 1975/2008): sit.3, RETRIB 20.000, MINOPAGO =
// trunc(2% × 20.000) = 400,00. CUOTA1 3.420,00 − CUOTA2 1.054,50 = 2.365,50,
// 43% cap (20.000−15.876)×0,43 = 1.773,32; DIF 1.373,32; TIPO trunc(6,8666)
// = 6,86; IMPORTE 1.372,00.
test("hand-worked: presVivienda 20.000 → tipo 6,86", () => {
  const r = calculateEsIrpf2026({
    payDate: "2026-04-01",
    retribuciones: "20000",
    situacionFamiliar: "3",
    birthYear: 1990,
    presVivienda: true,
  });
  assert.equal(r.cuota, "1773.3200");
  assert.equal(r.tipo, "6.86");
  assert.equal(r.importeAnual, "1372.0000");
});

// Same worker resident in Ceuta with Ceuta yields: DIF = 1.773,32×0,40 −
// 400,00 = 309,328; TIPO trunc(1,54664) = 1,54; IMPORTE 308,00.
test("hand-worked: Ceuta 20.000 + vivienda → tipo 1,54", () => {
  const r = calculateEsIrpf2026({
    payDate: "2026-04-01",
    retribuciones: "20000",
    situacionFamiliar: "3",
    birthYear: 1990,
    presVivienda: true,
    zona: "ceuta-melilla",
    rendimientosZona: true,
  });
  assert.equal(r.tipo, "1.54");
  assert.equal(r.importeAnual, "308.0000");
});

// SS: grupo 7, base 2.000, indefinido. CC 94,00/472,00; desempleo
// 31,00/110,00; FOGASA 4,00; formación 2,00/12,00; MEI 3,00/15,00;
// totals EE 130,00 / ER 613,00.
test("hand-worked: SS grupo 7 base 2.000 → EE 130,00 / ER 613,00", () => {
  const r = calculateEsSeguridadSocial2026({
    payDate: "2026-04-10",
    grupo: 7,
    base: "2000",
  });
  assert.equal(r.baseContingenciasComunes, "2000.0000");
  assert.equal(r.ccTrabajador, "94.0000");
  assert.equal(r.ccEmpresa, "472.0000");
  assert.equal(r.desempleoTrabajador, "31.0000");
  assert.equal(r.desempleoEmpresa, "110.0000");
  assert.equal(r.fogasaEmpresa, "4.0000");
  assert.equal(r.formacionTrabajador, "2.0000");
  assert.equal(r.formacionEmpresa, "12.0000");
  assert.equal(r.meiTrabajador, "3.0000");
  assert.equal(r.meiEmpresa, "15.0000");
  assert.equal(r.solidaridadTrabajador, "0.0000");
  assert.equal(r.solidaridadEmpresa, "0.0000");
  assert.equal(r.atEpEmpresa, null);
  assert.equal(r.trabajadorTotal, "130.0000");
  assert.equal(r.empresaTotal, "613.0000");
});

// SS solidaridad: base 5.101,20, retribución 6.000. Slice 510,12 € @1,15%:
// EE 0,97 / ER 4,90. Slice 388,68 € @1,25%: EE 0,82 / ER 4,04.
// Totals EE 1,79 / ER 8,94 (half-up per line).
test("hand-worked: SS solidaridad on 6.000 → EE 1,79 / ER 8,94", () => {
  const r = calculateEsSeguridadSocial2026({
    payDate: "2026-06-10",
    grupo: 1,
    base: "5101.20",
    retribucionMensual: "6000",
  });
  assert.equal(r.baseContingenciasComunes, "5101.2000");
  assert.equal(r.solidaridadTrabajador, "1.7900");
  assert.equal(r.solidaridadEmpresa, "8.9400");
});

// SS clamp: grupo 1 base 1.500 rises to the 1.989,30 mínima.
// CC EE 1.989,30×4,70% = 93,50 (93,4971 half-up); ER 469,47.
test("hand-worked: SS grupo 1 base 1.500 clamps to 1.989,30", () => {
  const r = calculateEsSeguridadSocial2026({
    payDate: "2026-01-15",
    grupo: 1,
    base: "1500",
  });
  assert.equal(r.baseContingenciasComunes, "1989.3000");
  assert.equal(r.ccTrabajador, "93.5000");
  assert.equal(r.ccEmpresa, "469.4700");
});

// SS diaria + temporal: grupo 9, 60 € × 30 días = 1.800. Desempleo 8,30%:
// EE 28,80 / ER 120,60.
test("hand-worked: SS grupo 9 diaria-temporal → desempleo 28,80/120,60", () => {
  const r = calculateEsSeguridadSocial2026({
    payDate: "2026-07-10",
    grupo: 9,
    base: "60",
    dias: 30,
    contratoTemporal: true,
  });
  assert.equal(r.baseContingenciasComunes, "1800.0000");
  assert.equal(r.desempleoTrabajador, "28.8000");
  assert.equal(r.desempleoEmpresa, "120.6000");
});

// --- Mechanism 3: date resolution ------------------------------------------
test("engine refuses pay dates outside 2026 on both sides", () => {
  const base = {
    retribuciones: "24000",
    situacionFamiliar: "3" as const,
    birthYear: 1990,
  };
  assert.throws(
    () => calculateEsIrpf2026({ ...base, payDate: "2025-12-31" }),
    /rates for 2025 aren't available in this pack version; update the pack/,
  );
  assert.throws(
    () => calculateEsIrpf2026({ ...base, payDate: "2027-01-01" }),
    /rates for 2027 aren't available in this pack version; update the pack/,
  );
  assert.throws(
    () => calculateEsSeguridadSocial2026({ payDate: "2025-12-31", grupo: 7, base: "2000" }),
    /2026 only/,
  );
  assert.throws(
    () => calculateEsSeguridadSocial2026({ payDate: "2027-01-01", grupo: 7, base: "2000" }),
    /2026 only/,
  );
});

test("La Palma exceptional claim is refused early, accepted late", () => {
  const base = {
    retribuciones: "24000",
    situacionFamiliar: "3" as const,
    birthYear: 1990,
    zona: "la-palma" as const,
    rendimientosZona: true,
  };
  assert.throws(
    () => calculateEsIrpf2026({ ...base, payDate: "2026-09-09" }),
    /La Palma exceptional regime/,
  );
  const late = calculateEsIrpf2026({ ...base, payDate: "2026-09-10" });
  assert.equal(late.edition, "2026");
  assert.equal(late.exento, false);
});

// --- Mechanism 4: sweeps ----------------------------------------------------
test("TABLA 2 edges hold their cuotas and monotonicity never breaks", () => {
  const edges: Array<[string, string]> = [
    ["0", "0.0000"],
    ["12450", "2365.5000"],
    ["20200", "4225.5000"],
    ["35200", "8725.5000"],
    ["60000", "17901.5000"],
    ["300000", "125901.5000"],
  ];
  let prev = -1;
  for (const [edge, cuota] of edges) {
    assert.equal(escalaIrpf2026(edge), cuota, `edge ${edge}`);
    const value = Number(escalaIrpf2026(edge));
    assert.ok(value >= prev, `monotone at ${edge}`);
    prev = value;
    for (const delta of ["-0.01", "0.01"]) {
      const near = (Number(edge) + Number(delta)).toFixed(2);
      const nearValue = Number(escalaIrpf2026(near));
      assert.ok(nearValue >= prev - 0.01 && nearValue <= value + value * 0.5 + 1, `near ${near}`);
      if (Number(delta) < 0 && Number(edge) > 0) assert.ok(nearValue <= value, `below ${near}`);
      if (Number(delta) > 0) assert.ok(nearValue >= value, `above ${near}`);
    }
  }
  // Deep top: open 47% row.
  assert.equal(escalaIrpf2026("400000"), "172901.5000");
});

test("TABLA 1 cliffs flip exención at the cell", () => {
  const at = (retrib: string) =>
    calculateEsIrpf2026({
      payDate: "2026-03-15",
      retribuciones: retrib,
      situacionFamiliar: "2",
      birthYear: 1990,
    }).exento;
  // Sit.2/0 cell is 17.197.
  assert.equal(at("17196.99"), true);
  assert.equal(at("17197"), true);
  assert.equal(at("17197.01"), false);
});

test("SS clamp edges: minima floor and tope máximo cap", () => {
  const floor = calculateEsSeguridadSocial2026({ payDate: "2026-03-15", grupo: 4, base: "1000" });
  assert.equal(floor.baseContingenciasComunes, "1424.4000");
  const atMin = calculateEsSeguridadSocial2026({ payDate: "2026-03-15", grupo: 4, base: "1424.40" });
  assert.equal(atMin.baseContingenciasComunes, "1424.4000");
  const cap = calculateEsSeguridadSocial2026({ payDate: "2026-03-15", grupo: 1, base: "9000" });
  assert.equal(cap.baseContingenciasComunes, "5101.2000");
  assert.ok(Number(cap.trabajadorTotal) < Number("9000") * 0.09);
});
