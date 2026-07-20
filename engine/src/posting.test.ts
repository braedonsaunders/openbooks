import assert from "node:assert/strict";
import test from "node:test";
import { controlLineIsOpenItem } from "./posting.ts";

const controlAccounts = new Set(["ar", "ap"]);

test("entity-bearing AR/AP journal lines participate in the subledger", () => {
  assert.equal(controlLineIsOpenItem("ar", "customer", controlAccounts), true);
  assert.equal(controlLineIsOpenItem("ap", "vendor", controlAccounts), true);
});

test("party-less control-account journals remain direct GL activity", () => {
  assert.equal(controlLineIsOpenItem("ar", null, controlAccounts), false);
  assert.equal(controlLineIsOpenItem("expense", "vendor", controlAccounts), false);
});
