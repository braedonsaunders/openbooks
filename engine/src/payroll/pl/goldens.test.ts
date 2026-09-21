/**
 * PL pure-calculator goldens: the 2026 PIT advance and ZUS/NFZ lines from
 * the transcribed tables, plus the 282 600 zł annual-limit sweep.
 *
 * Every figure below is hand-priced from the operative sentences quoted in
 * ./tables-2026.ts. Run with `node --import tsx` on this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculatePlPit2026, calculatePlZus2026 } from "./compute-statutory.ts";

test("standard June payslip: 8 000 zł prices every line", () => {
  const zus = calculatePlZus2026({
    brut: "8000.00",
    payDate: "2026-06-15",
    periodsPerYear: 12,
    rokUrodzenia: 1990,
  });
  // Full base: 6 × 8 000 = 48 000 annualised, far below 282 600.
  assert.equal(zus.podstawaSpoleczne, "8000.0000");
  // 8 000 × 9,76 % = 780,80 both shares; rentowe 1,5 % / 6,5 %.
  assert.equal(zus.emerytEe, "780.8000");
  assert.equal(zus.emerytEr, "780.8000");
  assert.equal(zus.rentEe, "120.0000");
  assert.equal(zus.rentEr, "520.0000");
  // Chorobowe 2,45 % on the full revenue.
  assert.equal(zus.chorEe, "196.0000");
  assert.equal(zus.zusEe, "1096.8000");
  // Zdrowotna: (8 000 − 1 096,80) × 9 % = 621,288 → 621,29.
  assert.equal(zus.podstawaZdrowotna, "6903.2000");
  assert.equal(zus.zdrowotna, "621.2900");
  // FP/FS/FGŚP: base clears 4 806, age 36 — 1,0 % / 1,45 % / 0,10 %.
  assert.equal(zus.fpNalezne, true);
  assert.equal(zus.fpZwolnioneWiek, false);
  assert.equal(zus.fp, "80.0000");
  assert.equal(zus.fs, "116.0000");
  assert.equal(zus.fgsp, "8.0000");
  assert.equal(zus.wypadkoweEr, "0.0000");

  const pit = calculatePlPit2026({
    brut: "8000.00",
    zusEe: zus.zusEe,
    kup: "miejscowy",
    pomniejszenie: "1/12",
    payDate: "2026-06-15",
    periodsPerYear: 12,
  });
  // Dochód: 8 000 − 1 096,80 − 250 = 6 653,20 → 6 653 zł.
  assert.equal(pit.kup, "250.0000");
  assert.equal(pit.dochod, "6653.0000");
  // June YTD: 5 × 6 653 = 33 265 — no crossing, all at 12 %.
  assert.equal(pit.podstawa12, "6653.0000");
  assert.equal(pit.podstawa32, "0.0000");
  // 6 653 × 12 % = 798,36 − 300 = 498,36 → 498 zł.
  assert.equal(pit.pomniejszenieKwota, "300.0000");
  assert.equal(pit.zaliczka, "498.0000");
});

test("December sweep: the 282 600 zł room binds emerytalne/rentowe only", () => {
  const zus = calculatePlZus2026({
    brut: "25000.00",
    payDate: "2026-12-15",
    periodsPerYear: 12,
    rokUrodzenia: 1985,
  });
  // Prior 11 × 25 000 = 275 000; remaining room 7 600.
  assert.equal(zus.podstawaSpoleczne, "7600.0000");
  // 7 600 × 9,76 % = 741,76; rentowe 114,00 / 494,00.
  assert.equal(zus.emerytEe, "741.7600");
  assert.equal(zus.emerytEr, "741.7600");
  assert.equal(zus.rentEe, "114.0000");
  assert.equal(zus.rentEr, "494.0000");
  // Chorobowe still on the full 25 000: 612,50.
  assert.equal(zus.chorEe, "612.5000");
  assert.equal(zus.zusEe, "1468.2600");
  // Zdrowotna uncapped: (25 000 − 1 468,26) × 9 % = 2 117,8566 → 2 117,86.
  assert.equal(zus.podstawaZdrowotna, "23531.7400");
  assert.equal(zus.zdrowotna, "2117.8600");

  const pit = calculatePlPit2026({
    brut: "25000.00",
    zusEe: zus.zusEe,
    kup: "miejscowy",
    pomniejszenie: "1/12",
    payDate: "2026-12-15",
    periodsPerYear: 12,
  });
  // Dochód: 25 000 − 1 468,26 − 250 = 23 281,74 → 23 282 zł.
  assert.equal(pit.dochod, "23282.0000");
  // December YTD: 11 × 23 282 = 256 102 — fully past 120 000, all at 32 %.
  assert.equal(pit.podstawa12, "0.0000");
  assert.equal(pit.podstawa32, "23282.0000");
  // 23 282 × 32 % = 7 450,24 − 300 = 7 150,24 → 7 150 zł.
  assert.equal(pit.zaliczka, "7150.0000");
});

test("June crossing month splits the PIT base at 120 000 zł", () => {
  const zus = calculatePlZus2026({
    brut: "25000.00",
    payDate: "2026-06-15",
    periodsPerYear: 12,
    rokUrodzenia: 1985,
  });
  // Prior 5 × 25 000 = 125 000 of room used; 157 600 left — no cap yet.
  assert.equal(zus.podstawaSpoleczne, "25000.0000");
  assert.equal(zus.zusEe, "3427.5000");
  // Zdrowotna: (25 000 − 3 427,50) × 9 % = 1 941,525 → 1 941,53.
  assert.equal(zus.zdrowotna, "1941.5300");

  const pit = calculatePlPit2026({
    brut: "25000.00",
    zusEe: zus.zusEe,
    kup: "miejscowy",
    pomniejszenie: "1/12",
    payDate: "2026-06-15",
    periodsPerYear: 12,
  });
  // Dochód: 25 000 − 3 427,50 − 250 = 21 322,50 → 21 323 zł (50 gr rounds up).
  assert.equal(pit.dochod, "21323.0000");
  // Prior 5 × 21 323 = 106 615; 13 385 left at 12 %, 7 938 at 32 %.
  assert.equal(pit.podstawa12, "13385.0000");
  assert.equal(pit.podstawa32, "7938.0000");
  // 13 385 × 12 % = 1 606,20; 7 938 × 32 % = 2 540,16; − 300 → 3 846,36 → 3 846.
  assert.equal(pit.zaliczka, "3846.0000");
});

test("FP/FS zero below the minimum wage and above the age bar", () => {
  // 4 000 zł clears no threshold: FP/FS zero, FGŚP still priced.
  const low = calculatePlZus2026({
    brut: "4000.00",
    payDate: "2026-06-15",
    periodsPerYear: 12,
    rokUrodzenia: 1990,
  });
  assert.equal(low.fpNalezne, false);
  assert.equal(low.fpZwolnioneWiek, false);
  assert.equal(low.fp, "0.0000");
  assert.equal(low.fs, "0.0000");
  assert.equal(low.fgsp, "4.0000");

  // Born 1960 (66 in 2026): certainly past 60 — FP/FS age-barred to zero,
  // and FGŚP too (claims-protection art. 9b ust. 2, Dz.U. 2026 poz. 186 —
  // was 8,00 under the landed unconditional pricing, now 0).
  const senior = calculatePlZus2026({
    brut: "8000.00",
    payDate: "2026-06-15",
    periodsPerYear: 12,
    rokUrodzenia: 1960,
  });
  assert.equal(senior.fpNalezne, false);
  assert.equal(senior.fpZwolnioneWiek, true);
  assert.equal(senior.fp, "0.0000");
  assert.equal(senior.fs, "0.0000");
  assert.equal(senior.fgsp, "0.0000");
});

test("named refusals: ulga age, FP band, periodicity, year", () => {
  const base = {
    brut: "8000.00",
    payDate: "2026-06-15",
    periodsPerYear: 12,
    rokUrodzenia: 1990,
  } as const;
  // Turns 21 in 2026: ulga dla młodych may apply — refused by name.
  assert.throws(
    () => calculatePlZus2026({ ...base, rokUrodzenia: 2005 }),
    /ulga dla młodych/,
  );
  // Turns 58 in 2026: the 55–60 sex-split band — refused by name.
  assert.throws(
    () => calculatePlZus2026({ ...base, rokUrodzenia: 1968 }),
    /55–60/,
  );
  // Non-monthly periodicity and untranscribed years refuse loudly.
  assert.throws(
    () => calculatePlZus2026({ ...base, periodsPerYear: 13 }),
    /monthly/,
  );
  assert.throws(
    () => calculatePlZus2026({ ...base, payDate: "2025-06-15" }),
    /no transcribed figures/,
  );
  assert.throws(
    () =>
      calculatePlPit2026({
        brut: "8000.00",
        zusEe: "1096.8000",
        kup: "miejscowy",
        pomniejszenie: "1/12",
        payDate: "2026-06-15",
        periodsPerYear: 4,
      }),
    /monthly/,
  );
});

test("declared wypadkowe rate prices the full revenue", () => {
  const zus = calculatePlZus2026({
    brut: "8000.00",
    payDate: "2026-06-15",
    periodsPerYear: 12,
    rokUrodzenia: 1990,
    wypadkowePct: "1.67",
  });
  // 8 000 × 1,67 % = 133,60 — the pure function prices a declared rate.
  assert.equal(zus.wypadkoweEr, "133.6000");
  assert.throws(
    () =>
      calculatePlZus2026({
        brut: "8000.00",
        payDate: "2026-06-15",
        periodsPerYear: 12,
        rokUrodzenia: 1990,
        wypadkowePct: "abc",
      }),
    /percent/,
  );
});
