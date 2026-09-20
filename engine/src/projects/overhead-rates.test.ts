import assert from "node:assert/strict";
import test from "node:test";
import { formatMoney } from "../money/money.ts";
import {
  assertOverheadRatesPublishable,
  compareOverheadDecimals,
  deriveOverheadCategoryDeptRates,
  deriveOverheadDeptComposite,
  formatOverheadPublishRate,
  overheadPublishBlockers,
  quantizeOverheadMoney,
  UnsupportedOverheadRateError,
} from "./overhead-rates.ts";

/** One category over two departments with hand-checked exact rates. */
const X = { expenseByDept: { A: "100.00", B: "50.00" }, baseByDept: { A: "4", B: "2" } };
// X: A 25.0000, B 25.0000.

test("simple division is exact to 4dp, including repeating decimals", () => {
  assert.deepEqual(
    deriveOverheadCategoryDeptRates({ id: "x", allocationMethod: "simple", ...X }),
    { A: "25.0000", B: "25.0000" },
  );
  assert.deepEqual(
    deriveOverheadCategoryDeptRates({
      id: "r",
      allocationMethod: "simple",
      expenseByDept: { D: "100.00" },
      baseByDept: { D: "3" },
    }),
    { D: "33.3333" },
  );
});

test("zero or missing base yields zero instead of throwing", () => {
  assert.deepEqual(
    deriveOverheadCategoryDeptRates({
      id: "z",
      allocationMethod: "simple",
      expenseByDept: { A: "100.00", B: "5.00" },
      baseByDept: { A: "0" },
    }),
    { A: "0.0000", B: "0.0000" },
  );
});

test("weighted per-department rate is the exact division (weights cancel)", () => {
  assert.deepEqual(
    deriveOverheadCategoryDeptRates({ id: "x", allocationMethod: "weighted", ...X }),
    { A: "25.0000", B: "25.0000" },
  );
});

test("stepped resolves the tier by department base, else exact division", () => {
  const tiers = [
    { min: 0, max: 10, rate: "20.00" },
    { min: 10, max: 100, rate: "30.00" },
  ];
  assert.deepEqual(
    deriveOverheadCategoryDeptRates({
      id: "s",
      allocationMethod: "stepped",
      allocationTiers: tiers,
      expenseByDept: { A: "100.00", B: "50.00", C: "400.00" },
      baseByDept: { A: "4", B: "50", C: "200" },
    }),
    { A: "20.0000", B: "30.0000", C: "2.0000" },
  );
});

test("stepped prefers the highest matching tier at exact boundaries", () => {
  assert.deepEqual(
    deriveOverheadCategoryDeptRates({
      id: "s",
      allocationMethod: "stepped",
      allocationTiers: [
        { min: 0, max: 10, rate: "20.00" },
        { min: 10, max: 100, rate: "30.00" },
      ],
      expenseByDept: { A: "100.00" },
      baseByDept: { A: "10" },
    }),
    { A: "30.0000" },
  );
});

test("stepped skips zero-rated tiers and honors an explicit zero max", () => {
  assert.deepEqual(
    deriveOverheadCategoryDeptRates({
      id: "s",
      allocationMethod: "stepped",
      allocationTiers: [
        { min: 0, max: 100, rate: "0" },
        { min: 0, max: 100, rate: "30.00" },
      ],
      expenseByDept: { A: "100.00" },
      baseByDept: { A: "4" },
    }),
    { A: "30.0000" },
  );
  assert.deepEqual(
    deriveOverheadCategoryDeptRates({
      id: "s",
      allocationMethod: "stepped",
      allocationTiers: [{ min: 0, max: 0, rate: "99.00" }],
      expenseByDept: { A: "100.00" },
      baseByDept: { A: "0" },
    }),
    { A: "99.0000" },
  );
});

