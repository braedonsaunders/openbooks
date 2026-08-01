import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = (path: string) => readFileSync(join(webRoot, path), "utf8");

test("property-management page is feature gated and subsidiary scoped", () => {
  const page = source("app/(app)/property-management/page.tsx");

  assert.match(page, /requirePermission\("ar\.read"\)/);
  assert.match(page, /requirePropertyManagementFeature/);
  assert.match(page, /authz\.allowedSubsidiaryIds/);
  assert.match(page, /manage: can\(authz, "ar\.create"\)/);
  assert.match(page, /bill: can\(authz, "ar\.create"\)/);
  assert.match(page, /account: can\(authz, "gl\.post"\)/);
});

test("property-management API gates reads, accounting effects, and subsidiary records", () => {
  const route = source("app/api/property-management/route.ts");
  const gate = source("lib/property-management-gate.ts");

  assert.match(route, /guardPermission\("ar\.read"\)/);
  assert.match(route, /guardPropertyManagementFeature/);
  assert.match(
    route,
    /const glActions = new Set\(\["recordDeposit", "finalizeCam"\]\)/,
  );
  assert.match(route, /guardSubsidiaryAccess/);
  assert.match(
    route,
    /Bulk portfolio billing requires unrestricted subsidiary access/,
  );
  assert.match(route, /workspace\.properties\.filter/);
  assert.match(gate, /isFeatureEnabled\(orgId, "propertyManagement"\)/);
});

test("property-management workspace keeps exactly four KPIs in one desktop row", () => {
  const workspace = source(
    "app/(app)/property-management/PropertyManagementWorkspace.tsx",
  );
  const healthStart = workspace.indexOf('aria-label="Property health"');
  const health = workspace.slice(
    healthStart,
    workspace.indexOf("</section>", healthStart),
  );

  assert.notEqual(healthStart, -1);
  assert.match(health, /lg:grid-cols-4/);
  assert.equal((health.match(/<Metric\b/g) ?? []).length, 4);
  assert.match(workspace, /min-w-0 overflow-hidden/);
  assert.match(workspace, /className="flex min-w-0 overflow-x-auto"/);
  assert.match(workspace, /charge\.effectiveFrom <= today/);
  assert.match(workspace, /overdueInvoices = new Map/);
  assert.match(workspace, /line\.invoiceStatus === "posted"/);
  assert.doesNotMatch(health, /xl:grid-cols/);
});

test("property-management UI exposes the complete operator entry points", () => {
  const workspace = source(
    "app/(app)/property-management/PropertyManagementWorkspace.tsx",
  );

  for (const label of [
    "New property",
    "Add unit",
    "New lease",
    "Bill due rent",
    "Assess late fees",
    "Record deposit transaction",
    "New CAM pool",
    "Create true-ups",
  ]) {
    assert.match(workspace, new RegExp(label));
  }
  assert.match(workspace, /aria-label="Property management sections"/);
  assert.match(workspace, /aria-label="Lease details"/);
  assert.match(workspace, /onKeyDown=\{\(event\)/);
  assert.doesNotMatch(workspace, /window\.prompt/);
});
