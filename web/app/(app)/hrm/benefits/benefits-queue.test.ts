import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Shared-table composition contract for the Benefits tab (/hrm/benefits).
// Runs without dependencies: it reads the maintained sources and proves the
// windows and enrolments render through the shared table block (variant
// 'app') over loader-resolved display cells, segments ride the shared
// filter chips, the primary action is the shared link-button FIRST in the
// page header, and the drawer/dialog open from URL params — with every
// label from the hrm catalog.
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const dialog = readFileSync(new URL("./WindowDialog.tsx", import.meta.url), "utf8");
const drawer = readFileSync(new URL("./WindowDrawer.tsx", import.meta.url), "utf8");
const actions = readFileSync(new URL("./EnrollmentRowActions.tsx", import.meta.url), "utf8");
const loader = readFileSync(new URL("../../../../lib/hrm/benefits.ts", import.meta.url), "utf8");
const widgets = readFileSync(new URL("../../../../components/viewspec/widgets-hrm.tsx", import.meta.url), "utf8");
const contracts = readFileSync(new URL("../../../../components/viewspec/widget-contracts.ts", import.meta.url), "utf8");
const names = readFileSync(new URL("../../../../components/viewspec/registry-names.ts", import.meta.url), "utf8");
const strings = readFileSync(new URL("../../../../messages/en/hrm.json", import.meta.url), "utf8");

test("benefits renders through ModuleView with a loader-owned spec", () => {
  assert.match(page, /<ModuleView/, "page renders through the shared ModuleView host");
  assert.match(page, /loadBenefitsPage/, "page loads through the benefits loader");
  assert.match(view, /benefitsSpec/, "view exposes the spec builder");
  assert.match(view, /module-home-tabs/, "header carries the route-tab strip");
});

test("benefits rows render through the shared table block, not a bespoke table", () => {
  assert.match(view, /table\(\{/, "rows compose a table block");
  assert.match(view, /variant: 'app'/, "the table uses the app list variant");
  assert.ok(!/<table/.test(view), "the spec holds no hand-rolled table");
  assert.ok(!/<table/.test(dialog), "the dialog island holds no hand-rolled table");
  assert.ok(!/<table/.test(drawer), "the drawer island holds no hand-rolled table");
});

test("benefits segments ride the shared filter chips", () => {
  assert.match(view, /filter-chips/, "segments ride the shared filter chips");
  assert.match(view, /paramKey: 'segment'/, "segments filter on the segment search param");
});

test("the primary action is the shared link-button first in the page header", () => {
  const headerStart = view.indexOf("pageHeader({");
  const header = view.slice(headerStart, view.indexOf("module-home-tabs", headerStart));
  assert.match(header, /link-button/, "the New window button is a link-button widget");
  assert.match(header, /f\('newWindowHref'\)/, "it navigates to a loader-built href");
  assert.match(header, /f\('canManage'\)/, "it renders only with the manage grant");
  assert.ok(view.indexOf("'link-button'") < view.indexOf("'module-home-tabs'"), "the button precedes the tabs strip");
});

test("cells compose the shared primitives over loader-resolved display fields", () => {
  assert.match(view, /link\(item\('name'\), item\('windowHref'\)\)/, "window opens the drawer href");
  assert.match(view, /badge\(item\('statusLabel'\), \{ variant: item\('statusVariant'\) \}\)/, "status rides the shared badge");
  assert.match(view, /widgetCell\('hrm-enrollment-actions'/, "pending rows carry the approve island");
  assert.match(view, /align: 'right'/, "amounts align right");
  assert.match(loader, /windowHref/, "the loader builds the window drawer href");
  assert.match(loader, /statusVariant/, "the loader resolves the badge variant");
  assert.match(loader, /employeeHref/, "the loader builds the employee href");
});

test("dialog, drawer, and approve island open from URL params through shared UI", () => {
  assert.match(view, /hrm-window-dialog/, "the new-window dialog is a widget");
  assert.match(view, /hrm-window-drawer/, "the window drawer is a widget");
  assert.match(dialog, /from '@openbooks\/ui'/, "the dialog uses the shared UI primitives");
  assert.match(drawer, /from '@openbooks\/ui'/, "the drawer uses the shared UI primitives");
  assert.match(actions, /pending_approval/, "the island renders only for pending rows");
  assert.match(actions, /router\.refresh\(\)/, "the island refreshes the loader-resolved list");
  assert.match(widgets, /hrm-window-dialog/, "the dialog is registered in the HRM widget family");
  assert.match(widgets, /hrm-window-drawer/, "the drawer is registered in the HRM widget family");
  assert.match(widgets, /hrm-enrollment-actions/, "the approve island is registered in the HRM widget family");
  assert.match(contracts, /hrm-window-dialog/, "widget contracts cover the dialog");
  assert.match(contracts, /hrm-window-drawer/, "widget contracts cover the drawer");
  assert.match(contracts, /hrm-enrollment-actions/, "widget contracts cover the island");
  assert.match(names, /hrm-window-dialog/, "registry names cover the dialog");
  assert.match(names, /hrm-window-drawer/, "registry names cover the drawer");
  assert.match(names, /hrm-enrollment-actions/, "registry names cover the island");
});

test("every benefits label resolves from the hrm catalog", () => {
  const catalog = JSON.parse(strings) as { benefits: Record<string, unknown> };
  for (const key of ["title", "windowsTitle", "enrolmentsTitle", "newWindow", "approve", "segmentsLabel", "allLabel"]) {
    assert.ok(catalog.benefits[key] !== undefined, `benefits.${key} is catalogued`);
  }
  const columns = catalog.benefits.columns as Record<string, unknown>;
  for (const key of ["window", "kind", "range", "elections", "pending", "status", "employee", "plan", "coverage"]) {
    assert.ok(columns[key] !== undefined, `benefits.columns.${key} is catalogued`);
  }
});
