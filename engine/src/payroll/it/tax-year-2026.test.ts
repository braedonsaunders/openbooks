/**
 * IT 2026 conformance goldens.
 *
 * External goldens: the AdE rates-page note (upd. 16/01/2026) — the only
 * agency-published worked output for the 2026 package ("for taxable incomes
 * exceeding €50,000, the due tax is €13,700 ... and 43%") — plus the
 * INPS-authored 2026 annual values (Circ. 6/2026 via mirrors, Circ. 27/2026
 * for the FPLD total and massimale). The Circ. 4/E/2025 worked somma example
 * re-proved here pins the WIRING (L. 207/2024 c. 4 carries no sunset), not
 * the law. Everything else is hand-worked from the transcribed tables with
 * the arithmetic shown in comments, independent of the engine code.
 *
 * Isolation rule (same as 2025): goldens that prove one table pass
 * pensionable "0" (no contribution noise) and zero surtax rates, and say
 * so. The INPS and surtax paths are proven by their own goldens.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculateIt2026 } from "./compute-statutory.ts";
import {
  IT_2026_IRPEF_CUMULATIVE,
  IT_REFUSED_2026,
} from "./tax-year-2026.ts";

const BASE = {
  periodsPerYear: 12,
  regionCode: "03",
  comuneCode: "H501",
  regionalRate: "0",
  municipalSurtax: { rate: "0" },
  hasDetrazioniDeclaration: false,
};

test("AdE note golden: 6.440 at 28.000, 13.700 at 50.000", () => {
  // 28.000 x 23% = 6.440 (carried); 6.440 + 22.000 x 33% = 13.700 (the
  // agency's own 2026 figure, quoted in tax-year-2026.ts).
  const at28 = calculateIt2026({ ...BASE, annualGrossEmployment: "28000", annualPensionable: "0" });
  assert.equal(at28.irpefLorda, `${IT_2026_IRPEF_CUMULATIVE.at28000}.0000`);
  const at50 = calculateIt2026({ ...BASE, annualGrossEmployment: "50000", annualPensionable: "0" });
  assert.equal(at50.irpefLorda, `${IT_2026_IRPEF_CUMULATIVE.at50000}.0000`);
  // 100.000: 13.700 + 43% x 50.000 = 35.200.
  const at100 = calculateIt2026({ ...BASE, annualGrossEmployment: "100000", annualPensionable: "0" });
  assert.equal(at100.irpefLorda, "35200.0000");
});

test("33% band edges: sweep at, below and above every edge, plus monotonicity", () => {
  // 27.999: 23% x 27.999 = 6.439,77. 28.001: 6.440 + 33% x 1 = 6.440,33.
  const below28 = calculateIt2026({ ...BASE, annualGrossEmployment: "27999", annualPensionable: "0" });
  assert.equal(below28.irpefLorda, "6439.7700");
  const above28 = calculateIt2026({ ...BASE, annualGrossEmployment: "28001", annualPensionable: "0" });
  assert.equal(above28.irpefLorda, "6440.3300");
  // 49.999: 6.440 + 33% x 21.999 = 13.699,67. 50.001: 13.700 + 43% = 13.700,43.
  const below50 = calculateIt2026({ ...BASE, annualGrossEmployment: "49999", annualPensionable: "0" });
  assert.equal(below50.irpefLorda, "13699.6700");
  const above50 = calculateIt2026({ ...BASE, annualGrossEmployment: "50001", annualPensionable: "0" });
  assert.equal(above50.irpefLorda, "13700.4300");
  // Monotone non-decreasing across the whole 2026 scale: a higher reddito
  // never owes less lorda. Numeric comparison — these are fixed-scale
  // decimal strings, so a lexicographic >= would misorder 1.150 vs 920.
  let prev = 0;
  for (let gross = 0; gross <= 100000; gross += 1000) {
    const r = calculateIt2026({
      ...BASE, annualGrossEmployment: String(gross), annualPensionable: "0",
    });
    const lorda = Number(r.irpefLorda);
    assert.ok(Number.isFinite(lorda) && lorda >= prev, `${gross}: ${r.irpefLorda} < ${prev}`);
    prev = lorda;
  }
});

test("detrazione lavoro taper unchanged (standing art. 13, untouched for 2026)", () => {
  // R = 20.000: 1.910 + 1.190 x trunc4(8.000/13.000) = 1.910 + 1.190 x
  // 0,6153 = 1.910 + 732,207 → 2.642,21.
  const at20 = calculateIt2026({
    ...BASE, annualGrossEmployment: "20000", annualPensionable: "0", hasDetrazioniDeclaration: true,
  });
  assert.equal(at20.detrazioneLavoro, "2642.2100");
  // R = 30.000: 1.910 x trunc4(20.000/22.000 = 0,9090) = 1.736,19, +65 → 1.801,19.
  const at30 = calculateIt2026({
    ...BASE, annualGrossEmployment: "30000", annualPensionable: "0", hasDetrazioniDeclaration: true,
  });
  assert.equal(at30.detrazioneLavoro, "1801.1900");
});

test("ulteriore detrazione (c. 6 carries no sunset): flat 1.000 then decalage", () => {
  const flat = calculateIt2026({
    ...BASE, annualGrossEmployment: "32000", annualPensionable: "0",
  });
  assert.equal(flat.ulterioreDetrazione, "1000.0000");
  // R = 36.000: 1.000 x (40.000 − 36.000)/8.000 = 500.
  const mid = calculateIt2026({
    ...BASE, annualGrossEmployment: "36000", annualPensionable: "0",
  });
  assert.equal(mid.ulterioreDetrazione, "500.0000");
});

test("somma (c. 4 carries no sunset): Circ. 4/E Esempio 2 re-proved for 2026", () => {
  // Same circular mechanics as the 2025 golden: 3.000 reddito with an
  // 11.902,17 theoretical annual sits in 8.501–15.000 → 5,3% x 3.000 = 159.
  const r = calculateIt2026({
    ...BASE,
    annualGrossEmployment: "3000",
    annualPensionable: "0",
    sommaBandBase: "11902.17",
  });
  assert.equal(r.somma, "159.0000");
});

test("trattamento integrativo and somma at 9.500 euro", () => {
  // lorda = 23% x 9.500 = 2.185 > 1.955 − 75 = 1.880 → TI 1.200.
  // detrazione capped by lorda: min(1.955, 2.185) = 1.955 → netta 230.
  // somma: band by 9.500 → 5,3% x 9.500 = 503,50.
  const r = calculateIt2026({
    ...BASE, annualGrossEmployment: "9500", annualPensionable: "0", hasDetrazioniDeclaration: true,
  });
  assert.equal(r.irpefLorda, "2185.0000");
  assert.equal(r.detrazioneLavoro, "1955.0000");
  assert.equal(r.irpefNetta, "230.0000");
  assert.equal(r.trattamentoIntegrativo, "1200.0000");
  assert.equal(r.somma, "503.5000");
});

test("the 200k sterilizzazione has no engine effect: 250.000 computes, not refuses", () => {
  // L. 199/2025 c. 4 reduces only the art. 16-ter oneri detrazioni, which
  // the engine does not carry — so a 250.000 reddito prices the same lorda
  // it would without c. 4: 13.700 + 43% x 200.000 = 99.700, no detrazioni
  // (R > 50.000), no ulteriore, netta = lorda. Refusing here would block
  // legitimate pay; the reduction lives in IT_REFUSED_2026, not in a branch.
  const r = calculateIt2026({
    ...BASE, annualGrossEmployment: "250000", annualPensionable: "0", hasDetrazioniDeclaration: true,
  });
  assert.equal(r.irpefLorda, "99700.0000");
  assert.equal(r.detrazioneLavoro, "0.0000");
  assert.equal(r.ulterioreDetrazione, "0.0000");
  assert.equal(r.irpefNetta, "99700.0000");
  assert.equal(r.trattamentoIntegrativo, "0.0000");
  assert.equal(r.somma, "0.0000");
});

test("INPS 2026 pre-1996 at 60.000: 9,19% plus 1% over 56.224", () => {
  // Worker: 9,19% x 60.000 = 5.514 + 1% x (60.000 − 56.224) = 37,76 →
  // 5.551,76. Employer: 23,81% x 60.000 = 14.286.
  const r = calculateIt2026({
    ...BASE, annualGrossEmployment: "60000", annualPensionable: "60000",
  });
  assert.equal(r.inpsWorker, "5551.7600");
  assert.equal(r.inpsEmployer, "14286.0000");
});

test("INPS 2026 post-1995 at 130.000: capped at the 122.295 massimale", () => {
  // Base min(130.000, 122.295) = 122.295. Worker: 9,19% x 122.295 =
  // 11.238,9105 → 11.238,91 plus 1% x (122.295 − 56.224) = 660,71 →
  // 11.899,62. Employer: 23,81% x 122.295 = 29.118,4395 → 29.118,44.
  const r = calculateIt2026({
    ...BASE, annualGrossEmployment: "130000", annualPensionable: "130000", isPost1995: true,
  });
  assert.equal(r.inpsWorker, "11899.6200");
  assert.equal(r.inpsEmployer, "29118.4400");
});

test("missing rates refuse naming the 2026 scope point", () => {
  const ok = {
    ...BASE,
    annualGrossEmployment: "20000",
    annualPensionable: "20000",
    regionalRate: "1.23",
    municipalSurtax: { rate: "0.8" },
  };
  assert.throws(() => calculateIt2026({ ...ok, regionalRate: null }), /in 2026/);
  assert.throws(
    () => calculateIt2026({ ...ok, municipalSurtax: null }),
    /it_addizionale_comunale.*H501.*in 2026/,
  );
  // Family charges in the 15.001–28.000 band: TI unverifiable, 2026 list named.
  assert.throws(
    () => calculateIt2026({
      ...ok, annualGrossEmployment: "25000", annualPensionable: "25000", hasFamilyCharges: true,
    }),
    /IT_REFUSED_2026/,
  );
});

test("refused list carries 2025's gaps plus the 2026-only substitute regimes", () => {
  assert.ok(IT_REFUSED_2026.length >= 15);
  assert.ok(IT_REFUSED_2026.some((r) => r.includes("art. 12 TUIR")));
  assert.ok(IT_REFUSED_2026.some((r) => r.includes("TFR")));
  assert.ok(IT_REFUSED_2026.some((r) => r.includes("INAIL")));
  assert.ok(IT_REFUSED_2026.some((r) => r.includes("5%")), "c. 7 rinnovi regime refused by name");
  assert.ok(IT_REFUSED_2026.some((r) => r.includes("15%")), "c. 10–11 turni regime refused by name");
  assert.ok(IT_REFUSED_2026.some((r) => r.includes("200.000")), "sterilizzazione recorded, not branched");
});
