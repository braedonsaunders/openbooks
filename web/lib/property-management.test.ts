import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readingPagePairs } from './page-source'
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readingPagePairs((path: string) => readFileSync(join(webRoot, path), "utf8"));
const propertyMessages = (
  JSON.parse(source("messages/en/entities.json")) as {
    propertyManagement: Record<string, unknown>;
  }
).propertyManagement;
const propertyMessage = (path: string): unknown =>
  path.split(".").reduce<unknown>(
    (node, segment) =>
      node && typeof node === "object"
        ? (node as Record<string, unknown>)[segment]
        : undefined,
    propertyMessages,
  );
const pmSource = (...names: string[]) =>
  names
    .map((name) => source(`app/(app)/property-management/${name}`))
    .join("\n");

test("property-management workspace keeps exactly four KPIs in one desktop row", () => {
  const workspace = pmSource(
    "PropertyManagementWorkspace.tsx",
    "workspace-ui.tsx",
  );
  const healthStart = workspace.indexOf('aria-label={t("healthAria")}');
  const health = workspace.slice(
    healthStart,
    workspace.indexOf("</section>", healthStart),
  );

  assert.notEqual(healthStart, -1);
  assert.equal(propertyMessage("workspace.healthAria"), "Property health");
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
  // PM2: past-due groups the complete per-lease server aggregate by currency,
  // never the capped schedule preview.
  assert.match(workspace, /const overdue = sumByCurrency\(\s*data\.overdueByLease\.map/);
  assert.doesNotMatch(workspace, /overdueInvoices = new Map/);
  assert.doesNotMatch(health, /xl:grid-cols/);
});
