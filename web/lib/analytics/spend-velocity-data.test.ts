import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export {}", format: "module", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { getSpendVelocityComparisonWindows, velocityAndAcceleration } = await import(
  "./spend-velocity-data.ts"
);
hooks.deregister();

test("comparison windows preserve inclusive current-period length", () => {
  assert.deepEqual(
    getSpendVelocityComparisonWindows("2026-01-01", "2026-01-31"),
    {
      periodDays: 31,
      priorFrom: "2025-12-01",
      priorTo: "2025-12-31",
      twoBackFrom: "2025-10-31",
      twoBackTo: "2025-11-30",
    },
  );
});

test("one-day periods still produce one-day prior windows", () => {
  assert.deepEqual(
    getSpendVelocityComparisonWindows("2026-02-14", "2026-02-14"),
    {
      periodDays: 1,
      priorFrom: "2026-02-13",
      priorTo: "2026-02-13",
      twoBackFrom: "2026-02-12",
      twoBackTo: "2026-02-12",
    },
  );
});

test("flat spend has zero velocity and acceleration", () => {
  assert.deepEqual(velocityAndAcceleration([200, 200, 200, 200, 200, 200]), {
    velocity: 0,
    acceleration: 0,
    trend: "stable",
  });
});

test("repeating spend does not turn a shared midpoint into acceleration", () => {
  assert.deepEqual(velocityAndAcceleration([100, 200, 100, 200]), {
    velocity: 26,
    acceleration: 0,
    trend: "high",
  });
});

test("rising spend detects acceleration from disjoint equal-length halves", () => {
  const amounts = [100, 100, 100, 200, 300, 500];
  const midpoint = Math.floor(amounts.length / 2);
  const earlier = amounts.slice(0, midpoint);
  const later = amounts.slice(midpoint);

  assert.equal(earlier.length, later.length);
  assert.deepEqual([...earlier, ...later], amounts);
  const earlierIndexes = earlier.map((_, index) => index);
  const laterIndexes = later.map((_, index) => index + midpoint);
  assert.equal(new Set([...earlierIndexes, ...laterIndexes]).size, amounts.length);
  assert.deepEqual(velocityAndAcceleration(amounts), {
    velocity: 38,
    acceleration: 58.1,
    trend: "accelerating",
  });
});

test("falling spend retains the acceleration signal from disjoint halves", () => {
  assert.deepEqual(velocityAndAcceleration([500, 300, 200, 100, 100, 100]), {
    velocity: -27.5,
    acceleration: 36.8,
    trend: "declining",
  });
});
