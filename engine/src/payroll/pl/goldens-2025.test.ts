/**
 * PL 2025 conformance: the transcribed 2025 tables price a monthly
 * PIT-2-filed employment payslip.
 *
 * Every figure below is hand-priced from the operative sentences quoted in
 * ./tables-2025.ts (same method as the 2026 goldens in ./goldens.test.ts) —
 * never from running the engine. Run with `node --import tsx` on this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculatePlPit2025, calculatePlZus2025 } from "./compute-statutory.ts";
import {
  PL_FUNDUSZE_2025,
  PL_KUP_2025,
  PL_MIN_WAGE_2025,
  PL_PIT_POMNIEJSZENIE_2025,
  PL_PIT_SKALA_2025,
  PL_ROCZNY_LIMIT_2025,
  PL_SKLADKI_PODZIAL_2025,
  PL_SKLADKI_STOPY_2025,
  PL_ZDROWOTNA_2025,
} from "./tables-2025.ts";

test("2025 constants carry the transcribed figures", () => {
  // Annual cap: M.P. 2024 poz. 1051 (260 190 zł at 8 673 zł forecast).
  assert.equal(PL_ROCZNY_LIMIT_2025.annual, "260190");
  assert.equal(PL_ROCZNY_LIMIT_2025.prognozowane, "8673");
  // Minimum wage: Dz.U. 2024 poz. 1362 (single step).
  assert.equal(PL_MIN_WAGE_2025.monthly, "4666");
  // PIT scale: art. 27 (Dz.U. 2025 poz. 163).
  assert.equal(PL_PIT_SKALA_2025.prog, "120000");
  assert.equal(PL_PIT_SKALA_2025.stawkaDolna.rate, "0.12");
  assert.equal(PL_PIT_SKALA_2025.stawkaGorna.rate, "0.32");
  assert.equal(PL_PIT_SKALA_2025.kwotaZmniejszajaca, "3600");
  assert.equal(PL_PIT_SKALA_2025.podatekOdProgu, "10800");
  // Monthly reduction: art. 31b (1/12, 1/24, 1/36 of 3 600).
  assert.equal(PL_PIT_POMNIEJSZENIE_2025.pelne, "300");
  assert.equal(PL_PIT_POMNIEJSZENIE_2025.polowa, "150");
  assert.equal(PL_PIT_POMNIEJSZENIE_2025.trzecia, "100");
  // KUP: art. 22 ust. 2 pkt 1/3.
  assert.equal(PL_KUP_2025.miejscowy.miesiecznie, "250");
  assert.equal(PL_KUP_2025.dojazd.miesiecznie, "300");
  // ZUS split (art. 16) and totals (art. 22 ust. 1): the fractional rates
  // in full — a whole-percent parse would price 2,45 % as 2 %.
  assert.equal(PL_SKLADKI_STOPY_2025.emerytalneTotal.rate, "0.1952");
  assert.equal(PL_SKLADKI_STOPY_2025.rentoweTotal.rate, "0.08");
  assert.equal(PL_SKLADKI_STOPY_2025.choroboweTotal.rate, "0.0245");
  assert.equal(PL_SKLADKI_PODZIAL_2025.emerytalneEe.rate, "0.0976");
  assert.equal(PL_SKLADKI_PODZIAL_2025.emerytalneEr.rate, "0.0976");
  assert.equal(PL_SKLADKI_PODZIAL_2025.rentoweEe.rate, "0.015");
  assert.equal(PL_SKLADKI_PODZIAL_2025.rentoweEr.rate, "0.065");
  assert.equal(PL_SKLADKI_PODZIAL_2025.choroboweEe.rate, "0.0245");
  // Zdrowotna 9 % (art. 79) — not deductible from PIT (art. 27b uchylony).
  assert.equal(PL_ZDROWOTNA_2025.rate, "0.09");
  // Funds: Budget 2025 arts. 25–27 (Dz.U. 2025 poz. 63).
  assert.equal(PL_FUNDUSZE_2025.fp.rate, "0.01");
  assert.equal(PL_FUNDUSZE_2025.fs.rate, "0.0145");
  assert.equal(PL_FUNDUSZE_2025.fgsp.rate, "0.001");
});

test("standard June payslip: 8 000 zł prices every line", () => {
  const zus = calculatePlZus2025({
    brut: "8000.00",
    payDate: "2025-06-15",
    periodsPerYear: 12,
    rokUrodzenia: 1990,
  });
  // Full base: 6 × 8 000 = 48 000 annualised, far below 260 190.
  assert.equal(zus.podstawaSpoleczne, "8000.0000");
  assert.equal(zus.emerytEe, "780.8000");
  assert.equal(zus.emerytEr, "780.8000");
  assert.equal(zus.rentEe, "120.0000");
  assert.equal(zus.rentEr, "520.0000");
  assert.equal(zus.chorEe, "196.0000");
  assert.equal(zus.zusEe, "1096.8000");
  // Zdrowotna: (8 000 − 1 096,80) × 9 % = 621,288 → 621,29.
  assert.equal(zus.podstawaZdrowotna, "6903.2000");
  assert.equal(zus.zdrowotna, "621.2900");
  // FP/FS/FGŚP: base clears 4 666, age 35 — 1,0 % / 1,45 % / 0,10 %.
  assert.equal(zus.fpNalezne, true);
  assert.equal(zus.fpZwolnioneWiek, false);
  assert.equal(zus.fp, "80.0000");
  assert.equal(zus.fs, "116.0000");
  assert.equal(zus.fgsp, "8.0000");
  assert.equal(zus.wypadkoweEr, "0.0000");

  const pit = calculatePlPit2025({
    brut: "8000.00",
    zusEe: zus.zusEe,
    kup: "miejscowy",
    pomniejszenie: "1/12",
    payDate: "2025-06-15",
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

test("December sweep: the 260 190 zł room binds emerytalne/rentowe only", () => {
  const zus = calculatePlZus2025({
    brut: "25000.00",
    payDate: "2025-12-15",
    periodsPerYear: 12,
    rokUrodzenia: 1985,
  });
  // Prior 11 × 25 000 = 275 000 exceeds 260 190: no room left.
  assert.equal(zus.podstawaSpoleczne, "0.0000");
  assert.equal(zus.emerytEe, "0.0000");
  assert.equal(zus.emerytEr, "0.0000");
  assert.equal(zus.rentEe, "0.0000");
  assert.equal(zus.rentEr, "0.0000");
  // Chorobowe still on the full 25 000: 612,50.
  assert.equal(zus.chorEe, "612.5000");
  assert.equal(zus.zusEe, "612.5000");
  // Zdrowotna uncapped: (25 000 − 612,50) × 9 % = 2 194,875 → 2 194,88.
  assert.equal(zus.podstawaZdrowotna, "24387.5000");
  assert.equal(zus.zdrowotna, "2194.8800");

  const pit = calculatePlPit2025({
    brut: "25000.00",
    zusEe: zus.zusEe,
    kup: "miejscowy",
    pomniejszenie: "1/12",
    payDate: "2025-12-15",
    periodsPerYear: 12,
  });
  // Dochód: 25 000 − 612,50 − 250 = 24 137,50 → 24 138 zł.
  assert.equal(pit.dochod, "24138.0000");
  // December YTD: 11 × 24 138 = 265 518 — fully past 120 000, all at 32 %.
  assert.equal(pit.podstawa12, "0.0000");
  assert.equal(pit.podstawa32, "24138.0000");
  // 24 138 × 32 % = 7 724,16 − 300 = 7 424,16 → 7 424 zł.
  assert.equal(pit.zaliczka, "7424.0000");
});

test("FP/FS zero below the minimum wage and for seniors, with FGŚP barred too", () => {
  // 4 250 zł clears no 4 666 threshold: FP/FS zero, FGŚP still priced.
  const low = calculatePlZus2025({
    brut: "4250.00",
    payDate: "2025-06-15",
    periodsPerYear: 12,
    rokUrodzenia: 1990,
  });
  assert.equal(low.fpNalezne, false);
  assert.equal(low.fpZwolnioneWiek, false);
  assert.equal(low.fp, "0.0000");
  assert.equal(low.fs, "0.0000");
  assert.equal(low.fgsp, "4.2500");

  // Born 1960 (65 in 2025): certainly past 60 — FP/FS age-barred, and
  // FGŚP too (art. 9b ust. 2, modelled by the pack's fgspAgeBar flag).
  const senior = calculatePlZus2025({
    brut: "8000.00",
    payDate: "2025-06-15",
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
    payDate: "2025-06-15",
    periodsPerYear: 12,
    rokUrodzenia: 1990,
  } as const;
  // Turns 20 in 2025: ulga dla młodych may apply — refused by name.
  assert.throws(
    () => calculatePlZus2025({ ...base, rokUrodzenia: 2005 }),
    /ulga dla młodych/,
  );
  // Turns 57 in 2025: the 55–60 sex-split band — refused by name,
  // citing the promotion-act article (labour-market art. 261 from June).
  assert.throws(
    () => calculatePlZus2025({ ...base, rokUrodzenia: 1968 }),
    /55–60/,
  );
  assert.throws(
    () => calculatePlZus2025({ ...base, rokUrodzenia: 1968 }),
    /104b/,
  );
  // Non-monthly periodicity and other years refuse loudly.
  assert.throws(
    () => calculatePlZus2025({ ...base, periodsPerYear: 13 }),
    /monthly/,
  );
  assert.throws(
    () => calculatePlZus2025({ ...base, payDate: "2026-06-15" }),
    /no transcribed figures/,
  );
  assert.throws(
    () =>
      calculatePlPit2025({
        brut: "8000.00",
        zusEe: "1096.8000",
        kup: "miejscowy",
        pomniejszenie: "1/12",
        payDate: "2025-06-15",
        periodsPerYear: 4,
      }),
    /monthly/,
  );
});

test("declared wypadkowe rate prices the full revenue, fraction intact", () => {
  const zus = calculatePlZus2025({
    brut: "8000.00",
    payDate: "2025-06-15",
    periodsPerYear: 12,
    rokUrodzenia: 1990,
    wypadkowePct: "1.67",
  });
  // 8 000 × 1,67 % = 133,60 — the tenths survive the engine's parse.
  assert.equal(zus.wypadkoweEr, "133.6000");
  assert.throws(
    () =>
      calculatePlZus2025({
        brut: "8000.00",
        payDate: "2025-06-15",
        periodsPerYear: 12,
        rokUrodzenia: 1990,
        wypadkowePct: "abc",
      }),
    /percent/,
  );
});