test("sum composite adds included category rates exactly", () => {
  assert.equal(
    deriveOverheadDeptComposite({
      compositeMethod: "sum",
      categories: [
        { id: "x", rate: "25.0000", expense: "100.00", rateFormat: "per_hour", includeInComposite: true },
        { id: "y", rate: "7.5000", expense: "30.00", rateFormat: "per_hour", includeInComposite: true },
        { id: "skip", rate: "999.0000", expense: "999.00", rateFormat: "per_hour", includeInComposite: false },
      ],
    }),
    "32.5000",
  );
});

test("weighted composite is the expense-weighted mean of department rates", () => {
  // (25x100 + 7.5x30)/130 = 20.9615... ; (25x50 + 45x90)/140 = 37.8571...
  assert.equal(
    deriveOverheadDeptComposite({
      compositeMethod: "weighted",
      categories: [
        { id: "x", rate: "25.0000", expense: "100.00", rateFormat: "per_hour", includeInComposite: true },
        { id: "y", rate: "7.5000", expense: "30.00", rateFormat: "per_hour", includeInComposite: true },
      ],
    }),
    "20.9615",
  );
  assert.equal(
    deriveOverheadDeptComposite({
      compositeMethod: "weighted",
      categories: [
        { id: "x", rate: "25.0000", expense: "50.00", rateFormat: "per_hour", includeInComposite: true },
        { id: "y", rate: "45.0000", expense: "90.00", rateFormat: "per_hour", includeInComposite: true },
      ],
    }),
    "37.8571",
  );
});

test("weighted composite with no positive expense is zero, not NaN", () => {
  assert.equal(
    deriveOverheadDeptComposite({
      compositeMethod: "weighted",
      categories: [
        { id: "x", rate: "25.0000", expense: "0.00", rateFormat: "per_hour", includeInComposite: true },
      ],
    }),
    "0.0000",
  );
});

test("cascading runs absolute rates over the department labor rate", () => {
  assert.equal(
    deriveOverheadDeptComposite({
      compositeMethod: "cascading",
      baseLaborRate: "50.0000",
      categories: [
        { id: "x", rate: "25.0000", expense: "100.00", rateFormat: "per_hour", includeInComposite: true },
        { id: "y", rate: "7.5000", expense: "30.00", rateFormat: "per_hour", includeInComposite: true },
      ],
    }),
    "32.5000",
  );
});

test("cascading compounds percent categories and respects cascade order", () => {
  const cats = [
    { id: "x", rate: "25.0000", expense: "100.00", rateFormat: "per_hour" as const, includeInComposite: true },
    { id: "z", rate: "10.0000", expense: "13.00", rateFormat: "percent_labor" as const, includeInComposite: true },
  ];
  // (50 + 25) * 1.10 - 50 = 32.5
  assert.equal(
    deriveOverheadDeptComposite({ compositeMethod: "cascading", baseLaborRate: "50.0000", categories: cats }),
    "32.5000",
  );
  // 50 * 1.10 + 25 - 50 = 30.0 when the percent layer runs first.
  assert.equal(
    deriveOverheadDeptComposite({
      compositeMethod: "cascading",
      baseLaborRate: "50.0000",
      cascadeOrder: ["z", "x"],
      categories: cats,
    }),
    "30.0000",
  );
});

test("cascading defaults the labor base to 50 like the Overall headline", () => {
  assert.equal(
    deriveOverheadDeptComposite({
      compositeMethod: "cascading",
      categories: [
        { id: "x", rate: "10.0000", expense: "100.00", rateFormat: "per_hour", includeInComposite: true },
      ],
    }),
    "10.0000",
  );
});

test("empty and fully-excluded composites are zero", () => {
  assert.equal(deriveOverheadDeptComposite({ compositeMethod: "sum", categories: [] }), "0.0000");
  assert.equal(
    deriveOverheadDeptComposite({
      compositeMethod: "cascading",
      categories: [
        { id: "x", rate: "10.0000", expense: "100.00", rateFormat: "per_hour", includeInComposite: false },
      ],
    }),
    "0.0000",
  );
});

