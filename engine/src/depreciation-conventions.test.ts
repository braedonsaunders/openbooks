import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOK_DEPRECIATION_CONVENTIONS,
  DATE_INDEPENDENT_CONVENTIONS,
  TAX_DEPRECIATION_CONVENTIONS,
} from "@openbooks/schema";
import {
  CONVENTION_SHAPES,
  bookConventionWindow,
  firstYearFraction,
  taxConventionHalfMonths,
} from "./depreciation-conventions.ts";
import { computeSchedule } from "./depreciation.ts";
import { toUnits } from "./money.ts";

/**
 * The book and tax depreciation engines are deliberately separate — per-asset
 * monthly GL postings versus annual class pools with recapture and terminal
 * loss. Their difference IS the deferred-tax temporary difference.
 *
 * What they must never do is disagree about what a convention MEANS. They once
 * did: the tax engine read `half_year` as half of a year, the book engine as
 * half of one monthly period, and an asset on the half-year convention
 * recognised ~11.5 months of expense in year one instead of six. Nothing
 * connected the two spellings, so nothing could catch it.
 *
 * These tests are that connection.
 */

test("both engines draw their conventions from the shared vocabulary", () => {
  for (const convention of [...BOOK_DEPRECIATION_CONVENTIONS, ...TAX_DEPRECIATION_CONVENTIONS]) {
    assert.ok(
      CONVENTION_SHAPES[convention],
      `${convention} is declared in a schema enum but has no shared definition`,
    );
  }
});

test("CROSS-ENGINE: date-independent conventions allow the same first year in both", () => {
  // The one number both engines must agree on: the share of a full year's
  // depreciation allowed in year one. Measured independently on each side —
  // the book engine by summing twelve months of a real schedule, the tax engine
  // by its half-months-of-24 unit — and compared.
  for (const convention of DATE_INDEPENDENT_CONVENTIONS) {
    const declared = firstYearFraction(convention);
    assert.ok(declared, `${convention} should be date-independent`);

    // --- BOOK: sum year one of an actual 24-month straight-line schedule.
    // 12,000 over 24 months is 6,000 a year, so year one / 6,000 is the share.
    const lines = computeSchedule({
      cost: "12000.0000",
      salvage: "0.0000",
      inServiceOn: "2026-01-15",
      lifeMonths: 24,
      method: "straight_line",
      convention,
    });
    const yearOne = lines.slice(0, 12).reduce((total, line) => total + toUnits(line.planned), 0n);
    const bookShare = (yearOne * BigInt(declared.denominator)) / toUnits("6000");

    // --- TAX: half-months in service out of a 24-half-month year.
    const taxShare =
      convention === "full_month"
        ? BigInt(declared.denominator) // no tax analogue; a full year by definition
        : taxConventionHalfMonths(convention, 1, "placed");

    assert.equal(
      bookShare,
      taxShare,
      `${convention}: the book engine allows ${bookShare}/24 of a year while the ` +
        `tax engine allows ${taxShare}/24 — the engines disagree about the rule`,
    );
    assert.equal(BigInt(declared.numerator), taxShare, `${convention}: shared table disagrees too`);
  }
});

test("half-year is half a year in both engines, stated plainly", () => {
  assert.deepEqual(firstYearFraction("half_year"), { numerator: 12, denominator: 24 });
  assert.equal(taxConventionHalfMonths("half_year", 7, "placed"), 12n, "month must not matter");
  assert.deepEqual(bookConventionWindow("half_year"), {
    firstPeriodFraction: "0.5",
    firstFractionPeriods: 12,
  });
});

test("mid-month reduces ONE month, half-year reduces TWELVE", () => {
  // The distinction the old code collapsed. Both take half; the widths differ.
  assert.equal(CONVENTION_SHAPES.mid_month.reducedFraction, "0.5");
  assert.equal(CONVENTION_SHAPES.half_year.reducedFraction, "0.5");
  assert.equal(CONVENTION_SHAPES.mid_month.reducedMonths, 1);
  assert.equal(CONVENTION_SHAPES.half_year.reducedMonths, 12);
  assert.notDeepEqual(bookConventionWindow("mid_month"), bookConventionWindow("half_year"));
});

test("date-dependent conventions refuse to state a single first-year fraction", () => {
  // mid_month and mid_quarter place the asset mid-month or mid-quarter, so the
  // answer needs a date. Returning a number anyway is how a wrong constant gets
  // baked in.
  assert.equal(firstYearFraction("mid_month"), null);
  assert.equal(firstYearFraction("mid_quarter"), null);
  assert.equal(taxConventionHalfMonths("mid_month", 1, "placed"), 23n);
  assert.equal(taxConventionHalfMonths("mid_month", 12, "placed"), 1n);
  assert.equal(taxConventionHalfMonths("mid_quarter", 1, "placed"), 21n);
  assert.equal(taxConventionHalfMonths("mid_quarter", 12, "placed"), 3n);
});

test("the book engine cannot be handed a convention it has no representation for", () => {
  // mid_quarter is MACRS-only. The schema tuples encode that, and the book
  // window falls back to a full first period rather than inventing a meaning.
  assert.ok(!(BOOK_DEPRECIATION_CONVENTIONS as readonly string[]).includes("mid_quarter"));
  assert.ok((TAX_DEPRECIATION_CONVENTIONS as readonly string[]).includes("mid_quarter"));
  assert.deepEqual(bookConventionWindow(null), { firstPeriodFraction: "1", firstFractionPeriods: 1 });
});
