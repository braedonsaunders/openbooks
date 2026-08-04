import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("organization defaults are installed by explicit setup commands", () => {
  const bootstrap = read("scripts/bootstrap.ts");
  const features = read("web/app/api/admin/setup/features/route.ts");
  const provisioner = read("engine/src/organization-provisioning.ts");

  assert.match(bootstrap, /await provisionOrganizationDefaults\(orgId\)/);
  assert.match(features, /await provisionFeatureDefaults\(orgId, gate\.user\.id, key\)/);
  assert.match(provisioner, /ensureCustomizationDefaults/);
  assert.match(provisioner, /ensureBuiltInPaymentFormats/);
  assert.match(provisioner, /ensureCrmDefaults/);
  assert.match(provisioner, /seedProjectTypes/);
  assert.match(provisioner, /ensureCloseDefaults/);
});

test("record and setup page renders never provision tenant data", () => {
  const readOnlyFiles = [
    "web/lib/customization/resolve.ts",
    "web/app/(app)/admin/customization/page.tsx",
    "web/app/(app)/admin/setup/project-types/page.tsx",
    "web/app/(app)/admin/setup/payment-operations/page.tsx",
    "web/app/(app)/admin/setup/crm/page.tsx",
    "web/app/(app)/admin/setup/[entity]/CloseSetupPage.tsx",
    "web/app/(app)/close/page.tsx",
  ];
  for (const path of readOnlyFiles) {
    assert.doesNotMatch(
      read(path),
      /ensure(?:CustomizationDefaults|BuiltInPaymentFormats|CrmDefaults|CloseDefaults)|seedProjectTypes|refreshCloseRun/,
      path,
    );
  }
});

test("GET setup handlers are read-only while write handlers may provision", () => {
  for (const path of [
    "web/app/api/crm/setup/route.ts",
    "web/app/api/admin/payment-operations/[resource]/route.ts",
  ]) {
    const source = read(path);
    const getStart = source.indexOf("export async function GET");
    const writeStart = source.indexOf("export async function POST");
    assert.ok(getStart >= 0 && writeStart > getStart, path);
    assert.doesNotMatch(
      source.slice(getStart, writeStart),
      /ensure(?:BuiltInPaymentFormats|CrmDefaults)/,
      path,
    );
  }
});