test("publish rounding is halves-away-from-zero at cents, once", () => {
  assert.equal(formatOverheadPublishRate("33.3333"), "33.33");
  assert.equal(formatOverheadPublishRate("2.6750"), "2.68");
  assert.equal(formatOverheadPublishRate("-2.6750"), "-2.68");
  assert.equal(formatOverheadPublishRate("32.5000"), "32.50");
});

test("legacy float path cannot publish a repeating decimal (finding 6.5)", () => {
  // The pre-fix publication mapping ran formatMoney(String(floatComposite)).
  // A $100 burden over 3 billed hours is the ordinary case that broke it.
  assert.throws(() => formatMoney(String(100 / 3), 2), /loses precision beyond 4 decimal places/);
  // The exact contract publishes it at cents with no float involved.
  assert.equal(
    formatOverheadPublishRate(
      deriveOverheadDeptComposite({
        compositeMethod: "sum",
        categories: [
          { id: "x", rate: "33.3333", expense: "100.00", rateFormat: "per_hour", includeInComposite: true },
        ],
      }),
    ),
    "33.33",
  );
});

test("publish gate blocks non-hourly included formats and passes hourly ones", () => {
  assert.deepEqual(overheadPublishBlockers([]), []);
  assert.deepEqual(
    overheadPublishBlockers([
      { id: "a", name: "Rent", rateFormat: "per_hour", includeInComposite: true },
      { id: "b", name: "Admin", rateFormat: "per_hour", includeInComposite: false },
    ]),
    [],
  );
  const blocked = overheadPublishBlockers([
    { id: "a", name: "Rent", rateFormat: "per_hour", includeInComposite: true },
    { id: "p", name: "Benefits", rateFormat: "percent_labor", includeInComposite: true },
    { id: "q", name: "Old", rateFormat: "percent_cost", includeInComposite: false },
  ]);
  assert.equal(blocked.length, 1);
  assert.match(blocked[0]?.reason ?? "", /Benefits.*percent_labor.*per-hour rate card/);
  for (const format of ["percent_labor", "percent_cost", "per_fte", "per_unit"] as const) {
    assert.equal(
      overheadPublishBlockers([{ id: "c", rateFormat: format, includeInComposite: true }]).length,
      1,
      format,
    );
  }
});

test("publish gate refusal carries every blocker", () => {
  try {
    assertOverheadRatesPublishable([
      { id: "p", name: "Benefits", rateFormat: "percent_labor", includeInComposite: true },
    ]);
    assert.fail("expected UnsupportedOverheadRateError");
  } catch (e) {
    assert.ok(e instanceof UnsupportedOverheadRateError);
    assert.equal(e.blockers.length, 1);
    assert.match(e.message, /cannot publish/);
  }
  assertOverheadRatesPublishable([
    { id: "a", rateFormat: "per_hour", includeInComposite: true },
  ]);
});

test("quantizeOverheadMoney rounds config decimals exactly, idempotent on money", () => {
  assert.equal(quantizeOverheadMoney("2.6750"), "2.6750");
  assert.equal(quantizeOverheadMoney("33.333333333333336"), "33.3333");
  assert.equal(quantizeOverheadMoney(50), "50.0000");
  assert.equal(quantizeOverheadMoney("1.00005"), "1.0001");
  assert.equal(quantizeOverheadMoney("1.00004"), "1.0000");
  assert.equal(quantizeOverheadMoney("-1.00005"), "-1.0001");
  assert.equal(quantizeOverheadMoney("0.00001"), "0.0000");
  assert.equal(quantizeOverheadMoney("-0.00001"), "0.0000");
  assert.throws(() => quantizeOverheadMoney("abc"), /not a decimal/);
});

test("compareOverheadDecimals orders finite decimals without floats", () => {
  assert.equal(compareOverheadDecimals("10", "9"), 1);
  assert.equal(compareOverheadDecimals("0.1", "0.10"), 0);
  assert.equal(compareOverheadDecimals("1.5", "2"), -1);
  assert.equal(compareOverheadDecimals("-3", "-2"), -1);
  assert.equal(compareOverheadDecimals("1000000.00", "999999.9999"), 1);
});
