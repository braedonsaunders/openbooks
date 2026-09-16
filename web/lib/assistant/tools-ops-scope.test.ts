import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const ops = read("./tools-ops.ts");
const resourcesRoute = read("../../app/api/data/resources/route.ts");
const importRoute = read("../../app/api/data/import/route.ts");
const historyView = read("../../app/(app)/data/import/history/view.ts");

test("data-io tools carry the same gates as the routes and views they cover", () => {
  // GET /api/data/resources requires data.export; the import route and the
  // import history view require data.import. The tools must equal those
  // gates, not widen them.
  assert.match(resourcesRoute, /guardPermission\('data\.export'\)/);
  assert.match(importRoute, /guardPermission\('data\.import'\)/);
  assert.match(historyView, /requirePermission\('data\.import'\)/);
  assert.match(ops, /name: "list_data_resources"[\s\S]{0,800}gate: \{ mode: "anyOf", perms: \["data\.export"\] \}/);
  assert.match(ops, /name: "list_import_runs"[\s\S]{0,800}gate: \{ mode: "anyOf", perms: \["data\.import"\] \}/);
});

test("list_data_resources reuses the registry and filters by the caller's read permission", () => {
  // Same two calls as GET /api/data/resources: listResources, then a per-
  // descriptor can() on its readPermission. No rows are read, so there is no
  // subsidiary fence to bind — descriptors carry no tenant rows.
  assert.match(ops, /listResources\(authz\.user\.orgId\)/);
  assert.match(ops, /can\(authz, d\.readPermission\)/);
});

test("list_import_runs reuses the history view's query shape and stays org-scoped", () => {
  assert.match(ops, /from import_jobs j/);
  assert.match(ops, /j\.org_id =/);
  assert.match(ops, /left join users u on u\.id = j\.created_by/);
  // Error payloads stay server-side apart from the first array element,
  // truncated to 300 chars by firstErrorText.
  assert.match(ops, /j\.errors->0/);
  assert.doesNotMatch(ops, /select j\.errors[,\s]/);
  assert.match(ops, /firstError/);
});
