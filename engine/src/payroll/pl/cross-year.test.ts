/**
 * PL cross-year proof: one unchanged input priced in every transcribed year
 * must produce the year's OWN liability — never a silent fall-through to the
 * year that already worked.
 *
 * - 22 000 zł December: the emerytalne/rentowe room binds differently every
 *   year (234 720 / 260 190 / 282 600), so the same pay prices three distinct
 *   advances: 6 488 (2024), 5 832 (2025), 5 695 (2026).
 * - 8 000 zł June: genuinely frozen — the scale, rates and funds are
 *   identical, so the same 498 zł advance in all three years is asserted per
 *   year, pinning the freeze against future edits.
 * - Senior FGŚP: 0,00 in 2024/2025 (art. 9b ust. 2, modelled) against 8,00
 *   in 2026 (landed behaviour, reported as a defect — pinned here only to
 *   prove the dispatch is distinct, not to endorse the figure).
 * - The adapter cases price December through `computePlStatutory` per
 *   taxYear: a dispatch that fell through to 2026 would print 5 695 for a
 *   2025 run instead of 5 832.
 *
 * Every figure below is hand-priced from the operative sentences quoted in
 * the year's tables module — never from running the engine.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePlPit2024,
  calculatePlPit2025,
  calculatePlPit2026,
  calculatePlZus2024,
  calculatePlZus2025,
  calculatePlZus2026,
  computePlStatutory,
} from "./compute-statutory.ts";
import type {
  PayrollStatutoryComputeContext,
  StubLine,
} from "../statutory-context.ts";
import { createPushStatutory } from "../push-statutory.ts";

const DEC_BRUT = "22000.00";
const DEC_YOB = 1985;

function decemberZus(year: 2024 | 2025 | 2026) {
  const input = {
    brut: DEC_BRUT,
    payDate: `${year}-12-15`,
    periodsPerYear: 12,
    rokUrodzenia: DEC_YOB,
  } as const;
  if (year === 2024) return calculatePlZus2024(input);
  if (year === 2025) return calculatePlZus2025(input);
  return calculatePlZus2026(input);
}

function decemberPit(year: 2024 | 2025 | 2026, zusEe: string) {
  const input = {
    brut: DEC_BRUT,
    zusEe,
    kup: "miejscowy",
    pomniejszenie: "1/12",
    payDate: `${year}-12-15`,
    periodsPerYear: 12,
  } as const;
  if (year === 2024) return calculatePlPit2024(input);
  if (year === 2025) return calculatePlPit2025(input);
  return calculatePlPit2026(input);
}

test("December 22 000 zł prices a different advance every year", () => {
  // Prior 11 × 22 000 = 242 000 annualised: past 2024's 234 720 room (zero
  // base), inside 2025's 260 190 (18 190 room) and 2026's 282 600 (full base).
  const zus2024 = decemberZus(2024);
  const zus2025 = decemberZus(2025);
  const zus2026 = decemberZus(2026);
  assert.equal(zus2024.podstawaSpoleczne, "0.0000");
  assert.equal(zus2025.podstawaSpoleczne, "18190.0000");
  assert.equal(zus2026.podstawaSpoleczne, "22000.0000");
  // The fractional rentowe split survives per year: 18 190 × 9,76 % =
  // 1 775,344 → 1 775,34 (2025); 22 000 × 9,76 % = 2 147,20 (2026).
  assert.equal(zus2024.emerytEe, "0.0000");
  assert.equal(zus2025.emerytEe, "1775.3400");
  assert.equal(zus2026.emerytEe, "2147.2000");

  const pit2024 = decemberPit(2024, zus2024.zusEe);
  const pit2025 = decemberPit(2025, zus2025.zusEe);
  const pit2026 = decemberPit(2026, zus2026.zusEe);
  // Dochód: 22 000 − 539,00 − 250 = 21 211 (2024); 22 000 − 2 587,19 − 250
  // = 19 162,81 → 19 163 (2025); 22 000 − 3 016,20 − 250 = 18 733,80 →
  // 18 734 (2026). All December YTDs sit past 120 000: all at 32 %.
  assert.equal(pit2024.dochod, "21211.0000");
  assert.equal(pit2025.dochod, "19163.0000");
  assert.equal(pit2026.dochod, "18734.0000");
  // Advances: 21 211 × 32 % − 300 = 6 487,52 → 6 488; 19 163 × 32 % − 300
  // = 5 832,16 → 5 832; 18 734 × 32 % − 300 = 5 694,88 → 5 695.
  assert.equal(pit2024.zaliczka, "6488.0000");
  assert.equal(pit2025.zaliczka, "5832.0000");
  assert.equal(pit2026.zaliczka, "5695.0000");
});

test("June 8 000 zł is frozen: the same figures in all three years", () => {
  for (const year of [2024, 2025, 2026] as const) {
    const zusInput = {
      brut: "8000.00",
      payDate: `${year}-06-15`,
      periodsPerYear: 12,
      rokUrodzenia: 1990,
    } as const;
    const zus =
      year === 2024
        ? calculatePlZus2024(zusInput)
        : year === 2025
          ? calculatePlZus2025(zusInput)
          : calculatePlZus2026(zusInput);
    // No cap binds (6 × 8 000 = 48 000); rates and funds identical.
    assert.equal(zus.zusEe, "1096.8000", `${year} zusEe`);
    assert.equal(zus.zdrowotna, "621.2900", `${year} zdrowotna`);
    assert.equal(zus.fp, "80.0000", `${year} fp`);
    assert.equal(zus.fs, "116.0000", `${year} fs`);
    assert.equal(zus.fgsp, "8.0000", `${year} fgsp`);
    const pitInput = {
      brut: "8000.00",
      zusEe: zus.zusEe,
      kup: "miejscowy",
      pomniejszenie: "1/12",
      payDate: `${year}-06-15`,
      periodsPerYear: 12,
    } as const;
    const pit =
      year === 2024
        ? calculatePlPit2024(pitInput)
        : year === 2025
          ? calculatePlPit2025(pitInput)
          : calculatePlPit2026(pitInput);
    assert.equal(pit.zaliczka, "498.0000", `${year} zaliczka`);
  }
});

test("senior FGŚP: zero in 2024/2025, 8,00 in 2026 (landed, reported)", () => {
  // Born 1960: past 60-by-year in every transcribed year. 2024/2025 model
  // the claims-protection art. 9b ust. 2 exemption; 2026 prices FGŚP
  // unconditionally — its landed guard pins 8,00 and the contradiction is
  // reported, not changed here. Asserting both proves the dispatch reaches
  // each year's own tables.
  for (const [year, expected] of [
    [2024, "0.0000"],
    [2025, "0.0000"],
    [2026, "8.0000"],
  ] as const) {
    const input = {
      brut: "8000.00",
      payDate: `${year}-06-15`,
      periodsPerYear: 12,
      rokUrodzenia: 1960,
    } as const;
    const zus =
      year === 2024
        ? calculatePlZus2024(input)
        : year === 2025
          ? calculatePlZus2025(input)
          : calculatePlZus2026(input);
    assert.equal(zus.fp, "0.0000", `${year} fp`);
    assert.equal(zus.fs, "0.0000", `${year} fs`);
    assert.equal(zus.fgsp, expected, `${year} fgsp`);
  }
});

function adapterCtx(taxYear: number, payDate: string, income: string) {
  const lines: StubLine[] = [];
  const pushStatutory = createPushStatutory({
    country: "PL",
    lines,
    emittedEarningsAssessed: new Set<string>(),
    need: (systemKey: string, kind: string): Record<string, unknown> => ({
      id: `${systemKey}:${kind}`,
    }),
  });
  const ctx = {
    taxYear,
    region: "PL",
    run: { pay_date: payDate },
    emp: { pl_rok_urodzenia: "1985" },
    income,
    nonPeriodic: "",
    pensionable: income,
    insurable: "0",
    periodsPerYear: 12,
    pushStatutory,
    certificateFor: (key: string) =>
      key === "pl_pit2"
        ? { answers: { pomniejszenie: "1/12", kup: "miejscowy" } }
        : null,
    assertRegionSupported: () => {},
  } as unknown as PayrollStatutoryComputeContext;
  return ctx;
}

test("adapter dispatches December 22 000 zł to the run's own year", async () => {
  // A fall-through to the 2026 tables would print 5 695 for every year.
  const result2025 = await computePlStatutory(adapterCtx(2025, "2025-12-15", DEC_BRUT));
  assert.equal(result2025["ZALICZKA"], "5832.0000");
  assert.equal(result2025["EMERYT_EE"], "1775.3400");
  const result2024 = await computePlStatutory(adapterCtx(2024, "2024-12-15", DEC_BRUT));
  assert.equal(result2024["ZALICZKA"], "6488.0000");
  assert.equal(result2024["EMERYT_EE"], "0.0000");
  const result2026 = await computePlStatutory(adapterCtx(2026, "2026-12-15", DEC_BRUT));
  assert.equal(result2026["ZALICZKA"], "5695.0000");
});

test("adapter still refuses untranscribed years by name", async () => {
  await assert.rejects(() => computePlStatutory(adapterCtx(2027, "2027-06-15", "8000.00")), /has not been transcribed/);
  await assert.rejects(() => computePlStatutory(adapterCtx(2023, "2023-06-15", "8000.00")), /has not been transcribed/);
});
