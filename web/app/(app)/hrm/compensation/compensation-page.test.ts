import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * Contract coverage for /hrm/compensation without booting Next: source
 * assertions over the page shells (gate placement, metadata,
 * search-params passthrough) and the loader/spec split between the
 * views and the shared drawer/widget components.
 */

const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const sections = readFileSync(new URL("./sections.tsx", import.meta.url), "utf8");
const islands = readFileSync(new URL("./islands.tsx", import.meta.url), "utf8");
const loader = readFileSync(new URL("../../../../lib/hrm/compensation.ts", import.meta.url), "utf8");

test("compensation pages carry the gates where the route-gate scanner reads them", () => {
  assert.match(loader, /requireFeatureEnabled\(authz\.user\.orgId, 'hrmCompensation'\)/, "the home loader redirects to the feature remedy when hrmCompensation is off");
  assert.match(loader, /requireFeatureEnabled\(authz\.user\.orgId, 'hrmMeritCycles'\)/, "the cycle loader redirects to the feature remedy when hrmMeritCycles is off");
  assert.match(loader, /requireFeatureEnabled\(authz\.user\.orgId, 'hrmHeadcountPlans'\)/, "the plan loader redirects to the feature remedy when hrmHeadcountPlans is off");
  assert.match(loader, /requireFeatureEnabled\(authz\.user\.orgId, 'hrmPayTransparency'\)/, "the equity loader redirects to the feature remedy when hrmPayTransparency is off");
  assert.match(loader, /can\(authz, 'hrm\.compensation\.read'\)/, "readers carry the compensation read grant");
  assert.match(loader, /can\(authz, 'hrm\.compensation\.manage'\)/, "writers carry the compensation manage grant");
  assert.match(loader, /can\(authz, 'hrm\.compensation\.approve'\)/, "deciders carry the compensation approve grant");
  assert.match(loader, /hrmRewardsViewTabs/, "Compensation rides the Rewards viewTabs so Benefits stays one hop away");
  assert.match(page, /loadCompensationPage\(sp\)/, "the page hands its query string to the loader, so ?plan=new / ?cycle=new resolve to dialogs");
  assert.match(page, /searchParams=\{sp\}/, "the query string reaches the loader and the spec host");
  assert.match(page, /trusted \/>/, "the view spec is trusted output, never raw user input");
  assert.match(page, /generateMetadata/, "tab metadata resolves the translated title");
});

test("compensation home composes shared primitives: tiles, tables, setup sections", () => {
  assert.match(view, /route: '\/hrm\/compensation'/, "the spec names its own route for the registry");
  assert.match(view, /statTile\(\{/, "the vitals strip renders through shared stat tiles");
  assert.match(view, /table\(\{/, "registers render through the shared table block");
  assert.match(view, /variant: 'app'/, "the lists use the shared app table primitives");
  assert.match(view, /badge\(item\('statusLabel'\)/, "status renders through the shared badge cell");
  assert.match(view, /link\(item\('name'\), item\('href'\)\)/, "rows open their detail through the row href");
  assert.match(view, /widgetBlock\('setup-section'/, "job architecture renders through the rehomed setup sections");
  assert.match(view, /entityKey: 'hrm-job-families'/, "families rehome onto the page");
  assert.match(view, /entityKey: 'hrm-job-levels'/, "levels rehome onto the page");
  assert.match(view, /entityKey: 'hrm-pay-bands'/, "bands rehome onto the page");
  assert.match(view, /module-home-tabs/, "the header carries the route-tab strip");
  assert.match(view, /link-button.*newCycleHref/s, "the primary action opens the cycle dialog first");
  assert.ok(!sections.includes('<table'), "no hand-rolled table remains in the compensation sections");
});

test("the team grid renders placement through the shared bar widget", () => {
  const cycleView = readFileSync(new URL("./cycles/[id]/view.ts", import.meta.url), "utf8");
  assert.match(cycleView, /table\(\{/, "the grid renders through the shared table block");
  assert.match(cycleView, /variant: 'app'/, "the grid uses the shared app table primitives");
  assert.match(cycleView, /widgetCell\('hrm-placement-bar'/, "placement renders through the shared bar cell");
  assert.match(cycleView, /widgetBlock\('hrm-pacing-bar'/, "pacing renders through the shared bar");
  assert.match(cycleView, /widgetBlock\('filter-chips'/, "departments filter through the shared chips");
  assert.match(cycleView, /widgetBlock\('hrm-comp-line-drawer'/, "the line drawer renders through the shared widget");
  assert.match(cycleView, /module-home-tabs/, "the header carries the route-tab strip");
});

test("equity renders frozen metrics as tiles with the per-category table", () => {
  const equityView = readFileSync(new URL("./equity/view.ts", import.meta.url), "utf8");
  assert.match(equityView, /statTile\(\{/, "the seven metrics render as shared stat tiles");
  assert.match(equityView, /table\(\{/, "categories render through the shared table block");
  assert.match(equityView, /variant: 'app'/, "the table uses the shared app table primitives");
});

test("client islands post through the shared action path with ok-first errors", () => {
  assert.match(islands, /\/api\/hrm\/comp-cycles/, "cycle actions ride the cycle routes");
  assert.match(islands, /\/api\/hrm\/headcount-plans/, "plan actions ride the plan routes");
  assert.match(islands, /\/api\/hrm\/pay-gap-snapshots/, "snapshot generation rides its route");
  assert.match(islands, /\/api\/hrm\/pay-information-requests/, "pay-information requests ride their route");
  // Mutations run on the shared action path (useAppAction + fetchAction):
  // fetchAction checks res.ok before trusting the body, so a refusal can
  // never become a parse error — pin the path, not a per-call check.
  assert.match(islands, /useAppAction/, "mutations run through the shared action hook");
  assert.match(islands, /fetchAction\(/, "mutations ride fetchAction, ok-first by construction");
  assert.match(islands, /onRefused/, "refusals render inline through the hook");
  assert.match(islands, /fallbackMessage/, "every action names its failure copy up front");
  assert.ok(!islands.includes('readApiErrorMessage'), "no hand-rolled error parsing beside the shared path");
  assert.ok(!islands.includes('<table'), "no hand-rolled table in the islands");
  assert.ok(!islands.includes('<button'), "actions render through the shared Button");
});
