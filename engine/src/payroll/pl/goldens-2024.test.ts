/**
 * PL 2024 conformance: the transcribed 2024 tables price a monthly
 * PIT-2-filed employment payslip, including the 1 July minimum-wage step.
 *
 * Every figure below is hand-priced from the operative sentences quoted in
 * ./tables-2024.ts (same method as the 2026 goldens in ./goldens.test.ts) —
 * never from running the engine. Run with `node --import tsx` on this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculatePlPit2024, calculatePlZus2024 } from "./compute-statutory.ts";
import {
  PL_FUNDUSZE_2024,
  PL_KUP_2024,
  PL_MIN_WAGE_2024,
  PL_PIT_POMNIEJSZENIE_2024,
  PL_PIT_SKALA_2024,
  PL_ROCZNY_LIMIT_2024,
  PL_SKLADKI_PODZIAL_2024,
  PL_SKLADKI_STOPY_2024,
  PL_ZDROWOTNA_2024,
} from "./tables-2024.ts";

test("2024 constants carry the transcribed figures", () => {
  // Annual cap: M.P. 2023 poz. 1356 (234 720 zł at 7 824 zł forecast).
  assert.equal(PL_ROCZNY_LIMIT_2024.annual, "234720");
  assert.equal(PL_ROCZNY_LIMIT_2024.prognozowane, "7824");
  // Minimum wage: Dz.U. 2023 poz. 1893 — two steps, one regulation.
  assert.equal(PL_MIN_WAGE_2024.pierwszaPolowa, "4242");
  assert.equal(PL_MIN_WAGE_2024.drugaPolowa, "4300");
  assert.equal(PL_MIN_WAGE_2024.zmianaOd, "2024-07-01");
  // PIT scale: art. 27 (Dz.U. 2024 poz. 226).
  assert.equal(PL_PIT_SKALA_2024.prog, "120000");
  assert.equal(PL_PIT_SKALA_2024.stawkaDolna.rate, "0.12");
  assert.equal(PL_PIT_SKALA_2024.stawkaGorna.rate, "0.32");
  assert.equal(PL_PIT_SKALA_2024.kwotaZmniejszajaca, "3600");
  assert.equal(PL_PIT_SKALA_2024.podatekOdProgu, "10800");
  // Monthly reduction: art. 31b.
  assert.equal(PL_PIT_POMNIEJSZENIE_2024.pelne, "300");
  assert.equal(PL_PIT_POMNIEJSZENIE_2024.polowa, "150");
  assert.equal(PL_PIT_POMNIEJSZENIE_2024.trzecia, "100");
  // KUP: art. 22 ust. 2 pkt 1/3.
  assert.equal(PL_KUP_2024.miejscowy.miesiecznie, "250");
  assert.equal(PL_KUP_2024.dojazd.miesiecznie, "300");
  // ZUS split and totals, fractional rates in full.
  assert.equal(PL_SKLADKI_STOPY_2024.emerytalneTotal.rate, "0.1952");
  assert.equal(PL_SKLADKI_STOPY_2024.rentoweTotal.rate, "0.08");
  assert.equal(PL_SKLADKI_STOPY_2024.choroboweTotal.rate, "0.0245");
  assert.equal(PL_SKLADKI_PODZIAL_2024.emerytalneEe.rate, "0.0976");
  assert.equal(PL_SKLADKI_PODZIAL_2024.emerytalneEr.rate, "0.0976");
  assert.equal(PL_SKLADKI_PODZIAL_2024.rentoweEe.rate, "0.015");
  assert.equal(PL_SKLADKI_PODZIAL_2024.rentoweEr.rate, "0.065");
  assert.equal(PL_SKLADKI_PODZIAL_2024.choroboweEe.rate, "0.0245");
  // Zdrowotna 9 % (art. 79) — not deductible from PIT (art. 27b uchylony).
  assert.equal(PL_ZDROWOTNA_2024.rate, "0.09");
  // Funds: Budget 2024 arts. 26–28 (Dz.U. 2024 poz. 122).
  assert.equal(PL_FUNDUSZE_2024.fp.rate, "0.01");
  assert.equal(PL_FUNDUSZE_2024.fs.rate, "0.0145");
  assert.equal(PL_FUNDUSZE_2024.fgsp.rate, "0.001");
});

test("standard June payslip: 8 000 zł prices every line", () => {
  const zus = calculatePlZus2024({
    brut: "8000.00",
    payDate: "2024-06-15",
    periodsPerYear: 12,
    rokUrodzenia: 1990,
  });
  // Full base: 6 × 8 000 = 48 000 annualised, far below 234 720.
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
  // FP/FS/FGŚP: base clears the 4 242 first-half wage, age 34.
  assert.equal(zus.fpNalezne, true);
  assert.equal(zus.fpZwolnioneWiek, false);
  assert.equal(zus.fp, "80.0000");
  assert.equal(zus.fs, "116.0000");
  assert.equal(zus.fgsp, "8.0000");
  assert.equal(zus.wypadkoweEr, "0.0000");

  const pit = calculatePlPit2024({
    brut: "8000.00",
    zusEe: zus.zusEe,
    kup: "miejscowy",
    pomniejszenie: "1/12",
    payDate: "2024-06-15",
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

test("December sweep: the 234 720 zł room binds emerytalne/rentowe only", () => {
  const zus = calculatePlZus2024({
    brut: "25000.00",
    payDate: "2024-12-15",
    periodsPerYear: 12,
    rokUrodzenia: 1985,
  });
  // Prior 11 × 25 000 = 275 000 exceeds 234 720: no room left.
  assert.equal(zus.podstawaSpoleczne, "0.0000");
  assert.equal(zus.emerytEe, "0.0000");
  assert.equal(zus.rentEe, "0.0000");
  // Chorobowe still on the full 25 000: 612,50.
  assert.equal(zus.chorEe, "612.5000");
  assert.equal(zus.zusEe, "612.5000");
  // Zdrowotna uncapped: (25 000 − 612,50) × 9 % = 2 194,875 → 2 194,88.
  assert.equal(zus.podstawaZdrowotna, "24387.5000");
  assert.equal(zus.zdrowotna, "2194.8800");

  const pit = calculatePlPit2024({
    brut: "25000.00",
    zusEe: zus.zusEe,
    kup: "miejscowy",
    pomniejszenie: "1/12",
    payDate: "2024-12-15",
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

test("the 1 July minimum-wage step moves FP/FS eligibility mid-year", () => {
  const february = calculatePlZus2024({
    brut: "4250.00",
    payDate: "2024-02-15",
    periodsPerYear: 12,
    rokUrodzenia: 1990,
  });
  // 4 250 ≥ 4 242: FP/FS due — 1,0 % / 1,45 % of the full revenue.
  assert.equal(february.fpNalezne, true);
  assert.equal(february.fp, "42.5000");
  assert.equal(february.fs, "61.6300");
  assert.equal(february.fgsp, "4.2500");

  const july = calculatePlZus2024({
    brut: "4250.00",
    payDate: "2024-07-15",
    periodsPerYear: 12,
    rokUrodzenia: 1990,
  });
  // 4 250 < 4 300: the same pay prices no FP/FS from July — FGŚP stays.
  assert.equal(july.fpNalezne, false);
  assert.equal(july.fp, "0.0000");
  assert.equal(july.fs, "0.0000");
  assert.equal(july.fgsp, "4.2500");

  // The social lines do not move with the wage step: emerytalne
  // 4 250 × 9,76 % = 414,80; rentowe 63,75; chorobowe 104,125 → 104,13.
  for (const month of [february, july]) {
    assert.equal(month.zusEe, "582.6800");
    assert.equal(month.podstawaZdrowotna, "3667.3200");
    assert.equal(month.zdrowotna, "330.0600");
  }
  // PIT is identical either side of the step (FP never enters dochód):
  // 4 250 − 582,68 − 250 = 3 417,32 → 3 417; 3 417 × 12 % = 410,04 − 300.
  for (const payDate of ["2024-02-15", "2024-07-15"]) {
    const pit = calculatePlPit2024({
      brut: "4250.00",
      zusEe: "582.6800",
      kup: "miejscowy",
      pomniejszenie: "1/12",
      payDate,
      periodsPerYear: 12,
    });
    assert.equal(pit.dochod, "3417.0000");
    assert.equal(pit.zaliczka, "110.0000");
  }
});

test("the January threshold is exact to the grosz", () => {
  // 4 242,00 ≥ 4 242: due. 4 242 × 1,45 % = 61,509 → 61,51.
  const exact = calculatePlZus2024({
    brut: "4242.00",
    payDate: "2024-01-15",
    periodsPerYear: 12,
    rokUrodzenia: 1990,
  });
  assert.equal(exact.fpNalezne, true);
  assert.equal(exact.fp, "42.4200");
  assert.equal(exact.fs, "61.5100");
  // One grosz under: no FP/FS.
  const under = calculatePlZus2024({
    brut: "4241.99",
    payDate: "2024-01-15",
    periodsPerYear: 12,
    rokUrodzenia: 1990,
  });
  assert.equal(under.fpNalezne, false);
  assert.equal(under.fp, "0.0000");
  assert.equal(under.fs, "0.0000");
  // FGŚP still prices the full revenue: 4 241,99 × 0,10 % = 4,24199 → 4,24.
  assert.equal(under.fgsp, "4.2400");
});

test("seniors are FGŚP-barred like FP/FS", () => {
  // Born 1960 (64 in 2024): certainly past 60 — FP/FS age-barred, and
  // FGŚP too (art. 9b ust. 2, modelled by the pack's fgspAgeBar flag).
  const senior = calculatePlZus2024({
    brut: "8000.00",
    payDate: "2024-06-15",
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
    payDate: "2024-06-15",
    periodsPerYear: 12,
    rokUrodzenia: 1990,
  } as const;
  // Turns 20 in 2024: ulga dla młodych may apply — refused by name.
  assert.throws(
    () => calculatePlZus2024({ ...base, rokUrodzenia: 2004 }),
    /ulga dla młodych/,
  );
  // Turns 56 in 2024: the 55–60 sex-split band — refused by name,
  // citing the promotion-act article.
  assert.throws(
    () => calculatePlZus2024({ ...base, rokUrodzenia: 1968 }),
    /55–60/,
  );
  assert.throws(
    () => calculatePlZus2024({ ...base, rokUrodzenia: 1968 }),
    /104b/,
  );
  // Non-monthly periodicity and other years refuse loudly.
  assert.throws(
    () => calculatePlZus2024({ ...base, periodsPerYear: 13 }),
    /monthly/,
  );
  assert.throws(
    () => calculatePlZus2024({ ...base, payDate: "2025-01-15" }),
    /no transcribed figures/,
  );
  assert.throws(
    () =>
      calculatePlPit2024({
        brut: "8000.00",
        zusEe: "1096.8000",
        kup: "miejscowy",
        pomniejszenie: "1/12",
        payDate: "2024-06-15",
        periodsPerYear: 4,
      }),
    /monthly/,
  );
});

test("declared wypadkowe rate prices the full revenue, fraction intact", () => {
  const zus = calculatePlZus2024({
    brut: "8000.00",
    payDate: "2024-06-15",
    periodsPerYear: 12,
    rokUrodzenia: 1990,
    wypadkowePct: "1.67",
  });
  // 8 000 × 1,67 % = 133,60 — the tenths survive the engine's parse.
  assert.equal(zus.wypadkoweEr, "133.6000");
  assert.throws(
    () =>
      calculatePlZus2024({
        brut: "8000.00",
        payDate: "2024-06-15",
        periodsPerYear: 12,
        rokUrodzenia: 1990,
        wypadkowePct: "abc",
      }),
    /percent/,
  );
});
