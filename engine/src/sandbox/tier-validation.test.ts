import assert from "node:assert/strict";
import test from "node:test";
import { selectCloneTables } from "./clone.ts";

test("clone selection refuses an unknown tier instead of selecting every table", () => {
  const tables = [
    { name: "app_roles" },
    { name: "journal_entries" },
  ] as never[];
  assert.throws(
    () => selectCloneTables(tables, "unmasked-everything" as never),
    /invalid sandbox tier.*choose dev, masked, full, or as_of/,
  );
});

test("clone selection preserves the reduced developer tier and full tiers", () => {
  const tables = [
    { name: "app_roles" },
    { name: "journal_entries" },
  ] as never[];
  assert.deepEqual(selectCloneTables(tables, "dev").map((table) => table.name), ["app_roles"]);
  assert.deepEqual(selectCloneTables(tables, "full").map((table) => table.name), ["app_roles", "journal_entries"]);
});
