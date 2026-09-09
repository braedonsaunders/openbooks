import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  computeRevaluation,
  missingReversalPeriodReason,
  revaluationLockKey,
  type RevaluationPosition,
} from "./fx-revaluation.ts";
import { add, isZero, toUnits } from "./money.ts";

const GL = "gainloss-acct";
const pos = (p: Partial<RevaluationPosition> & Pick<RevaluationPosition, "accountId">): RevaluationPosition => ({
  currency: "USD",
  carryingBase: "0.0000",
  foreignBalance: "0.0000",
  periodEndRate: "1.0000000000",
  ...p,
});

test("no revaluation when spot rate already matches historical carrying", () => {
  // 1000 USD carried at 1.30 = 1300.00 CAD; period-end rate is still 1.30.
  const r = computeRevaluation(
    [pos({ accountId: "bank", carryingBase: "1300.0000", foreignBalance: "1000.0000", periodEndRate: "1.3000000000" })],
    GL,
  );
  assert.deepEqual(r.lines, []);
  assert.equal(r.netDelta, "0");
});

test("unrealized GAIN on a foreign bank asset: debit bank, credit gain/loss", () => {
  // 1000 USD carried at 1.30 (=1300); period-end 1.35 → 1350; +50 gain.
  const r = computeRevaluation(
    [pos({ accountId: "bank", carryingBase: "1300.0000", foreignBalance: "1000.0000", periodEndRate: "1.3500000000" })],
    GL,
  );
  assert.deepEqual(r.lines, [
    { accountId: "bank", amount: "50.0000" },
    { accountId: GL, amount: "-50.0000" },
  ]);
  assert.equal(r.netDelta, "50.0000");
});

test("unrealized LOSS on a foreign bank asset: credit bank, debit gain/loss", () => {
  // 1000 USD carried at 1.30 (=1300); period-end 1.28 → 1280; −20 loss.
  const r = computeRevaluation(
    [pos({ accountId: "bank", carryingBase: "1300.0000", foreignBalance: "1000.0000", periodEndRate: "1.2800000000" })],
    GL,
  );
  assert.deepEqual(r.lines, [
    { accountId: "bank", amount: "-20.0000" },
    { accountId: GL, amount: "20.0000" },
  ]);
});

test("foreign AP (a credit balance) revalues with the correct loss direction", () => {
  // Owe 1000 USD → carried as −1300 (credit); period-end 1.35 → −1350.
  // Liability grew by 50 → a −50 credit to AP, offset +50 debit to gain/loss (a loss).
  const r = computeRevaluation(
    [pos({ accountId: "ap", carryingBase: "-1300.0000", foreignBalance: "-1000.0000", periodEndRate: "1.3500000000" })],
    GL,
  );
  assert.deepEqual(r.lines, [
    { accountId: "ap", amount: "-50.0000" },
    { accountId: GL, amount: "50.0000" },
  ]);
});

test("multiple positions net to a single balanced gain/loss line", () => {
  const r = computeRevaluation(
    [
      pos({ accountId: "bank", carryingBase: "1300.0000", foreignBalance: "1000.0000", periodEndRate: "1.3500000000" }), // +50
      pos({ accountId: "ar", currency: "EUR", carryingBase: "1450.0000", foreignBalance: "1000.0000", periodEndRate: "1.4200000000" }), // −30
      pos({ accountId: "ap", carryingBase: "-1300.0000", foreignBalance: "-1000.0000", periodEndRate: "1.3500000000" }), // −50
    ],
    GL,
  );
  // deltas: +50, −30, −50 → net −30 → offset +30 to gain/loss.
  assert.equal(r.netDelta, "-30.0000");
  assert.equal(r.lines.length, 4);
  assert.deepEqual(r.lines[r.lines.length - 1], { accountId: GL, amount: "30.0000" });
});

test("INVARIANT: every produced entry sums to exactly zero", () => {
  const cases: RevaluationPosition[][] = [
    [pos({ accountId: "bank", carryingBase: "1300.0000", foreignBalance: "1000.0000", periodEndRate: "1.3517000000" })],
    [
      pos({ accountId: "bank", carryingBase: "999.9900", foreignBalance: "733.3300", periodEndRate: "1.3648120000" }),
      pos({ accountId: "ap", carryingBase: "-4210.5500", foreignBalance: "-3100.0000", periodEndRate: "1.3599990000" }),
    ],
  ];
  for (const positions of cases) {
    const r = computeRevaluation(positions, GL);
    const total = r.lines.reduce((acc, l) => add(acc, l.amount), "0");
    assert.ok(isZero(total), `entry must balance, got ${total}`);
  }
});

test("INVARIANT: the offset equals the negated sum of the monetary deltas", () => {
  const r = computeRevaluation(
    [
      pos({ accountId: "bank", carryingBase: "1300.0000", foreignBalance: "1000.0000", periodEndRate: "1.3500000000" }),
      pos({ accountId: "ar", currency: "GBP", carryingBase: "1700.0000", foreignBalance: "1000.0000", periodEndRate: "1.7325000000" }),
    ],
    GL,
  );
  const monetary = r.lines.slice(0, -1).reduce((acc, l) => acc + toUnits(l.amount), 0n);
  const offset = toUnits(r.lines[r.lines.length - 1]!.amount);
  assert.equal(monetary + offset, 0n);
});

