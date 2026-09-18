/**
 * NL 2026 loonheffing conformance tests — the parity bar from
 * `engine/src/payroll/canada/t4127.test.ts`, all four mechanisms:
 *
 * 1. Goldens from the authority's own published output: rows of the witte
 *    maandtabel (Nederland, Standaard, uitgave januari 2026,
 *    download.belastingdienst.nl) — the "zonder loonheffingskorting" column
 *    pins X1/F, the "met" column pins X/F after kortingen, and the
 *    "verrekende arbeidskorting" column pins ARK/F independently.
 * 2. Hand-worked cases independent of the engine: the AHK phase-out and the
 *    three-stage ARK build-up recomputed by hand in the comments.
 * 3. Date resolution that THROWS outside the transcribed year.
 * 4. A sweep across every band boundary (schijven, AHK, ARK, Lmax, premieloon).
 *
 * Money assertions use the engine's integer cents through d4-style 4dp
 * strings; table figures below are quoted verbatim (Dutch commas converted).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateNlStatutory,
  nlRatesForTaxYear,
} from "./loonheffing.ts";

const DECL = { awfLow: true, aofHigh: false, whkPercent: "1.25" } as const;

const cents2 = (c: bigint): string => `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`;

test("year resolution: 2026 computes, every other year throws by name", () => {
  assert.equal(nlRatesForTaxYear(2026), 2026);
  for (const year of [2025, 2027, 2030]) {
    assert.throws(() => nlRatesForTaxYear(year), /no transcribed loonheffing tables/, `${year}`);
  }
  // The pure calculation is yearless by construction: the year gate lives in
  // nlRatesForTaxYear (unit) and computeNlStatutory (pack wiring, pack.test.ts).
  const r = calculateNlStatutory({ income: "999.00", periodsPerYear: 12, applyKorting: true, ...DECL });
  assert.equal(r.annualWage, 11988);
});

test("period factors: the five published tijdvakfactoren price, others throw", () => {
  for (const p of [4, 12, 13, 52, 260]) {
    const r = calculateNlStatutory({ income: "100.00", periodsPerYear: p, applyKorting: false, svWage: "0" });
    assert.ok(r.withholdingCents >= 0n, `${p}`);
  }
  for (const p of [1, 24, 26]) {
    assert.throws(
      () => calculateNlStatutory({ income: "100.00", periodsPerYear: p, applyKorting: false, svWage: "0" }),
      /tijdvakfactoren/,
      `${p} has no published factor`,
    );
  }
});

test("witte maandtabel goldens, jonger dan de AOW-leeftijd (zonder / met / verrekende ARK)", () => {
  // [tabelloon, zonder, met, ark] quoted from the published maandtabel.
  const rows: [string, string, string, string][] = [
    ["999.00", "357.08", "13.83", "83.67"],
    ["2002.50", "715.83", "61.42", "394.83"],
    ["2497.50", "892.83", "186.00", "448.42"],
    ["4999.50", "1819.08", "1325.08", "395.67"],
    ["11092.50", "4651.67", "4651.67", "0.00"],
  ];
  for (const [tvl, zonder, met, ark] of rows) {
    const plain = calculateNlStatutory({ income: tvl, periodsPerYear: 12, applyKorting: false, ...DECL });
    assert.equal(cents2(plain.periodicCents), zonder, `${tvl} zonder`);
    assert.equal(cents2(plain.tableWageCents), tvl, `${tvl} tabelloon`);
    const korting = calculateNlStatutory({ income: tvl, periodsPerYear: 12, applyKorting: true, ...DECL });
    assert.equal(cents2(korting.periodicCents), met, `${tvl} met`);
    assert.equal(cents2(korting.arkPeriodicCents), ark, `${tvl} verrekende ARK`);
  }
});

test("schijf boundary pair: L=38.880 prices schijf 1, L=38.934 prices schijf 2", () => {
  // Tabelloon € 3.240,00 → L = 38.880 (≤ 38.883): X1 = 38.880 × 35,75% =
  // 13.899,60 → 13.899. Tabel: zonder 1.158,25 (13.899/12), met 484,50.
  const below = calculateNlStatutory({ income: "3240.00", periodsPerYear: 12, applyKorting: true, ...DECL });
  assert.equal(below.annualWage, 38880);
  assert.equal(below.grossAnnual, 13899);
  assert.equal(cents2(below.periodicCents), "484.50");
  assert.equal(cents2(below.arkPeriodicCents), "462.92");
  // Tabelloon € 3.244,50 → L = 38.934: X1 = 13.900 + 51 × 37,56% =
  // 13.900 + 19,15 → 13.919. Tabel: zonder 1.159,92, met 486,33.
  const above = calculateNlStatutory({ income: "3244.50", periodsPerYear: 12, applyKorting: true, ...DECL });
  assert.equal(above.annualWage, 38934);
  assert.equal(above.grossAnnual, 13919);
  assert.equal(cents2(above.periodicCents), "486.33");
  assert.equal(cents2(above.arkPeriodicCents), "463.00");
});

test("schijf boundary pair at the top: L=78.408 prices schijf 2, L=78.462 prices schijf 3", () => {
  // € 6.534,00 → L = 78.408: X1 = 13.900 + 39.525 × 37,56% = 13.900 +
  // 14.845,59 → 28.745. Tabel: zonder 2.395,42, met 2.099,58.
  const below = calculateNlStatutory({ income: "6534.00", periodsPerYear: 12, applyKorting: true, ...DECL });
  assert.equal(below.annualWage, 78408);
  assert.equal(below.grossAnnual, 28745);
  assert.equal(cents2(below.periodicCents), "2099.58");
  // € 6.538,50 → L = 78.462: X1 = 28.752 + 36 × 49,50% = 28.752 + 17,82 →
  // 28.769. Tabel: zonder 2.397,42, met 2.101,92.
  const above = calculateNlStatutory({ income: "6538.50", periodsPerYear: 12, applyKorting: true, ...DECL });
  assert.equal(above.annualWage, 78462);
  assert.equal(above.grossAnnual, 28769);
  assert.equal(cents2(above.periodicCents), "2101.92");
});

test("hand-worked AHK phase-out: full below € 29.736, tapered just above", () => {
  // L = 11.988 ≤ 29.736 → AHK = € 3.115 (basisbedrag, no phase-out).
  const full = calculateNlStatutory({ income: "999.00", periodsPerYear: 12, applyKorting: true, ...DECL });
  assert.equal(full.applied.ahk, 3115);
  // ARK by hand: 0,08324 × 11.988 = 997,88 → capped at arkm1 € 996;
  // 0,31009 × (11.988 − 11.965) = 7,13; total 1.003,13 → "naar boven" € 1.004.
  assert.equal(full.applied.ark, 1004);
  // X1 = 11.988 × 35,75% = 4.285,71 → 4.285; X = 4.285 − (3.115 + 1.004) =
  // 166; x = 166/12 = 13,83. Tabel: met 13,83. ✓
  assert.equal(full.grossAnnual, 4285);
  assert.equal(full.netAnnual, 166);
  // L = 29.970 > 29.736 → AHK = 3.115 − 234 × 0,06398 = 3.115 − 14,97 =
  // 3.100,03 → "naar boven" € 3.101.
  const tapered = calculateNlStatutory({ income: "2497.50", periodsPerYear: 12, applyKorting: true, ...DECL });
  assert.equal(tapered.applied.ahk, 3101);
  // ARK by hand: 996 + min(0,31009 × 18.005, cap) → 996 + 5.583,17 capped
  // at arkm2 5.300; + 0,01950 × 4.125 = 80,44 → 5.380,44 → € 5.381.
  assert.equal(tapered.applied.ark, 5381);
  assert.equal(cents2(tapered.periodicCents), "186.00");
});

test("AHK fully afgebouwd at € 78.426, ARK at € 132.920", () => {
  const atTop = calculateNlStatutory({ income: "6534.00", periodsPerYear: 12, applyKorting: true, ...DECL });
  // L = 78.408, just below ahkg2: AHK = 3.115 − 48.672 × 0,06398 = 3.115 −
  // 3.114,03 = 0,97 → € 1 (plus the documented inhaalafbouw at the table edge).
  assert.equal(atTop.applied.ahk, 1);
  const past = calculateNlStatutory({ income: "6538.50", periodsPerYear: 12, applyKorting: true, ...DECL });
  assert.equal(past.applied.ahk, 0);
  // ARK taper end arkg4 = 132.920 is not itself a tabelloon (no multiple
  // of € 54): the last table L below it, 132.894, still prices ARK € 2
  // (5.685 − 87.302 × 0,06510 = 1,64 → "naar boven" 2), and the first table
  // L above it, 132.948, prices nothing.
  const lastBefore = calculateNlStatutory({ income: "11074.50", periodsPerYear: 12, applyKorting: true, ...DECL });
  assert.equal(lastBefore.annualWage, 132894);
  assert.equal(lastBefore.applied.ark, 2);
  const firstPast = calculateNlStatutory({ income: "11079.00", periodsPerYear: 12, applyKorting: true, ...DECL });
  assert.equal(firstPast.annualWage, 132948);
  assert.equal(firstPast.applied.ark, 0);
});

test("boundary sweep across every kink, each at a table-exact L", () => {
  const arkAt = (tvl: string): number =>
    calculateNlStatutory({ income: tvl, periodsPerYear: 12, applyKorting: true, svWage: "0" }).applied.ark;
  const ahkAt = (tvl: string): number =>
    calculateNlStatutory({ income: tvl, periodsPerYear: 12, applyKorting: true, svWage: "0" }).applied.ahk;
  // AHK phase-out starts at 29.736: L = 29.700 prices the full € 3.115,
  // L = 29.754 prices 3.115 − 18 × 0,06398 = 3.113,85 → € 3.114.
  assert.equal(ahkAt("2475.00"), 3115);
  assert.equal(ahkAt("2479.50"), 3114);
  // ARK climbs through arkg2 = 25.845 (the max2 cap binds just above it):
  // L = 25.812 prices 996 + 13.847 × 0,31009 = 5.289,82 → € 5.290;
  // L = 25.866 prices min(5.306,56, 5.300) + 21 × 0,01950 = 5.300,41 → € 5.301.
  assert.equal(arkAt("2151.00"), 5290);
  assert.equal(arkAt("2155.50"), 5301);
  // Taper kink at arkg3 = 45.592: L = 45.576 prices € 5.685 (5.684,75 → up),
  // L = 45.630 prices 5.685 − 38 × 0,06510 = 5.682,53 → € 5.683.
  assert.equal(arkAt("3798.00"), 5685);
  assert.equal(arkAt("3802.50"), 5683);
});

test("AOW-1946 goldens: lower schijf 1, OUK, and the AOK incl/excl pair", () => {
  // € 3.240,00, AOW 1946: X1 = 38.880 × 17,85% = 6.940,08 → 6.940.
  // AHK = 1.556 − 9.144 × 0,03195 = 1.556 − 292,15 = 1.263,85 → 1.264.
  // OUK = € 2.067 (38.880 ≤ 46.002). ARK: 498 + capped 2.647 leg +
  // 0,00974 × 13.035 = 126,96 → 2.773,96 → 2.774.
  // X = 6.940 − (1.264 + 2.067 + 2.774) = 835 → 69,58 excl; with AOK € 540:
  // X = 295 → 24,58 incl. Tabel: 578,33 / 69,58 / 24,58 / 231,17. ✓
  const excl = calculateNlStatutory({ income: "3240.00", periodsPerYear: 12, applyKorting: true, ageClass: "aow_1946", ...DECL });
  assert.equal(excl.grossAnnual, 6940);
  assert.equal(excl.applied.ahk, 1264);
  assert.equal(excl.applied.ouk, 2067);
  assert.equal(excl.applied.ark, 2774);
  assert.equal(cents2(excl.periodicCents), "69.58");
  assert.equal(cents2(excl.arkPeriodicCents), "231.17");
  const incl = calculateNlStatutory({ income: "3240.00", periodsPerYear: 12, applyKorting: true, ageClass: "aow_1946", aokApply: true, ...DECL });
  assert.equal(incl.applied.aok, 540);
  assert.equal(cents2(incl.periodicCents), "24.58");
});

test("capping order is AHK-first: low AOW wage leaves ARK € 666, low wage leaves ARK € 12", () => {
  // € 2.002,50 AOW 1946: X1 = 24.030 × 17,85% = 4.289,36 → 4.289 against
  // AHK 1.556 + OUK 2.067 + ARK 2.367 = 5.990. Reduction order AOK, ARK,
  // OUK, AHK keeps AHK+OUK whole and tops ARK to 666 → 55,50. Tabel: 55,50. ✓
  const aow = calculateNlStatutory({ income: "2002.50", periodsPerYear: 12, applyKorting: true, ageClass: "aow_1946", ...DECL });
  assert.equal(cents2(aow.periodicCents), "0.00");
  assert.equal(aow.applied.ark, 666);
  assert.equal(cents2(aow.arkPeriodicCents), "55.50");
  // € 729,00 jonger: X1 = 8.748 × 35,75% = 3.127,41 → 3.127 against AHK
  // 3.115 + ARK 729. AHK kept whole, ARK topped to 12 → 1,00. Tabel: 1,00. ✓
  const low = calculateNlStatutory({ income: "729.00", periodsPerYear: 12, applyKorting: true, ...DECL });
  assert.equal(cents2(low.periodicCents), "0.00");
  assert.equal(low.applied.ark, 12);
  assert.equal(cents2(low.arkPeriodicCents), "1.00");
});

test("AOW-1945 schijf 1 runs to € 41.123 at 17,85%", () => {
  const r = calculateNlStatutory({ income: "3424.50", periodsPerYear: 12, applyKorting: false, ageClass: "aow_1945", svWage: "0" });
  // L = 41.094 ≤ 41.123: X1 = 41.094 × 17,85% = 7.335,28 → 7.335.
  assert.equal(r.annualWage, 41094);
  assert.equal(r.grossAnnual, 7335);
  const over = calculateNlStatutory({ income: "3429.00", periodsPerYear: 12, applyKorting: false, ageClass: "aow_1945", svWage: "0" });
  // L = 41.148 > 41.123: X1 = 7.340 + 25 × 37,56% = 7.340 + 9,39 → 7.349.
  assert.equal(over.annualWage, 41148);
  assert.equal(over.grossAnnual, 7349);
});

test("Lmax golden and the above-Lmax systematiek-1 rule", () => {
  // Tabelloon € 11.092,50 = Lmax: alle kortingen afgebouwd, X = X1.
  // X1 = 28.752 + (133.110 − 78.426) × 49,50% = 28.752 + 27.068,58 → 55.820.
  // Tabel: zonder = met = 4.651,67 (55.820/12 = 4.651,67). ✓
  const top = calculateNlStatutory({ income: "11092.50", periodsPerYear: 12, applyKorting: true, ...DECL });
  assert.equal(top.annualWage, 133110);
  assert.equal(top.grossAnnual, 55820);
  assert.equal(cents2(top.periodicCents), "4651.67");
  // Above Lmax the maandtabel's own footnote applies: "neem 49,50% van het
  // verschil tussen dit hogere loon en € 11.092,50. Rond het resultaat af op
  // centen in het voordeel van de werknemer." € 12.000: 907,50 × 49,50% =
  // 449,2125 → 449,21; x = 4.651,67 + 449,21 = 5.100,88.
  const hi = calculateNlStatutory({ income: "12000.00", periodsPerYear: 12, applyKorting: true, ...DECL });
  assert.equal(hi.annualWage, -1);
  assert.equal(cents2(hi.aboveMaxCents), "449.21");
  assert.equal(cents2(hi.periodicCents), "5100.88");
});

test("jonggehandicaptenkorting: Tabel 13 slices, AOW+ herleiding from the worked example", () => {
  // Zonder korting, so X1 shows whole: € 2.002,50 → x = 715,83.
  // JGK maandslice: € 923/12 = 76,92 (Tabel 13: "per maand € 76,92").
  const jong = calculateNlStatutory({ income: "2002.50", periodsPerYear: 12, applyKorting: false, jgkApply: true, ...DECL });
  assert.equal(cents2(jong.jgkReductionCents), "76.92");
  assert.equal(cents2(jong.withholdingCents), "638.91");
  // AOW+: the §5.2 worked example herleids € 923 to € 210 (8,10/35,75) +
  // € 252 (9,75/35,75) = € 462; maandslice 462/12 = 38,50.
  const aow = calculateNlStatutory({ income: "2002.50", periodsPerYear: 12, applyKorting: false, ageClass: "aow_1946", jgkApply: true, ...DECL });
  assert.equal(cents2(aow.jgkReductionCents), "38.50");
  assert.equal(cents2(aow.withholdingCents), "318.92");
  // The reduction never drives the withholding below € 0 ("maar niet verder dan tot € 0").
  const tiny = calculateNlStatutory({ income: "4.50", periodsPerYear: 12, applyKorting: true, jgkApply: true, ...DECL });
  assert.equal(cents2(tiny.withholdingCents), "0.00");
});

test("employer premiums: AWf low/high, Aof low/high, Whk beschikking, Zvw 6,10%", () => {
  const base = { income: "5000.00", periodsPerYear: 12, applyKorting: false } as const;
  // AWf laag 2,74%: 5.000 × 2,74% = 137,00. Aof laag 6,27%: 313,50.
  // Whk 1,25%: 62,50. Zvw 6,10%: 305,00.
  const low = calculateNlStatutory({ ...base, awfLow: true, aofHigh: false, whkPercent: "1.25" });
  assert.equal(cents2(low.svBaseCents), "5000.00");
  assert.equal(cents2(low.wwCents), "137.00");
  assert.equal(cents2(low.aofCents), "313.50");
  assert.equal(cents2(low.whkCents), "62.50");
  assert.equal(cents2(low.zvwCents), "305.00");
  // AWf hoog 7,74%: 5.000 × 7,74% = 387,00. Aof hoog 7,63%: 381,50.
  const high = calculateNlStatutory({ ...base, awfLow: false, aofHigh: true, whkPercent: "0.50" });
  assert.equal(cents2(high.wwCents), "387.00");
  assert.equal(cents2(high.aofCents), "381.50");
  assert.equal(cents2(high.whkCents), "25.00");
});

test("maximumpremieloon: period cap and annual headroom", () => {
  // € 10.000 maandloon caps at the Tabel-11 maandmaximum € 6.617,41.
  const capped = calculateNlStatutory({ income: "10000.00", periodsPerYear: 12, applyKorting: false, awfLow: false, aofHigh: true, whkPercent: "2.00" });
  assert.equal(cents2(capped.svBaseCents), "6617.41");
  // 6.617,41 × 7,74% = 512,1875 → 512,19.
  assert.equal(cents2(capped.wwCents), "512.19");
  // Declared YTD consumes the € 79.409 annual maximum first.
  const exhausted = calculateNlStatutory({ income: "5000.00", periodsPerYear: 12, applyKorting: false, svWageYtd: "77900.00", awfLow: true, aofHigh: false, whkPercent: "1.00" });
  assert.equal(cents2(exhausted.svBaseCents), "1509.00");
  const over = calculateNlStatutory({ income: "5000.00", periodsPerYear: 12, applyKorting: false, svWageYtd: "79409.00", awfLow: true, aofHigh: false, whkPercent: "1.00" });
  assert.equal(cents2(over.svBaseCents), "0.00");
  assert.equal(cents2(over.wwCents), "0.00");
});

test("ZW posts nothing: Tabel 9 carries no ZW percentage", () => {
  const r = calculateNlStatutory({ income: "5000.00", periodsPerYear: 12, applyKorting: true, ...DECL });
  assert.equal(r.zvwCents > 0n, true);
  // No engine field prices ZW — the result carries no ZW amount by construction.
  assert.deepEqual(Object.keys(r).filter((k) => k === "zwCents"), []);
});

test("missing declarations throw by name, never priced by guess", () => {
  const sv = { income: "5000.00", periodsPerYear: 12, applyKorting: false } as const;
  assert.throws(() => calculateNlStatutory({ ...sv, aofHigh: false, whkPercent: "1.00" }), /AWf/);
  assert.throws(() => calculateNlStatutory({ ...sv, awfLow: true, whkPercent: "1.00" }), /Aof/);
  assert.throws(() => calculateNlStatutory({ ...sv, awfLow: true, aofHigh: false }), /Whk/);
  assert.throws(
    () => calculateNlStatutory({ ...sv, awfLow: true, aofHigh: false, whkPercent: "101.00" }),
    /above 100%/,
  );
  // No SV wage, no declarations needed: an unpaid stub prices withholding only.
  const zero = calculateNlStatutory({ income: "0.00", periodsPerYear: 12, applyKorting: true, svWage: "0" });
  assert.equal(cents2(zero.withholdingCents), "0.00");
  assert.equal(cents2(zero.svBaseCents), "0.00");
});

test("AOK below the AOW age throws: Tabel 5 gives it as niet van toepassing", () => {
  assert.throws(
    () => calculateNlStatutory({ income: "3240.00", periodsPerYear: 12, applyKorting: true, aokApply: true, ...DECL }),
    /alleenstaande-ouderenkorting/,
  );
});

test("bonuses are refused by name: the bijzondere tarieven are not transcribed", () => {
  assert.throws(
    () => calculateNlStatutory({ income: "5000.00", nonPeriodic: "1000.00", periodsPerYear: 12, applyKorting: true, ...DECL }),
    /bijzondere beloningen/,
  );
});

test("unknown age class throws by name", () => {
  assert.throws(
    () => calculateNlStatutory({ income: "1000.00", periodsPerYear: 12, applyKorting: true, ageClass: "aow_1950" as never, ...DECL }),
    /age class/,
  );
});
