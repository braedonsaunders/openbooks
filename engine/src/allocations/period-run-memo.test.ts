import assert from "node:assert/strict";
import test from "node:test";
import { renderMemo } from "./period-run.ts";

const VARS = {
  ruleName: "Rent",
  periodName: "2026-07",
  periodLabel: "P07 FY2026",
  targetLabel: "Dept A",
};

test("an authored {{period.name}} token keeps the stored period name the author configured against", () => {
  assert.equal(
    renderMemo("{{rule.name}} for {{period.name}} to {{target.label}}", VARS),
    "Rent for 2026-07 to Dept A",
  );
});

test("the system memo without a template names the period by its canonical fiscal label", () => {
  assert.equal(renderMemo(null, VARS), "Rent — P07 FY2026 — Dept A");
  assert.equal(renderMemo("", { ...VARS, targetLabel: "" }), "Rent — P07 FY2026");
});
