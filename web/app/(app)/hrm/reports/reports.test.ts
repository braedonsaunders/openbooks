import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Native composition contract for the workforce reports launch pad
// (/hrm/reports). Runs without dependencies: it reads the maintained
// sources and proves the pad links the headcount statement preset and the
// workforce entities into the builder through the shared hub card —
// gated on the hrm switch plus the employment read grant and the reports
// grant the builder uses, every card behind the entity gate the run paths
// enforce.
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const loader = readFileSync(new URL("../../../../lib/hrm/reports.ts", import.meta.url), "utf8");
const strings = readFileSync(new URL("../../../../messages/en/hrm.json", import.meta.url), "utf8");

test("pad renders through ModuleView with a loader-owned spec", () => {
  assert.match(page, /<ModuleView/, "page renders through the shared ModuleView host");
  assert.match(page, /loadHrmReportsPage/, "page loads through the reports loader");
  assert.match(view, /hrmReportsSpec/, "view exposes the spec builder");
  assert.match(view, /module-home-tabs/, "header carries the route-tab strip");
  assert.match(view, /admin-hub-card/, "cards reuse the shared hub card, never a second card");
});

test("pad gates on the hrm switch plus the employment and reports grants", () => {
  assert.match(view, /requirePermission\('hrm\.employment\.read'\)/, "page requires the employment read grant");
  assert.match(view, /requirePermission\('reports\.read'\)/, "page requires the reports grant the builder uses");
  assert.match(view, /isFeatureEnabled\(authz\.user\.orgId, 'hrm'\)/, "page checks the Company Settings Features switch");
  assert.match(view, /notFound\(\)/, "a disabled switch 404s instead of rendering a gated pad");
  assert.match(loader, /loadHrmReports\(authz: Authz\)/, "loader takes the authorized session, never re-gates");
});

test("the preset resolves by slug and every card keeps the entity gate", () => {
  assert.match(loader, /headcount-statement/, "the headcount statement preset is the featured card");
  assert.match(loader, /from report_definitions/, "the preset links the org's own plan row by slug");
  assert.match(loader, /HRM_REPORT_ENTITIES/, "entity cards come from the workforce entity catalog");
  assert.match(loader, /canRunReportEntity/, "every card keeps the gate the run paths enforce");
  assert.match(loader, /\/reports\/custom/, "cards land in the report builder");
});

test("pad copy resolves from the hrm catalog, never inline English", () => {
  for (const key of [
    "title",
    "description",
    "presetTitle",
    "presetHint",
    "entitiesTitle",
    "entitiesHint",
    "hubTitle",
    "hubDescription",
  ]) {
    assert.ok(strings.includes(`"${key}"`), `en/hrm carries reports.${key}`);
  }
  assert.match(view, /f\('title'\)/, "spec titles resolve through view refs, never literals");
});
