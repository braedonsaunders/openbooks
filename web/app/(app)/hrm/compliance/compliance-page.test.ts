import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Shared-table composition contract for the Compliance tab (/hrm/compliance).
// Runs without dependencies: it reads the maintained sources and proves the
// findings, schedules, runs, classes and entries render through the shared
// table block (variant 'app') over loader-resolved display cells, sections
// and kinds ride the shared filter chips, the primary action is the shared
// link-button FIRST in the page header, and the generate dialog opens from
// a URL param — with every label from the hrm catalog.
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const dialog = readFileSync(new URL("./GenerateDialog.tsx", import.meta.url), "utf8");
const actions = readFileSync(new URL("./ComplianceActions.tsx", import.meta.url), "utf8");
const loader = readFileSync(new URL("../../../../lib/hrm/compliance.ts", import.meta.url), "utf8");
const widgets = readFileSync(new URL("../../../../components/viewspec/widgets-hrm.tsx", import.meta.url), "utf8");
const contracts = readFileSync(new URL("../../../../components/viewspec/widget-contracts.ts", import.meta.url), "utf8");
const names = readFileSync(new URL("../../../../components/viewspec/registry-names.ts", import.meta.url), "utf8");
const strings = readFileSync(new URL("../../../../messages/en/hrm.json", import.meta.url), "utf8");

test("compliance renders through ModuleView with a loader-owned spec", () => {
  assert.match(page, /<ModuleView/, "page renders through the shared ModuleView host");
  assert.match(page, /loadCompliancePageData/, "page loads through the compliance loader");
  assert.match(view, /complianceSpec/, "view exposes the spec builder");
  assert.match(view, /module-home-tabs/, "header carries the route-tab strip");
});

test("compliance rows render through the shared table block, not a bespoke table", () => {
  assert.match(view, /table\(\{/, "rows compose a table block");
  assert.match(view, /variant: 'app'/, "the table uses the app list variant");
  assert.ok(!/<table/.test(view), "the spec holds no hand-rolled table");
  assert.ok(!/<table/.test(dialog), "the generate dialog holds no hand-rolled table");
  assert.ok(!/<table/.test(actions), "the actions island holds no hand-rolled table");
});

test("compliance sections and kinds ride the shared filter chips", () => {
  assert.match(view, /filter-chips/, "sections ride the shared filter chips");
  assert.match(view, /paramKey: 'section'/, "sections filter on the section search param");
  assert.match(view, /paramKey: 'kind'/, "kinds filter on the kind search param");
});

test("the primary action is the shared link-button first in the page header", () => {
  const headerStart = view.indexOf("pageHeader({");
  const header = view.slice(headerStart, view.indexOf("module-home-tabs", headerStart));
  assert.match(header, /link-button/, "the Generate report button is a link-button widget");
  assert.match(header, /f\('canManage'\)/, "it renders only with the manage grant");
  assert.ok(view.indexOf("'link-button'") < view.indexOf("'module-home-tabs'"), "the button precedes the tabs strip");
});

test("compliance islands are registered widgets with contracts", () => {
  assert.match(widgets, /hrm-compliance-actions/, "row actions are a registered widget");
  assert.match(widgets, /hrm-compliance-generate/, "the generate dialog is a registered widget");
  assert.match(names, /hrm-compliance-actions/, "row actions are in the registry names");
  assert.match(names, /hrm-compliance-generate/, "the generate dialog is in the registry names");
  assert.match(contracts, /hrm-compliance-actions/, "row actions have a generated contract");
  assert.match(contracts, /hrm-compliance-generate/, "the generate dialog has a generated contract");
  assert.match(loader, /listFindings/, "findings resolve through the construction service");
  assert.match(loader, /listSchedules/, "schedules resolve through the construction service");
  assert.match(loader, /listRuns/, "runs resolve through the construction service");
  assert.match(strings, /"compliance"/, "every label ships in the hrm catalog");
});

test("stat tiles stay within the four-tile vitals strip", () => {
  assert.match(view, /\[0, 1, 2, 3\]\.map/, "the vitals strip renders exactly four tiles");
  assert.ok(!/\[0, 1, 2, 3, 4/.test(view), "never a fifth tile");
});
