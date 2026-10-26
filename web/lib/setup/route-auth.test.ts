import assert from "node:assert/strict";
import test from "node:test";
import { setupEntityRoutePermission } from "./route-auth.ts";

test("CRM setup CRUD keeps its module permission limited to its three registered lists", () => {
  assert.equal(setupEntityRoutePermission("crm-account-statuses"), "crm.setup.manage");
  assert.equal(setupEntityRoutePermission("crm-opportunity-statuses"), "crm.setup.manage");
  assert.equal(setupEntityRoutePermission("crm-lead-sources"), "crm.setup.manage");
  assert.equal(setupEntityRoutePermission("tax-codes"), "admin.setup.manage");
  assert.equal(setupEntityRoutePermission(undefined), "admin.setup.manage");
});