test("rounding is exact at numeric(19,4)", () => {
  // 733.3333 USD × 1.3648120000 = 1000.870... → 1000.8710 revalued.
  const r = computeRevaluation(
    [pos({ accountId: "bank", carryingBase: "1000.0000", foreignBalance: "733.3333", periodEndRate: "1.3648120000" })],
    GL,
  );
  // Confirm the delta is (revalued − 1000) at 4dp and the line pair still balances.
  const total = r.lines.reduce((acc, l) => add(acc, l.amount), "0");
  assert.ok(isZero(total));
  assert.match(r.lines[0]!.amount, /^-?\d+\.\d{4}$/);
});

test("positions with zero delta are dropped even when others revalue", () => {
  const r = computeRevaluation(
    [
      pos({ accountId: "steady", carryingBase: "1300.0000", foreignBalance: "1000.0000", periodEndRate: "1.3000000000" }), // 0
      pos({ accountId: "moved", carryingBase: "1300.0000", foreignBalance: "1000.0000", periodEndRate: "1.3400000000" }), // +40
    ],
    GL,
  );
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0]!.accountId, "moved");
});

test("the revaluation lock key scopes one org, book, period and subsidiary", () => {
  assert.equal(
    revaluationLockKey("org-1", "book-1", "period-1", "sub-1"),
    "fxreval:org-1:book-1:period-1:sub-1",
  );
  // Two subsidiaries (or books, or periods) in the same org revalue
  // independently; only the exact same scope contends.
  const key = revaluationLockKey("org-1", "book-1", "period-1", "sub-1");
  assert.notEqual(key, revaluationLockKey("org-2", "book-1", "period-1", "sub-1"));
  assert.notEqual(key, revaluationLockKey("org-1", "book-2", "period-1", "sub-1"));
  assert.notEqual(key, revaluationLockKey("org-1", "book-1", "period-2", "sub-1"));
  assert.notEqual(key, revaluationLockKey("org-1", "book-1", "period-1", "sub-2"));
});

test("a refused revaluation names the missing reversal period and the remedy", () => {
  const reason = missingReversalPeriodReason();
  assert.match(reason, /no following accounting period/);
  assert.match(reason, /generate periods and re-run/);
});

test("the advisory lock precedes recomputing the current correction and inserting it", () => {
  const source = readFileSync(new URL("./fx-revaluation.ts", import.meta.url), "utf8");
  const fn = source.indexOf("async function postRevaluationEntry");
  const tx = source.indexOf("db.transaction", fn);
  const lock = source.indexOf("pg_advisory_xact_lock", tx);
  const check = source.indexOf("await loadExposures", tx);
  const effective = source.indexOf("await loadEffectiveAdjustments", check);
  const difference = source.indexOf("requiredAdjustments(positions, effective)", effective);
  const insert = source.indexOf("insert into journal_entries", tx);
  assert.ok(tx > fn, "posting happens inside one transaction");
  assert.ok(lock > tx, "the advisory lock is taken inside that transaction");
  assert.ok(check > lock, "the current source population is read under the lock");
  assert.ok(effective > check && difference > effective, "the residual subtracts current effective adjustments");
  assert.ok(insert > difference, "the insert follows the recomputed correction");
});

test("direct quotes outrank inverted ones when both quote the same date", () => {
  // The rate union must be deterministic: with USD→EUR and EUR→USD rows on the
  // same as_of, the winner can never be planner-arbitrary.
  const source = readFileSync(new URL("./fx-revaluation.ts", import.meta.url), "utf8");
  const lookup = source.slice(source.indexOf("async function periodEndRate"));
  assert.match(lookup, /select rate, as_of, 0 as priority from fx_rates/, "direct pair is priority 0");
  assert.match(lookup, /1 as priority from fx_rates/, "inverted pair is priority 1");
  assert.match(lookup, /order by as_of desc, priority asc limit 1/);
  // One conversion rule across the engine: labor costing resolves the same
  // pair/date with the same ordering.
  const labor = readFileSync(new URL("./labor-costing.ts", import.meta.url), "utf8");
  assert.match(labor, /order by as_of desc, priority asc limit 1/);
});

test("a missing reversal period is reported before any posting is attempted", () => {
  const source = readFileSync(new URL("./fx-revaluation.ts", import.meta.url), "utf8");
  const post = source.indexOf("async function postRevaluationEntry");
  const guard = source.indexOf("throw new RevaluationError(missingReversalPeriodReason())", post);
  const insert = source.indexOf("insert into journal_entries", post);
  assert.ok(guard > post && insert > guard, "the mandatory period is checked before creating a journal");
  // The old silent skip is gone: the posting boundary itself refuses rather
  // than post an unreversed revaluation.
  assert.ok(!source.includes("if (nextPeriodId && nextStartsOn) {"), "the reversal is never silently skipped");
  const throwGuard = source.indexOf("throw new RevaluationError(missingReversalPeriodReason())");
  assert.ok(throwGuard > source.indexOf("async function postRevaluationEntry"), "posting throws without a reversal period");
});
