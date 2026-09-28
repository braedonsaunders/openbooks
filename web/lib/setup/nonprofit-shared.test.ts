import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { BUILT_IN_ROLES, PERMISSION_CATALOGUE, PERMISSION_GROUPS, permissionLabelKey, permissionSetCovers } from "@openbooks/engine/src/organization/permissions.ts";
import { getRecordType } from "@openbooks/customization";
import { entityListSource } from "../list/entity-sources.ts";
// Shared fund registry properties — catalogue, labels, storage, sources.
test("fund, grant, and encumbrance permissions are catalogued, grouped, granted least-privilege, and labelled", () => {
  assert.deepEqual(PERMISSION_GROUPS.find((e) => e.key === "nonprofit")?.permissions.map((e) => e.key), ["nonprofit.report", "funds.read", "funds.manage", "grants.read", "grants.manage", "encumbrances.read", "encumbrances.manage"]);
  for (const k of ["funds.read", "funds.manage", "grants.read", "grants.manage", "encumbrances.read", "encumbrances.manage"]) assert.ok((PERMISSION_CATALOGUE as readonly string[]).includes(k));
  for (const [k, l] of [["funds.read", "permissions.funds_read"], ["grants.read", "permissions.grants_read"], ["grants.manage", "permissions.grants_manage"], ["encumbrances.read", "permissions.encumbrances_read"], ["encumbrances.manage", "permissions.encumbrances_manage"]] as [never, string][]) assert.equal(permissionLabelKey(k), l);
  const holds = (r: string, p: string) => permissionSetCovers(new Set(BUILT_IN_ROLES[r]!.permissions), p);
  for (const [r, p, w] of [["controller", "funds.manage", 1], ["accountant", "funds.manage", 0], ["accountant", "funds.read", 1], ["approver", "funds.read", 1], ["viewer", "funds.read", 1], ["viewer", "funds.manage", 0]] as [string, string, number][]) assert.equal(holds(r, p), Boolean(w), `${r} ${p}`);
  const granted: Record<string, readonly string[]> = { admin: ["grants.read", "grants.manage", "encumbrances.read", "encumbrances.manage"], controller: ["grants.read", "grants.manage", "encumbrances.read", "encumbrances.manage"], accountant: ["grants.read", "encumbrances.read", "encumbrances.manage"], approver: ["grants.read", "encumbrances.read"], viewer: ["grants.read", "encumbrances.read"], sales_manager: [], sales_rep: [] };
  for (const r of Object.keys(granted)) for (const p of ["grants.read", "grants.manage", "encumbrances.read", "encumbrances.manage"]) assert.equal(holds(r, p), granted[r]!.includes(p), `${r} ${p}`);
  const dir = join(import.meta.dirname, "..", "..", "messages");
  const missing = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).filter((l) => ["funds_read", "funds_manage", "grants_read", "grants_manage", "encumbrances_read", "encumbrances_manage"].some((k) => typeof (JSON.parse(readFileSync(join(dir, l, "admin.json"), "utf8")) as { permissions?: Record<string, string> }).permissions?.[k] !== "string"));
  assert.deepEqual(missing, []);
  for (const [key, table] of [["fund", "funds"], ["fund_release", "fund_releases"]]) { assert.equal(getRecordType(key)?.featureKey, "fundAccounting"); assert.equal(getRecordType(key)?.customFieldTable, table); assert.equal(entityListSource(key)?.customFieldTable, table); }
  assert.deepEqual([entityListSource("fund")?.drawerParam, entityListSource("fund_release")?.basePath], ["fund", "/nonprofit/releases"]);
});
