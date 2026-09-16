import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const ops = read("./tools-ops.ts");
const resourcesRoute = read("../../app/api/data/resources/route.ts");
const importRoute = read("../../app/api/data/import/route.ts");
const historyView = read("../../app/(app)/data/import/history/view.ts");
const connectionsRoute = read("../../app/api/platform/connections/route.ts");
const sandboxesView = read("../../app/(app)/admin/sandboxes/view.ts");

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

test("list_sync_connections carries the console's gate and never leaks credential blobs", () => {
  // GET /api/platform/connections requires admin.setup.manage and strips the
  // sealed secrets blob via toClient. The tool must equal that gate and
  // expose only the presence bit.
  assert.match(connectionsRoute, /guardPermission\("admin\.setup\.manage"\)/);
  assert.match(ops, /name: "list_sync_connections"[\s\S]{0,800}gate: \{ mode: "anyOf", perms: \["admin\.setup\.manage"\] \}/);
  assert.match(ops, /listConnections\(authz\.user\.orgId\)/);
  assert.match(ops, /from sync_runs where org_id/);
  assert.match(ops, /hasSecrets: c\.secrets !== null/);
  assert.doesNotMatch(ops, /secrets: c\.secrets/);
});

test("list_environments carries the admin page's gate and production-org scoping", () => {
  // loadSandboxes requires admin.sandboxes.manage and lists by
  // productionOrgId. The tool must do the same — no subsidiary fence, no
  // wider gate.
  assert.match(sandboxesView, /requirePermission\('admin\.sandboxes\.manage'\)/);
  assert.match(sandboxesView, /listSandboxes\(authz\.user\.productionOrgId\)/);
  assert.match(ops, /name: "list_environments"[\s\S]{0,800}gate: \{ mode: "anyOf", perms: \["admin\.sandboxes\.manage"\] \}/);
  assert.match(ops, /listSandboxes\(authz\.user\.productionOrgId\)/);
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
