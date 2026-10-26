import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";

stubModules({ navigation: false });
const { matchesCreateAction } = await import("./global-search");
const verbs = ["new", "create", "add", "enter", "make"];

test("typed commands match create actions by the words of their label", () => {
  assert.equal(matchesCreateAction("new bill", "Bill", verbs), true);
  assert.equal(matchesCreateAction("bill", "Bill", verbs), true);
  assert.equal(matchesCreateAction("create inv", "Invoice", verbs), true);
  assert.equal(matchesCreateAction("jour", "Journal entry", verbs), true);
  assert.equal(matchesCreateAction("batch", "Several bills (batch entry)", verbs), true);
  assert.equal(
    matchesCreateAction("new", "Vendor credit", verbs),
    true,
    "a verb alone lists every action",
  );
});

test("a command naming other words does not match", () => {
  assert.equal(matchesCreateAction("new payroll", "Bill", verbs), false);
  assert.equal(matchesCreateAction("report", "Invoice", verbs), false);
});
