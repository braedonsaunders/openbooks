/**
 * SG cross-year discrimination goldens — pure, no database.
 *
 * A per-year conformance test proves each year's module contains the figures
 * typed into it. This file proves the years are ACTUALLY DISTINCT in the
 * engine's behaviour: one unchanged input priced in every transcribed year
 * must produce a different liability per year (the OW ceiling steps), so a
 * year silently falling through to another year's tables cannot pass. Where
 * a figure is genuinely frozen, that freeze is pinned per year instead, so a
 * future edit that "unfreezes" it has to argue with a test.
 *
 * All figures below are hand-worked from the Board's Table 1 of each year
 * (37%/20% above $750 against that year's OW ceiling), never engine output.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculateSgStatutory } from "./cpf.ts";

const CITIZEN_LE55 = { cpfStatus: "citizen", ageBand: "le55" } as const;

test("one unchanged $9,000 OW month prices a different liability per year", () => {
  // The OW ceiling is the only thing that moves for the 55-and-below band:
  // $6,800 (2024) → $7,400 (2025) → $8,000 (2026). $9,000 of OW binds every
  // year's ceiling, so the same input must price three different
  // liabilities — and these exact ones:
  // 2024: 37% × 6,800 = 2,516 total; 20% × 6,800 = 1,360 employee; 1,156 employer.
  // 2025: 37% × 7,400 = 2,738 total; 20% × 7,400 = 1,480 employee; 1,258 employer.
  // 2026: 37% × 8,000 = 2,960 total; 20% × 8,000 = 1,600 employee; 1,360 employer.
  const y2024 = calculateSgStatutory({ ...CITIZEN_LE55, taxYear: 2024, ordinaryWages: "9000.00" });
  const y2025 = calculateSgStatutory({ ...CITIZEN_LE55, taxYear: 2025, ordinaryWages: "9000.00" });
  const y2026 = calculateSgStatutory({ ...CITIZEN_LE55, taxYear: 2026, ordinaryWages: "9000.00" });
  assert.deepEqual(
    [y2024.totalCents, y2024.employeeCents, y2024.employerCents],
    [251600n, 136000n, 115600n],
  );
  assert.deepEqual(
    [y2025.totalCents, y2025.employeeCents, y2025.employerCents],
    [273800n, 148000n, 125800n],
  );
  assert.deepEqual(
    [y2026.totalCents, y2026.employeeCents, y2026.employerCents],
    [296000n, 160000n, 136000n],
  );
  // Distinct, or the new year is falling through to the old tables.
  assert.ok(
    new Set([y2024.totalCents, y2025.totalCents, y2026.totalCents]).size === 3,
    "the three years must price three different totals for the same input",
  );
});

test("below every ceiling the liability is frozen — pinned, not assumed", () => {
  // $4,500 OW sits below the lowest transcribed ceiling ($6,800), so all
  // three years must price identically: 37% × 4,500 = 1,665 total,
  // 20% × 4,500 = 900 employee, 765 employer. If a future edit moves any
  // year's le55 rate, this is the test it argues with.
  for (const taxYear of [2024, 2025, 2026] as const) {
    const result = calculateSgStatutory({ ...CITIZEN_LE55, taxYear, ordinaryWages: "4500.00" });
    assert.deepEqual(
      [result.totalCents, result.employeeCents, result.employerCents],
      [166500n, 90000n, 76500n],
      `${taxYear} frozen below-ceiling liability`,
    );
  }
});

test("SDL is frozen across all three transcribed years — pinned per year", () => {
  // 0.25% / $2 / $11.25, unchanged since 1 Oct 2008: the same wage must
  // price the same SDL in every year, at the floor, the rate, and the cap.
  for (const taxYear of [2024, 2025, 2026] as const) {
    const at = (ordinaryWages: string) =>
      calculateSgStatutory({ ...CITIZEN_LE55, taxYear, ordinaryWages }).sdlCents;
    assert.equal(at("609.50"), 200n, `${taxYear} SDL floor`);
    assert.equal(at("2000.00"), 500n, `${taxYear} SDL rate`);
    assert.equal(at("10000.00"), 1125n, `${taxYear} SDL cap`);
  }
});
