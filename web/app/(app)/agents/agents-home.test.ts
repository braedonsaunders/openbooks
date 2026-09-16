import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const view = read("./view.ts");
const page = read("./page.tsx");
const layout = read("./layout.tsx");
const island = read("./AgentsTriage.tsx");
const ccPage = read("../continuous-close/page.tsx");
const nav = read("../../../../engine/src/modules/nav-registry.ts");

// The workbench home is one ranked inbox across every readable pack — the
// loadAgentInbox resolver the JSON feed also serves, never a second query.
test("agents home loads through the shared inbox resolver", () => {
  assert.match(view, /route: '\/agents'/);
  assert.match(view, /requirePermission\('assistant\.use'\)/);
  assert.match(view, /loadAgentInbox\(authz,/);
  assert.match(view, /widgetBlock\('agents-triage'/);
  assert.match(view, /widgetBlock\('work-item-drawer'/);
  assert.match(view, /findingProposalCommand\(authz, selected\.summary\)/);
  assert.match(view, /findingSummaryLine\(/);
  assert.match(layout, /requireFeatureEnabled\(authz\.user\.orgId, 'continuousClose'\)/);
  assert.match(page, /loadAgents\(sp\)/);
  assert.match(page, /agentsSpec\(data\)/);
});

// The proposals lane resolves viewer-signed commands up front and renders
// the chat's review card inline; unresolvable carriers stay visible with a
// note instead of a dead Apply.
test("proposals lane renders governed cards", () => {
  assert.match(view, /widgetBlock\('tab-nav'/);
  assert.match(view, /findingProposalCommand\(authz, row\.summary\)/);
  assert.match(view, /widgetBlock\('proposal-lane-card'/);
  assert.match(view, /when: f\('showLane'\)/);
  assert.match(view, /when: f\('laneEmpty'\)/);
});

// /continuous-close redirects to the workbench, preserving finding deep
// links; only its reports tab stays until the briefing moves it.
test("continuous-close redirects to the workbench except reports", () => {
  assert.match(ccPage, /redirect\(`\/agents\$\{query \? `\?\$\{query\}` : ''\}`\)/);
  assert.match(ccPage, /params\.set\('item', itemValue\)/);
  assert.match(ccPage, /tabValue !== 'reports'/);
});

// The nav entry becomes Agents (key unchanged — tenant configs reference it).
test("nav points at the workbench", () => {
  assert.match(nav, /href: '\/agents'/);
  assert.match(nav, /label: 'Agents'/);
  assert.match(nav, /key: 'continuous-close'/);
});

// Triage uses the same PATCH transitions as the drawer and never invents a
// write path; snooze parks In review (there is no time-based snooze state).
test("triage island reuses governed transitions", () => {
  assert.match(island, /\/api\/continuous-close\/items\/\$\{id\}/);
  assert.match(island, /method: 'PATCH'/);
  assert.match(island, /router\.refresh\(\)/);
  assert.match(island, /mutate\(row\.id, 'review'\)/);
  assert.doesNotMatch(island, /snoozed_until|dismissed_at/);
  assert.match(island, /\/api\/agents\/inbox\?since=/);
});
