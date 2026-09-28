import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { BUILT_IN_ROLES, PERMISSION_CATALOGUE, PERMISSION_GROUPS, permissionLabelKey, permissionSetCovers } from "@openbooks/engine/src/organization/permissions.ts";
import { getRecordType } from "@openbooks/customization";
import { entityListSource } from "../list/entity-sources.ts";
// Shared fund registry properties — catalogue, labels, storage, sources.
test("funds pair is catalogued, grouped, granted least-privilege, and labelled", () => {
  assert.deepEqual(PERMISSION_GROUPS.find((e) => e.key === "nonprofit")?.permissions.map((e) => e.key), ["nonprofit.report", "funds.read", "funds.manage"]);
  for (const k of ["funds.read", "funds.manage"]) assert.ok((PERMISSION_CATALOGUE as readonly string[]).includes(k));
  assert.equal(permissionLabelKey("funds.read" as never), "permissions.funds_read");
  const holds = (r: string, p: string) => permissionSetCovers(new Set(BUILT_IN_ROLES[r]!.permissions), p);
  for (const [r, p, w] of [["controller", "funds.manage", 1], ["accountant", "funds.manage", 0], ["accountant", "funds.read", 1], ["approver", "funds.read", 1], ["viewer", "funds.read", 1], ["viewer", "funds.manage", 0]] as [string, string, number][]) assert.equal(holds(r, p), Boolean(w), `${r} ${p}`);
  const dir = join(import.meta.dirname, "..", "..", "messages");
  const missing = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).filter((l) => ["funds_read", "funds_manage"].some((k) => typeof (JSON.parse(readFileSync(join(dir, l, "admin.json"), "utf8")) as { permissions?: Record<string, string> }).permissions?.[k] !== "string"));
  assert.deepEqual(missing, []);
  for (const [key, table] of [["fund", "funds"], ["fund_release", "fund_releases"]]) { assert.equal(getRecordType(key)?.featureKey, "fundAccounting"); assert.equal(getRecordType(key)?.customFieldTable, table); assert.equal(entityListSource(key)?.customFieldTable, table); }
  assert.deepEqual([entityListSource("fund")?.drawerParam, entityListSource("fund_release")?.basePath], ["fund", "/nonprofit/releases"]);
});
