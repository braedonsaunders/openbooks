import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMoney, sum } from "../money/money.ts";
import {
  AllocationApportionError,
  apportion,
  fixedPercentWeights,
  steppedWeights,
} from "./apportion.ts";
import type { AllocationRuleTarget, WeightedTarget } from "./types.ts";

function wt(key: string, weight: string, isRemainder = false): WeightedTarget {
  return { key, weight, isRemainder };
}

/** Deterministic PRNG (mulberry32) — fuzz must be reproducible. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

function target(seq: number, fixedPercent: string | null, isRemainder = false, id?: string): AllocationRuleTarget {
  return { sequence: seq, fixedPercent, isRemainder, ...(id === undefined ? {} : { id }) };
}

test("apportion splits evenly with no lost cent", () => {
  const r = apportion("100.0000", [wt("a", "1"), wt("b", "1"), wt("c", "1")], "largest_share");
  assert.equal(sum(r.targets.map((t) => t.amount)), "100.0000");
  assert.equal(r.targets.length, 3);
  // 100/3 = 33.3333 x2 + 33.3334 to the largest-share (tie -> first) target.
  assert.equal(r.targets[0]?.amount, "33.3334");
  assert.equal(r.targets[1]?.amount, "33.3333");
  assert.equal(r.targets[2]?.amount, "33.3333");
  assert.equal(r.residualKey, "a");
  assert.equal(r.targets[0]?.residual, "0.0001");
  assert.equal(r.targets[1]?.residual, "0.0000");
});

test("apportion is exact across 1..1000 deterministic random weight sets", () => {
  const rand = prng(20260916);
  for (let i = 0; i < 1000; i += 1) {
    const n = 1 + Math.floor(rand() * 12);
    const weights: WeightedTarget[] = [];
    for (let k = 0; k < n; k += 1) {
      // Random 4dp-scale weights, sometimes zero, sometimes tied.
      const w = k > 0 && rand() < 0.15 ? weights[0]?.weight ?? "0" : String(Math.floor(rand() * 1000000));
      weights.push(wt(`t${k}`, w));
    }
    const sign = rand() < 0.3 ? "-" : "";
    const total = `${sign}${Math.floor(rand() * 1000000)}.${String(Math.floor(rand() * 10000)).padStart(4, "0")}`;
    const policies = ["largest_share", "first_target", "last_target"] as const;
    const policy = policies[Math.floor(rand() * policies.length)] ?? "largest_share";
    const r = apportion(total, weights, policy);
    assert.equal(sum(r.targets.map((t) => t.amount)), normalizeMoney(total), `case ${i} total ${total}`);
    // Exactly one target carries the (possibly zero) residual booking.
    const nonZero = r.targets.filter((t) => t.residual !== "0.0000");
    assert.ok(nonZero.length <= 1, `case ${i}: residual on >1 target`);
    assert.ok(r.targets.some((t) => t.key === r.residualKey), `case ${i}: residualKey must name a target`);
    for (const t of r.targets) {
      assert.match(t.share, /^\d+\.\d{10}$/, `case ${i}: share is 10dp`);
    }
  }
});

test("apportion preserves sign on negative totals", () => {
  const r = apportion("-100.0000", [wt("a", "1"), wt("b", "3")], "largest_share");
  assert.equal(sum(r.targets.map((t) => t.amount)), "-100.0000");
  assert.equal(r.targets[0]?.amount, "-25.0000");
  assert.equal(r.targets[1]?.amount, "-75.0000");
  assert.equal(r.targets[1]?.residual, "0.0000");
});

test("apportion handles 4dp totals and zero total", () => {
  const tiny = apportion("0.0001", [wt("a", "1"), wt("b", "1")], "last_target");
  assert.equal(sum(tiny.targets.map((t) => t.amount)), "0.0001");
  assert.equal(tiny.residualKey, "b");
  const zero = apportion("0.0000", [wt("a", "5"), wt("b", "7")], "largest_share");
  assert.deepEqual(zero.targets.map((t) => t.amount), ["0.0000", "0.0000"]);
  assert.equal(sum(zero.targets.map((t) => t.amount)), "0.0000");
});

test("apportion gives zero-weight targets zero and parks all-zero weight on the policy target", () => {
  const r = apportion("10.0000", [wt("a", "0"), wt("b", "3"), wt("c", "0")], "first_target");
  assert.equal(r.targets[0]?.amount, "0.0000");
  assert.equal(r.targets[2]?.amount, "0.0000");
  assert.equal(r.targets[0]?.share, "0.0000000000");
  assert.equal(sum(r.targets.map((t) => t.amount)), "10.0000");
  // All-zero weights fall back to an equal split: the money invariant wins.
  const flat = apportion("10.0000", [wt("a", "0"), wt("b", "0")], "last_target");
  assert.deepEqual(flat.targets.map((t) => t.amount), ["5.0000", "5.0000"]);
  assert.equal(sum(flat.targets.map((t) => t.amount)), "10.0000");
  assert.equal(flat.residualKey, "b");
  assert.deepEqual(flat.targets.map((t) => t.share), ["0.0000000000", "0.0000000000"]);
});

test("apportion routes the rounding residual per policy", () => {
  const w = [wt("a", "1"), wt("b", "1"), wt("c", "1")];
  assert.equal(apportion("100.0000", w, "first_target").residualKey, "a");
  assert.equal(apportion("100.0000", w, "last_target").residualKey, "c");
  const explicit = apportion("100.0000", w, "explicit_target", "b");
  assert.equal(explicit.residualKey, "b");
  assert.equal(explicit.targets[1]?.amount, "33.3334");
});

test("apportion sends the remainder to the is_remainder target for fixed_percent", () => {
  const weights = fixedPercentWeights([target(1, "30", false, "t1"), target(2, null, true, "t2")]);
  const r = apportion("100.0000", weights, "largest_share");
  const amounts = Object.fromEntries(r.targets.map((t) => [t.key, t.amount]));
  assert.equal(amounts["t1"], "30.0000");
  assert.equal(amounts["t2"], "70.0000");
  assert.equal(r.residualKey, "t2");
  assert.equal(sum(r.targets.map((t) => t.amount)), "100.0000");
});

test("apportion rejects bad inputs instead of losing money", () => {
  assert.throws(() => apportion("10.0000", [], "largest_share"), AllocationApportionError);
  assert.throws(() => apportion("10.0000", [wt("a", "-1")], "largest_share"), AllocationApportionError);
  assert.throws(
    () => apportion("10.0000", [wt("a", "1", true), wt("b", "2", true)], "largest_share"),
    AllocationApportionError,
  );
  assert.throws(() => apportion("10.0000", [wt("a", "1")], "explicit_target"), AllocationApportionError);
  assert.throws(() => apportion("10.0000", [wt("a", "1")], "explicit_target", "zzz"), AllocationApportionError);
  assert.throws(() => apportion("10.0000", [wt("a", "1"), wt("a", "2")], "largest_share"), AllocationApportionError);
  assert.throws(() => apportion("10.0000", [wt("a", "abc")], "largest_share"), AllocationApportionError);
  assert.throws(() => apportion("10.00x0", [wt("a", "1")], "largest_share"), Error);
  // Zero total over no targets is the only valid empty apportionment.
  const empty = apportion("0.0000", [], "largest_share");
  assert.equal(empty.targets.length, 0);
  assert.equal(empty.total, "0.0000");
});

test("fixedPercentWeights converts percents and derives the remainder", () => {
  const weights = fixedPercentWeights([target(1, "50", false, "a"), target(2, "30", false, "b"), target(3, "20", false, "c")]);
  assert.deepEqual(weights.map((x) => [x.key, x.weight]), [["a", "50.0000"], ["b", "30.0000"], ["c", "20.0000"]]);
  const withRem = fixedPercentWeights([target(1, "30", false, "a"), target(2, null, true, "r")]);
  assert.deepEqual(withRem.map((x) => [x.key, x.weight]), [["a", "30.0000"], ["r", "70.0000"]]);
  // Remainder absorbs fractional dust: 1 cent at 33.3333% x3 + remainder.
  const dusty = fixedPercentWeights([
    target(1, "33.3333", false, "a"),
    target(2, "33.3333", false, "b"),
    target(3, null, true, "r"),
  ]);
  assert.equal(dusty.find((x) => x.key === "r")?.weight, "33.3334");
  const r = apportion("0.0001", dusty, "largest_share");
  assert.equal(sum(r.targets.map((t) => t.amount)), "0.0001");
});

test("fixedPercentWeights refuses invalid percent grids", () => {
  // Sum < 100 with no remainder would silently drop money.
  assert.throws(
    () => fixedPercentWeights([target(1, "30", false, "a"), target(2, "30", false, "b")]),
    AllocationApportionError,
  );
  assert.throws(
    () => fixedPercentWeights([target(1, "60", false, "a"), target(2, "50", false, "b")]),
    AllocationApportionError,
  );
  assert.throws(() => fixedPercentWeights([target(1, "40", true, "a"), target(2, null, true, "b")]), AllocationApportionError);
  assert.throws(() => fixedPercentWeights([target(1, "101", false, "a")]), AllocationApportionError);
  assert.throws(() => fixedPercentWeights([target(1, "0", false, "a")]), AllocationApportionError);
  assert.throws(() => fixedPercentWeights([target(1, null, false, "a")]), AllocationApportionError);
  // Keys fall back to sequence when ids are absent; hash stability relies on this.
  const seq = fixedPercentWeights([target(1, "100")]);
  assert.equal(seq[0]?.key, "sequence:1");
});

test("steppedWeights slices the total into marginal tiers", () => {
  const weights = steppedWeights("2500.0000", [{ upTo: "1000", targetKey: "a" }, { upTo: "2000", targetKey: "b" }, { upTo: null, targetKey: "c" }]);
  assert.deepEqual(weights.map((x) => [x.key, x.weight]), [["a", "1000.0000"], ["b", "1000.0000"], ["c", "500.0000"]]);
  const r = apportion("2500.0000", weights, "largest_share");
  assert.equal(sum(r.targets.map((t) => t.amount)), "2500.0000");
  // Total below the first cap lands wholly in the first tier.
  const small = steppedWeights("400.0000", [{ upTo: "1000", targetKey: "a" }, { upTo: null, targetKey: "b" }]);
  assert.deepEqual(small.map((x) => x.weight), ["400.0000", "0.0000"]);
  // Exact cap boundary.
  const edge = steppedWeights("1000.0000", [{ upTo: "1000", targetKey: "a" }, { upTo: null, targetKey: "b" }]);
  assert.deepEqual(edge.map((x) => x.weight), ["1000.0000", "0.0000"]);
});

test("steppedWeights refuses tiers that cannot cover the total", () => {
  assert.throws(() => steppedWeights("2500.0000", [{ upTo: "1000", targetKey: "a" }]), AllocationApportionError);
  assert.throws(
    () => steppedWeights("100.0000", [{ upTo: "2000", targetKey: "a" }, { upTo: "1000", targetKey: "b" }]),
    AllocationApportionError,
  );
  assert.throws(() => steppedWeights("100.0000", []), AllocationApportionError);
  assert.throws(
    () => steppedWeights("100.0000", [{ upTo: null, targetKey: "a" }, { upTo: "5000", targetKey: "b" }]),
    AllocationApportionError,
  );
  assert.throws(() => steppedWeights("100.0000", [{ upTo: "abc", targetKey: "a" }]), AllocationApportionError);
});

test("fractional weights keep ten-decimal precision and reported shares cross-foot", () => {
  // A 0.5 : 1.5 split is exactly 25 / 75. Dropping the slice start or the
  // share scaling collapses the fractional weight to zero and the split
  // follows it.
  const r = apportion("100.0000", [wt("a", "0.5"), wt("b", "1.5")], "largest_share");
  assert.equal(r.targets[0]!.amount, "25.0000");
  assert.equal(r.targets[1]!.amount, "75.0000");
  assert.equal(r.targets[0]!.share, "0.2500000000");
  assert.equal(r.targets[1]!.share, "0.7500000000");
  assert.equal(r.weightTotal, "2");
  // Ten-decimal weights are representable: the precision guard only refuses
  // beyond ten places, and the weight total formats sub-unit sums exactly.
  const fine = apportion("10.0000", [wt("a", "0.1234567890"), wt("b", "0.8765432110")], "first_target");
  assert.equal(fine.weightTotal, "1");
  assert.equal(sum(fine.targets.map((t) => t.amount)), "10.0000");
  assert.equal(apportion("10.0000", [wt("a", "0.5")], "first_target").weightTotal, "0.5");
  // Sub-ten-digit fractions exercise the zero padding, not just the strip.
  assert.equal(
    apportion("10.0000", [wt("a", "0.0000000005")], "first_target").weightTotal,
    "0.0000000005",
  );
});

test("a negative weight is refused as negative, even one unit below zero", () => {
  assert.throws(() => apportion("10.0000", [wt("a", "-1")], "largest_share"), /negative/);
  assert.throws(() => apportion("10.0000", [wt("a", "-0.0000000001")], "largest_share"), /negative/);
});

test("a bare decimal point is refused as malformed, never silently zero", () => {
  // The empty-fraction refusal only fires when the whole part is missing too:
  // "5." parses as five, but "." must not slip through as a zero weight.
  assert.throws(() => apportion("10.0000", [wt("a", ".")], "largest_share"), /not a decimal/);
  const dotted = apportion("10.0000", [wt("a", "5."), wt("b", "5")], "first_target");
  assert.equal(sum(dotted.targets.map((t) => t.amount)), "10.0000");
});

test("a dust fixed percent inside (0, 100] is accepted and resolves the remainder", () => {
  const weights = fixedPercentWeights([target(1, "0.0001", false, "t1"), target(2, null, true, "t2")]);
  assert.equal(weights[0]!.weight, "0.0001");
  assert.equal(weights[1]!.weight, "99.9999");
});

test("stepped tiers refuse an empty grid, honor sub-unit totals, and refuse negative bounds", () => {
  assert.throws(() => steppedWeights("0.0000", []), /at least one tier/);
  const neg = steppedWeights("-0.0001", [{ upTo: "1.0000", targetKey: "t1" }]);
  assert.deepEqual(neg.map((x) => x.weight), ["0.0001"]);
  assert.throws(() => steppedWeights("10.0000", [{ upTo: "-0.0001", targetKey: "t1" }]), /negative/);
  // A zero bound is not negative — it fails the ascent check instead.
  assert.throws(() => steppedWeights("10.0000", [{ upTo: "0.0000", targetKey: "t1" }]), /ascend/);
});
