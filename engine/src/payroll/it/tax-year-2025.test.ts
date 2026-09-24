/**
 * IT 2025 conformance goldens.
 *
 * External goldens: AdE Circolare 4/E/2025 Esempi 1–3 (the only worked
 * examples the authority publishes for the 2025 package) — inputs quoted
 * from the circular, outputs asserted to the penny. Everything else is
 * hand-worked from the transcribed tables with the arithmetic shown in
 * comments, independent of the engine code.
 *
 * Isolation rule: goldens that prove one table pass pensionable "0" (no
 * contribution noise) and zero surtax rates, and say so. The INPS and
 * surtax paths are proven by their own goldens.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculateIt2025 } from "./compute-statutory.ts";
import {
  IT_2025_IRPEF_CUMULATIVE,
  IT_REFUSED_2025,
} from "./tax-year-2025.ts";

const BASE = {
  periodsPerYear: 12,
  regionCode: "03",
  comuneCode: "H501",
  regionalRate: "0",
  municipalSurtax: { rate: "0" },
  hasDetrazioniDeclaration: false,
};

test("Circ. 4/E Esempio 1: somma 106 euro", () => {
  // "Un contribuente nell'anno 2025: – ha un reddito complessivo pari a
  // 6.000 euro; – è titolare di un contratto di lavoro dipendente dal
  // 1° gennaio 2025 al 3 marzo 2025 (62 giorni di lavoro dipendente), per
  // il quale percepisce complessivamente un reddito di lavoro dipendente
  // pari a 2.000 euro. Il reddito annuale teorico è pari a 11.744,19 euro
  // [(2.000:62) x 365]. La somma spettante è pari a 106 euro, determinata
  // applicando la percentuale relativa ai redditi da 8.501 euro a 15.000
  // euro (5,3 per cento) al reddito di lavoro dipendente effettivamente
  // percepito nell'anno (2.000 euro)."
  // NOTE: 2.000/62x365 recomputes to 11.774,19 — a likely digit
  // transposition in the circular that does not move the band (both sit in
  // 8.501–15.000 → 5,3%). The esempio abstracts from contributions, so
  // pensionable is 0 and the 2.000 reddito passes through untouched.
  const r = calculateIt2025({
    ...BASE,
    annualGrossEmployment: "2000",
    annualPensionable: "0",
    sommaBandBase: "11744.19",
    presumedTotalIncome: "6000",
  });
  assert.equal(r.redditoComplessivo, "6000.0000");
  assert.equal(r.somma, "106.0000"); // 5,3% x 2.000
});

test("Circ. 4/E Esempio 2: somma 159 euro", () => {
  // "... dal 1° gennaio 2025 al 3 marzo 2025 ... 2.000 euro; – è titolare
  // di un contratto ... dal 1° novembre 2025 al 30 novembre 2025 ... pari
  // a 1.000 euro. Il reddito annuale teorico è pari a 11.902,17 euro
  // [(2.000 + 1.000):(62 + 30) x 365]. La somma spettante è pari a 159
  // euro, determinata applicando la percentuale relativa ai redditi da
  // 8.501 euro a 15.000 euro (5,3 per cento) al reddito di lavoro
  // dipendente effettivamente percepito nell'anno (3.000 euro)."
  // 3.000/92x365 = 11.902,1739 → 11.902,17: recomputes exactly.
  const r = calculateIt2025({
    ...BASE,
    annualGrossEmployment: "3000",
    annualPensionable: "0",
    sommaBandBase: "11902.17",
  });
  assert.equal(r.somma, "159.0000"); // 5,3% x 3.000
});

test("Circ. 4/E Esempio 3: somma 238,50 euro", () => {
  // "la quota di reddito da lavoro dipendente imponibile in Italia è pari
  // a 4.500 euro; – la quota esente ... è pari a 10.500 euro. Il reddito
  // complessivo ... è pari a 15.000 euro ... La somma spettante è pari a
  // 238,50 euro, determinata applicando la percentuale relativa ai redditi
  // da 8.501 euro a 15.000 euro (5,3 per cento) alla quota imponibile del
  // reddito di lavoro dipendente effettivamente percepito e soggetto a
  // tassazione in Italia nell'anno (4.500 euro)."
  const r = calculateIt2025({
    ...BASE,
    annualGrossEmployment: "4500",
    annualPensionable: "0",
    sommaBandBase: "15000",
    presumedTotalIncome: "15000",
  });
  assert.equal(r.redditoComplessivo, "15000.0000");
  assert.equal(r.somma, "238.5000"); // 5,3% x 4.500
});

test("IRPEF band boundaries: 6.440 at 28.000, 14.140 at 50.000", () => {
  // 28.000 x 23% = 6.440; 6.440 + 22.000 x 35% = 14.140.
  const at28 = calculateIt2025({ ...BASE, annualGrossEmployment: "28000", annualPensionable: "0" });
  assert.equal(at28.irpefLorda, `${IT_2025_IRPEF_CUMULATIVE.at28000}.0000`);
  const at50 = calculateIt2025({ ...BASE, annualGrossEmployment: "50000", annualPensionable: "0" });
  assert.equal(at50.irpefLorda, `${IT_2025_IRPEF_CUMULATIVE.at50000}.0000`);
  // 100.000: 14.140 + 43% x 50.000 = 35.640.
  const at100 = calculateIt2025({ ...BASE, annualGrossEmployment: "100000", annualPensionable: "0" });
  assert.equal(at100.irpefLorda, "35640.0000");
});

test("detrazione lavoro taper with truncated 4dp ratios", () => {
  // R = 20.000: 1.910 + 1.190 x trunc4(8.000/13.000) = 1.910 + 1.190 x
  // 0,6153 = 1.910 + 732,207 → 2.642,21.
  const at20 = calculateIt2025({
    ...BASE, annualGrossEmployment: "20000", annualPensionable: "0", hasDetrazioniDeclaration: true,
  });
  assert.equal(at20.detrazioneLavoro, "2642.2100");
  // R = 40.000: 1.910 x trunc4(10.000/22.000) = 1.910 x 0,4545 = 868,095
  // → 868,10. No +65: R = 40.000 sits outside art. 13 c. 2's R > 25.000–35.000 band.
  // Ulteriore detrazione is 0 at exactly 40.000, so no capienza split.
  const at40 = calculateIt2025({
    ...BASE, annualGrossEmployment: "40000", annualPensionable: "0", hasDetrazioniDeclaration: true,
  });
  assert.equal(at40.detrazioneLavoro, "868.1000");
  assert.equal(at40.ulterioreDetrazione, "0.0000");
  // R = 30.000 (pens 0): 1.910 x trunc4(20.000/22.000 = 0,9090) =
  // 1.736,19, plus 65 (inside art. 13 c. 2's R > 25.000 band) → 1.801,19.
  const at30 = calculateIt2025({
    ...BASE, annualGrossEmployment: "30000", annualPensionable: "0", hasDetrazioniDeclaration: true,
  });
  assert.equal(at30.detrazioneLavoro, "1801.1900");
});

test("ulteriore detrazione: flat 1.000 then decalage to zero", () => {
  const flat = calculateIt2025({
    ...BASE, annualGrossEmployment: "32000", annualPensionable: "0",
  });
  assert.equal(flat.ulterioreDetrazione, "1000.0000");
  // R = 36.000: 1.000 x (40.000 − 36.000)/8.000 = 500.
  const mid = calculateIt2025({
    ...BASE, annualGrossEmployment: "36000", annualPensionable: "0",
  });
  assert.equal(mid.ulterioreDetrazione, "500.0000");
});

test("trattamento integrativo and somma at 9.500 euro", () => {
  // lorda = 23% x 9.500 = 2.185 > 1.955 − 75 = 1.880 → TI 1.200.
  // detrazione capped by lorda: min(1.955, 2.185) = 1.955 → netta 230.
  // somma: band by 9.500 → 5,3% x 9.500 = 503,50.
  const r = calculateIt2025({
    ...BASE, annualGrossEmployment: "9500", annualPensionable: "0", hasDetrazioniDeclaration: true,
  });
  assert.equal(r.irpefLorda, "2185.0000");
  assert.equal(r.detrazioneLavoro, "1955.0000");
  assert.equal(r.irpefNetta, "230.0000");
  assert.equal(r.trattamentoIntegrativo, "1200.0000");
  assert.equal(r.somma, "503.5000");
});

test("no declaration means gross IRPEF: detrazione 0, TI still paid", () => {
  // Art. 13 needs the dichiarazione; TI and somma are automatic (Circ. 4/E).
  // R = 9.500, pens 0: lorda 2.185, detrazione 0 → netta 2.185; TI condition
  // reads the spettante (ungated) detrazione: 2.185 > 1.880 → 1.200.
  const r = calculateIt2025({
    ...BASE, annualGrossEmployment: "9500", annualPensionable: "0", hasDetrazioniDeclaration: false,
  });
  assert.equal(r.detrazioneLavoro, "0.0000");
  assert.equal(r.irpefNetta, "2185.0000");
  assert.equal(r.trattamentoIntegrativo, "1200.0000");
  assert.equal(r.somma, "503.5000");
});

test("INPS pre-1996 at 60.000: 9,19% plus 1% over 55.448", () => {
  // Worker: 9,19% x 60.000 = 5.514 + 1% x (60.000 − 55.448) = 45,52 →
  // 5.559,52. Employer: 23,81% x 60.000 = 14.286.
  const r = calculateIt2025({
    ...BASE, annualGrossEmployment: "60000", annualPensionable: "60000",
  });
  assert.equal(r.inpsWorker, "5559.5200");
  assert.equal(r.inpsEmployer, "14286.0000");
});

test("INPS post-1995 at 130.000: capped at the 120.607 massimale", () => {
  // Base min(130.000, 120.607) = 120.607. Worker: 9,19% x 120.607 =
  // 11.083,7833 → 11.083,78 plus 1% x (120.607 − 55.448) = 651,59 →
  // 11.735,37. Employer: 23,81% x 120.607 = 28.716,5267 → 28.716,53.
  const r = calculateIt2025({
    ...BASE, annualGrossEmployment: "130000", annualPensionable: "130000", isPost1995: true,
  });
  assert.equal(r.inpsWorker, "11735.3700");
  assert.equal(r.inpsEmployer, "28716.5300");
});

test("surtaxes from declared rates; comunale exemption zeroes at the soglia", () => {
  // Abano-Terme style: 0,8% with a 12.000 soglia. Imponibile 12.000 → 0.
  const exempt = calculateIt2025({
    ...BASE,
    annualGrossEmployment: "12000",
    annualPensionable: "0",
    regionalRate: "1.23",
    municipalSurtax: { rate: "0.8", exemption: "12000" },
  });
  assert.equal(exempt.addizionaleComunale, "0.0000");
  // 1,23% x 12.000 = 147,60 regionale still applies (no regional soglia).
  assert.equal(exempt.addizionaleRegionale, "147.6000");
  // One cent above the soglia: 0,8% x 12.000,01 = 96,00008 → 96,00.
  const above = calculateIt2025({
    ...BASE,
    annualGrossEmployment: "12000.01",
    annualPensionable: "0",
    regionalRate: "1.23",
    municipalSurtax: { rate: "0.8", exemption: "12000" },
  });
  assert.equal(above.addizionaleComunale, "96.0000");
});

test("period split divides the annual figures half-up to the cent", () => {
  // 30.000 gross, 12 mensilità, declaration on file, 1,23%/0,8%:
  // inps W 2.757 → R 27.243 → lorda 23% x 27.243 = 6.265,89;
  // det 1.910 + 1.190 x trunc4(757/13.000 = 0,0582) = 1.979,26, +65 →
  // 2.044,26; ulteriore 1.000; netta 3.221,63; TI 0 (R > 15.000, no
  // family); somma 0 (R > 20.000); regionale 1,23% x 27.243 = 335,0889 →
  // 335,09; comunale 0,8% x 27.243 = 217,944 → 217,94.
  const r = calculateIt2025({
    ...BASE,
    annualGrossEmployment: "30000",
    annualPensionable: "30000",
    hasDetrazioniDeclaration: true,
    regionalRate: "1.23",
    municipalSurtax: { rate: "0.8" },
  });
  assert.equal(r.redditoComplessivo, "27243.0000");
  assert.equal(r.irpefLorda, "6265.8900");
  assert.equal(r.detrazioneLavoro, "2044.2600");
  assert.equal(r.ulterioreDetrazione, "1000.0000");
  assert.equal(r.irpefNetta, "3221.6300");
  assert.equal(r.trattamentoIntegrativo, "0.0000");
  assert.equal(r.somma, "0.0000");
  assert.equal(r.inpsWorker, "2757.0000");
  assert.equal(r.inpsEmployer, "7143.0000");
  assert.equal(r.addizionaleRegionale, "335.0900");
  assert.equal(r.addizionaleComunale, "217.9400");
  assert.equal(r.period.irpef, "268.4700"); // 3.221,63/12 = 268,4691 → .47
  assert.equal(r.period.inpsWorker, "229.7500");
  assert.equal(r.period.trattamentoIntegrativo, "0.0000");
});

test("refusals name the gap: pensioner, region, comune, rates, family TI", () => {
  const ok = {
    ...BASE,
    annualGrossEmployment: "20000",
    annualPensionable: "20000",
    regionalRate: "1.23",
    municipalSurtax: { rate: "0.8" },
  };
  assert.throws(() => calculateIt2025({ ...ok, isPensioner: true }), /TABELLA 7/);
  assert.throws(() => calculateIt2025({ ...ok, regionCode: "XX" }), /unknown IT regione/);
  assert.throws(() => calculateIt2025({ ...ok, comuneCode: null }), /domicile comune is unknown/);
  assert.throws(() => calculateIt2025({ ...ok, comuneCode: "ROMA" }), /codice catastale/);
  assert.throws(() => calculateIt2025({ ...ok, regionalRate: null }), /it_addizionale_regionale/);
  assert.throws(() => calculateIt2025({ ...ok, municipalSurtax: null }), /it_addizionale_comunale/);
  // Family charges in the 15.001–28.000 band: TI unverifiable.
  assert.throws(
    () => calculateIt2025({ ...ok, annualGrossEmployment: "25000", annualPensionable: "25000", hasFamilyCharges: true }),
    /15\.001–28\.000/,
  );
  // Same income without family: TI 0, computed.
  const noFam = calculateIt2025({
    ...ok, annualGrossEmployment: "25000", annualPensionable: "25000", hasFamilyCharges: false,
  });
  assert.equal(noFam.trattamentoIntegrativo, "0.0000");
  assert.throws(() => calculateIt2025({ ...ok, annualGrossEmployment: "-1" }), /non-negative/);
});

test("refused list stays honest about the out-of-scope mechanics", () => {
  assert.ok(IT_REFUSED_2025.length >= 15);
  assert.ok(IT_REFUSED_2025.some((r) => r.includes("art. 12 TUIR")));
  assert.ok(IT_REFUSED_2025.some((r) => r.includes("TFR")));
  assert.ok(IT_REFUSED_2025.some((r) => r.includes("INAIL")));
});

test("c. 2 +65 boundary is cent-precise: 25,000.00 / 25,000.01 / 25,000.50", () => {
  // TUIR art. 13 c. 2: "superiore a 25.000 euro ma non a 35.000 euro". R is
  // cent-precise, so the gate is R > 25.000 — a 25.001 whole-euro floor
  // prices 25.000,01–25.000,99 at 0 instead of 65. Band-B detC1 is identical
  // at all three points (trunc4((28.000 − R)/13.000) = 0,2307 → 1.910 +
  // 1.190 × 0,2307 = 2.184,53), so the ONLY movement across the gate is
  // the +65. Pensionable "0" keeps R exactly on the gross (no INPS noise).
  const atFloor = calculateIt2025({
    ...BASE, annualGrossEmployment: "25000.00", annualPensionable: "0", hasDetrazioniDeclaration: true,
  });
  assert.equal(atFloor.redditoComplessivo, "25000.0000");
  assert.equal(atFloor.detrazioneLavoro, "2184.5300");
  const atCent = calculateIt2025({
    ...BASE, annualGrossEmployment: "25000.01", annualPensionable: "0", hasDetrazioniDeclaration: true,
  });
  assert.equal(atCent.redditoComplessivo, "25000.0100");
  assert.equal(atCent.detrazioneLavoro, "2249.5300");
  const atHalf = calculateIt2025({
    ...BASE, annualGrossEmployment: "25000.50", annualPensionable: "0", hasDetrazioniDeclaration: true,
  });
  assert.equal(atHalf.redditoComplessivo, "25000.5000");
  assert.equal(atHalf.detrazioneLavoro, "2249.5300");
});
