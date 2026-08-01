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
    /const glActions = new Set\(\["recordDeposit", "reverseDeposit", "finalizeCam"\]\)/,
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
  assert.equal((workspace.match(/<HomeStatTile\b/g) ?? []).length, 1);
  assert.match(workspace, /icon="building"/);
  assert.match(workspace, /icon="badge-dollar"/);
  assert.match(workspace, /icon="circle-alert"/);
  assert.match(workspace, /icon="shield-check"/);
  assert.match(workspace, /min-w-0 overflow-hidden/);
  assert.match(
    workspace,
    /className="-mb-px flex min-w-0 gap-1 overflow-x-auto"/,
  );
  assert.match(
    workspace,
    /"border-b-2 px-3 py-3 text-sm font-medium transition-colors"/,
  );
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
    "Reopen for correction",
    "Deposit Reconciliation",
  ]) {
    assert.match(workspace, new RegExp(label));
  }
  assert.match(workspace, /aria-label="Property management sections"/);
  assert.match(workspace, /label="Lease details"/);
  assert.match(workspace, /key: "rentRoll", label: "Rent Roll"/);
  assert.match(workspace, /function RentRollTable/);
  assert.match(workspace, /Search rent roll/);
  assert.match(workspace, /Monthly charges/);
  assert.match(workspace, /Past due/);
  assert.match(workspace, /historical leases stay on/);
  assert.doesNotMatch(
    workspace,
    /\["properties", "leases", "rent", "deposits", "cam"\]/,
  );
  assert.match(workspace, /onKeyDown=\{\(event\)/);
  const propertiesTable = workspace.slice(
    workspace.indexOf("function PropertiesTable"),
  );
  assert.match(propertiesTable, /role="button"/);
  assert.match(propertiesTable, /onOpen\(property\.id\)/);
  assert.doesNotMatch(propertiesTable, /onAddUnit/);
  assert.match(workspace, /defaultFormLayout\("property"\)/);
  assert.match(workspace, /recordType=property&tab=forms/);
  assert.match(workspace, /<HeaderFields\s+layout=\{overviewLayout\}/);
  assert.match(workspace, /function UnitRecordDrawer/);
  assert.match(workspace, /action: "updateUnit"/);
  assert.match(workspace, /function LeaseRecordDrawer/);
  assert.match(workspace, /action: "updateLease"/);
  assert.match(workspace, /stacked=\{!!selectedProperty \|\| !!selectedUnit\}/);
  assert.match(workspace, /onClick=\{\(\) => onOpenUnit\(unit\.id\)\}/);
  assert.match(workspace, /propertyId: property\.id/);
  assert.match(workspace, /CAM reconciliations/);
  assert.match(workspace, /propertyId=\{property\.id\}/);
  assert.match(workspace, /initialPropertyId=\{createCam\?\.propertyId\}/);
  assert.match(workspace, /Deactivate property/);
  assert.match(workspace, /Reactivate property/);
  assert.match(workspace, /Delete property/);
  assert.match(workspace, /Take unit offline/);
  assert.match(workspace, /Delete unit/);
  assert.match(workspace, /Cancel lease/);
  assert.match(workspace, /Terminate lease/);
  assert.match(workspace, /Post reversal/);
  assert.match(workspace, /action: "reverseDeposit"/);
  assert.match(workspace, /action: "updateCamPool"/);
  assert.match(workspace, /action: "cancelCamPool"/);
  assert.match(workspace, /action: "reopenCamPool"/);
  assert.match(workspace, /function DepositReconciliationWorkspace/);
  assert.match(workspace, /deposit-reconciliation\?asOf=/);
  assert.doesNotMatch(workspace, /window\.prompt/);
});

test("property customization provisions form, view, and custom-field persistence", () => {
  const page = source("app/(app)/property-management/page.tsx");
  const route = source("app/api/property-management/route.ts");
  const schema = source("../schema/src/property-management.ts");

  assert.match(page, /recordType: "property"/);
  assert.match(page, /resolveFormLayout/);
  assert.match(page, /resolveListView/);
  assert.match(page, /loadFieldDefs\("managed_properties"\)/);
  assert.match(route, /case "updateProperty"/);
  assert.match(route, /case "updateUnit"/);
  assert.match(route, /case "updateLease"/);
  assert.match(route, /case "deleteProperty"/);
  assert.match(route, /case "deleteUnit"/);
  assert.match(route, /case "cancelLease"/);
  assert.match(route, /case "reverseDeposit"/);
  assert.match(route, /validateCustomValues/);
  assert.match(schema, /custom: jsonb\("custom"\)/);
  assert.match(schema, /reversalOfId: uuid\("reversal_of_id"\)/);
  assert.match(schema, /importKey: text\("import_key"\)/);
});

test("property migration uses the universal company import and export registry", () => {
  const resources = source("lib/data-io/resources.ts");
  const types = source("lib/data-io/types.ts");

  for (const key of [
    "properties",
    "property-units",
    "property-leases",
    "lease-charges",
    "security-deposit-opening-balances",
  ]) {
    assert.match(resources, new RegExp(`key: '${key}'`));
  }
  assert.match(resources, /propertyManagementEnabled/);
  assert.match(resources, /recordSecurityDeposit/);
  assert.match(resources, /importKey: externalKey/);
  assert.match(types, /'Property management'/);
});
