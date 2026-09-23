import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const source = read("./tools-property.ts");

/**
 * Source contract for the property-management assistant tools: every tool
 * carries the `ar.read` gate its route enforces and the `propertyManagement`
 * feature declaration, reads through the shared workspace loader, reuses the
 * rent-roll screen's monthly-charge predicate, and reads arrears from the
 * server-side past-due aggregate over all posted documents — never the
 * capped schedule preview. No property tool writes.
 */
test("property tools declare the right gates and features", () => {
  for (const tool of [
    "list_properties",
    "list_leases",
    "get_lease",
    "rent_roll",
    "lease_arrears",
    "property_deposits",
  ]) {
    const start = source.indexOf(`name: "${tool}"`);
    assert.ok(start >= 0, `${tool} is registered`);
    const window = source.slice(start, start + 600);
    assert.ok(window.includes('"ar.read"'), `${tool} gates on ar.read`);
    assert.ok(window.includes('feature: "propertyManagement"'), `${tool} declares the propertyManagement feature`);
  }
  assert.doesNotMatch(source, /category: "write"/, "property tools are read-only");
});

test("property reads reuse the engine workspace and deposit loaders", () => {
  assert.match(source, /propertyManagementWorkspace\(orgId, asOf\)/);
  assert.match(source, /securityDepositReconciliation\(authz\.user\.orgId, a\.asOf\)/);
  assert.match(source, /allowed\.has\(String\(row\.subsidiaryId\)\)/);
  assert.match(source, /propertyIds\.has\(String\(row\.propertyId\)\)/);
});

test("rent-roll figures mirror the screen predicates with engine decimal math", () => {
  assert.match(source, /charge\.frequency === "monthly"/);
  assert.match(source, /from "@openbooks\/engine\/src\/money\/money\.ts"/);
  assert.match(source, /propertyManagement_feature_disabled/);
  assert.match(source, /lease_not_found/);
});

test("arrears read the server past-due aggregate, never the capped preview", () => {
  assert.match(source, /pastDueFor\(workspace\.overdueByLease/);
  assert.match(source, /pastDueInvoices\(workspace\.overdueInvoices/);
  assert.doesNotMatch(source, /pastDueFor\(workspace\.schedules/);
  assert.doesNotMatch(source, /pastDueInvoices\(workspace\.schedules/);
  assert.doesNotMatch(source, /line\.invoiceStatus === "posted"/);
});

test("property tools are exported and registered for the playbook", () => {
  assert.match(source, /export const PROPERTY_TOOLS: AssistantToolDef\[\]/);
  assert.ok(source.includes("propertyDeposits,\n];"));
});
