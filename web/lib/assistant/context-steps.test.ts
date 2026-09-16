import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveStepBudget,
  STEP_BUDGET_DEEP,
  STEP_BUDGET_SIMPLE,
  STEP_BUDGET_STANDARD,
} from "./context-steps";

// Module resolver mirroring the registry mapping (tool -> moduleOfTool).
function resolveModule(toolName: string): string {
  if (toolName === "tax_return") return "tax";
  if (toolName === "analytics_sentinel") return "analytics";
  if (toolName === "find_documents") return "ledger";
  return "core";
}

test("greetings and capability questions get the simple budget", () => {
  assert.equal(resolveStepBudget("hello, what can you do?", [], resolveModule), STEP_BUDGET_SIMPLE);
  assert.equal(resolveStepBudget("who am I?", [], resolveModule), STEP_BUDGET_SIMPLE);
});

test("general analysis gets the standard budget", () => {
  assert.equal(
    resolveStepBudget("compare revenue against budget for Q2", [], resolveModule),
    STEP_BUDGET_STANDARD,
  );
  assert.equal(
    resolveStepBudget("tell me more", ["tax_return"], resolveModule),
    STEP_BUDGET_STANDARD,
  );
});

test("close work gets the deep budget", () => {
  assert.equal(
    resolveStepBudget("walk me through the month-end close checklist", [], resolveModule),
    STEP_BUDGET_DEEP,
  );
  assert.equal(
    resolveStepBudget("which periods are still locked?", [], resolveModule),
    STEP_BUDGET_DEEP,
  );
});

test("forensics gets the deep budget, plain analytics does not", () => {
  assert.equal(
    resolveStepBudget("run a forensic review for suspicious round-dollar entries", [], resolveModule),
    STEP_BUDGET_DEEP,
  );
  assert.equal(
    resolveStepBudget("show me the customer intelligence dashboard", [], resolveModule),
    STEP_BUDGET_STANDARD,
  );
});

test("budgets never exceed the documented tiers", () => {
  for (const message of ["hi", "close the books", "analyse cashflow vs forecast"]) {
    const budget = resolveStepBudget(message, [], resolveModule);
    assert.ok(
      [STEP_BUDGET_SIMPLE, STEP_BUDGET_STANDARD, STEP_BUDGET_DEEP].includes(budget),
      `${message} -> ${budget}`,
    );
  }
});
