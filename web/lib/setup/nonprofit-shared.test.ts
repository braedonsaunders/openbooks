import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { BUILT_IN_ROLES, PERMISSION_CATALOGUE, PERMISSION_GROUPS, permissionLabelKey, permissionSetCovers } from "@openbooks/engine/src/organization/permissions.ts";
import { getRecordType, type FilterClause } from "@openbooks/customization";
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
  for (const [key, feature, table] of [["fund", "fundAccounting", "funds"], ["fund_release", "fundAccounting", "fund_releases"], ["grant", "grantManagement", "grants"], ["encumbrance", "encumbrances", "encumbrances"]] as const) {
    const meta = getRecordType(key), source = entityListSource(key);
    assert.deepEqual([meta?.featureKey, meta?.customFieldTable, source?.customFieldTable], [feature, table, table]);
  }
  const view = { filters: [] } as never, adhoc = { filters: {} } as never;
  assert.throws(() => entityListSource("grant")!.where(view, adhoc, "org", new Set(["restricted"])), /unrestricted subsidiary access/);
  const subsidiary = "00000000-0000-4000-8000-000000000001", dialect = new PgDialect(), encumbrance = entityListSource("encumbrance")!, query = (scope: Set<string> | null | undefined) => dialect.sqlToQuery(encumbrance.where(view, adhoc, "org", scope));
  assert.deepEqual([query(new Set([subsidiary])).sql.includes("subsidiary_id"), query(new Set([subsidiary])).params.includes(`{${subsidiary}}`)], [true, true]);
  assert.match(query(new Set()).sql, /and false/);
  assert.doesNotMatch(query(null).sql, /subsidiary_id/);
  assert.deepEqual([entityListSource("fund")?.drawerParam, entityListSource("fund_release")?.basePath], ["fund", "/nonprofit/releases"]);
});

test("nonprofit status filters bind declared values and fail closed", () => {
  const compile = (recordType: "grant" | "encumbrance", filter: FilterClause) =>
    new PgDialect().sqlToQuery(entityListSource(recordType)!.where({ filters: [filter] } as never, { filters: {} } as never, "org", null));
  for (const [recordType, first, second, unsupportedKey, statusExpr] of [
    ["grant", "draft", "active", "name", "g\\.status"],
    ["encumbrance", "open", "closed", "number", "e\\.status"],
  ] as const) {
    const cases: Array<[FilterClause, RegExp, string[]]> = [
      [{ key: "status", operator: "eq", value: first }, new RegExp(`${statusExpr} = `), [first]],
      [{ key: "status", operator: "ne", value: first }, new RegExp(`${statusExpr} <> `), [first]],
      [{ key: "status", operator: "in", value: [first, second] }, new RegExp(`${statusExpr} in \\(`), [first, second]],
      [{ key: "status", operator: "not_in", value: [first, second] }, new RegExp(`${statusExpr} not in \\(`), [first, second]],
      [{ key: "status", operator: "in", value: [] }, /and false/, []],
      [{ key: "status", operator: "not_in", value: [] }, /and true/, []],
      [{ key: "status", operator: "eq", value: "invalid" }, /and false/, []],
      [{ key: "status", operator: "contains", value: first }, /and false/, []],
    ];
    for (const [filter, pattern, expectedParams] of cases) {
      const query = compile(recordType, filter);
      assert.deepEqual([pattern.test(query.sql), query.params.slice(1)], [true, expectedParams], `${recordType} ${filter.key} ${filter.operator} ${JSON.stringify(filter.value)}`);
    }
    const unsupported = compile(recordType, { key: unsupportedKey, operator: "eq", value: first });
    assert.deepEqual([/and false/.test(unsupported.sql), unsupported.params.slice(1)], [true, []], `${recordType} unsupported ${unsupportedKey}`);
  }
});
