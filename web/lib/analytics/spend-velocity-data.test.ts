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

const { getSpendVelocityComparisonWindows } = await import("./spend-velocity-data.ts");
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
