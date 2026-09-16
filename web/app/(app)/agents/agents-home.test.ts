import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const view = read("./view.ts");
const page = read("./page.tsx");
const layout = read("./layout.tsx");
const island = read("./AgentsTriageKeys.tsx");
const listSource = read("../../../lib/list/agent-findings.ts");
const ccPage = read("../continuous-close/page.tsx");
const nav = read("../../../../engine/src/modules/nav-registry.ts");

// The workbench home is one ranked inbox across every readable pack — the
// loadAgentInbox resolver the JSON feed also serves, never a second query.
// Every list param parses through the findings list source (c01).
test("agents home loads through the shared inbox resolver", () => {
  assert.match(view, /route: '\/agents'/);
  assert.match(view, /requirePermission\('assistant\.use'\)/);
  assert.match(view, /parseAgentFindingsParams\(sp\)/);
  assert.match(view, /loadAgentInbox\(authz, \{/);
  assert.match(view, /\.\.\.findings\.filters,/);
  assert.match(view, /widgetBlock\('agents-triage-keys'/);
  assert.doesNotMatch(view, /widgetBlock\('agents-triage',/);
  // The keyboard helper lives on the paging row with kbd-styled keys —
  // never loose text above the KPIs.
  assert.match(view, /widgetBlock\('agents-triage-hint', \{ text: data\.triageHint \}\)/);
  assert.doesNotMatch(island, /t\('triage\.hint'\)/);
  assert.match(view, /widgetBlock\('work-item-drawer'/);
  assert.match(view, /findingProposalCommand\(authz, selected\.summary\)/);
  assert.match(view, /findingSummaryLine\(/);
  assert.match(layout, /requireFeatureEnabled\(authz\.user\.orgId, 'continuousClose'\)/);
  assert.match(page, /loadAgents\(sp\)/);
  assert.match(page, /agentsSpec\(data\)/);
});

// The inbox table is the shared spec table: sortable severity/materiality/
// detected columns over the rank default, age + split assignee/due columns,
// and the since window beside the existing facet chips.
test("inbox table binds the list source sort and shared filters", () => {
  assert.match(view, /sorting: \{ basePath: '\/agents', sort: f\('sort'\), dir: f\('dir'\) \}/);
  assert.match(view, /sort: 'severity'/);
  assert.match(view, /sort: 'materiality'/);
  assert.match(view, /sort: 'detected'/);
  assert.match(view, /paramKey: 'since'/);
  assert.match(view, /column\(f\('columnAge'\)/);
  assert.match(view, /column\(f\('columnDue'\)/);
  assert.match(view, /RelativeTimeFormat/);
  assert.match(view, /column\(f\('columnAssignee'\)/);
});

// The header is the shared module-home pill strip (Inbox · Proposals ·
// Briefing · Activity→Setup) over the shared KPI strip; the proposals lane
// resolves viewer-signed commands up front and renders the chat's review
// card inline; unresolvable carriers stay visible with a note instead of a
// dead Apply.
test("header binds module-home tabs and the KPI strip", () => {
  assert.match(view, /widget\('module-home-tabs', \{ tabs: data\.tabs \}\)/);
  assert.match(view, /href: '\/admin\/setup\/agents\/activity'/);
  assert.match(view, /widgetBlock\('agents-kpi-strip', \{ items: data\.kpis \}\)/);
  assert.match(view, /listAgentRuns\(authz\.user\.orgId, \{ limit: 1 \}\)/);
  assert.doesNotMatch(view, /widgetBlock\('tab-nav'/);
  assert.doesNotMatch(view, /metric-tile/);
});

test("proposals tab reuses the shared table and drawer card", () => {
  assert.match(view, /when: f\('proposalsEmpty'\)/);
  assert.match(view, /when: f\('inboxEmpty'\)/);
  assert.match(view, /findingProposalCommand\(authz, selected\.summary\)/);
  assert.doesNotMatch(view, /proposal-lane-card/);
  assert.doesNotMatch(view, /showLane/);
  assert.doesNotMatch(view, /AgentsLaneCard/);
  const drawer = read("../continuous-close/WorkItemDrawer.tsx");
  assert.match(drawer, /ApplicationCommandCard/);
});

// Assignment & SLA ride the drawer: owner/role with a due date plus a
// comment thread, surfaced in the inbox as an assignee column and an
// assignment chip group. Writes reuse the item PATCH route — no second path.
test("drawer carries assignment and notes", () => {
  assert.match(view, /loadWorkItemAssignment\(authz, itemId\)/);
  assert.match(view, /listWorkItemNotes\(authz, itemId\)/);
  assert.match(view, /listAgentNotificationTargets\(authz\.user\.orgId\)/);
  assert.match(view, /paramKey: 'assigned'/);
  assert.match(listSource, /assigned === "mine"\) filters\.assignedToMe = true as const/);
  assert.match(listSource, /assigned === "unassigned"\) filters\.unassignedOnly = true as const/);
  assert.match(listSource, /assigned === "overdue"\) filters\.overdueOnly = true as const/);
  assert.match(view, /column\(f\('columnAssignee'\)/);
  const drawer = read("../continuous-close/WorkItemDrawer.tsx");
  assert.match(drawer, /action: 'assign'/);
  assert.match(drawer, /action: 'note'/);
  assert.match(drawer, /ta\('drawer\.assignment\.title'\)/);
  assert.match(drawer, /ta\('drawer\.notes\.title'\)/);
  const feed = read("../../api/agents/inbox/route.ts");
  assert.match(feed, /assigned === "mine"/);
});

test("ask-about-this deep-links chat with the finding handoff", () => {
  const drawer = read("../continuous-close/WorkItemDrawer.tsx");
  assert.match(drawer, /query: \{ finding: item\.id \}/);
  assert.match(drawer, /ta\('drawer\.askAboutThis'\)/);
  const assistantView = read("../assistant/view.ts");
  assert.match(assistantView, /isUuid\(finding\)/);
  assert.match(assistantView, /initialFindingId/);
  const app = read("../../../components/assistant/assistant-app.tsx");
  assert.match(app, /findingId \? \{ findingId \} : \{\}/);
  assert.match(app, /t\('context\.attached'\)/);
});

test("briefing tab serves the cached narrative", () => {
  assert.match(view, /loadBriefing\(authz\)/);
  assert.match(view, /frame\('card', \[/);
  assert.match(view, /stripBriefingTitle\(briefing\.briefing\?\.text/);
  assert.match(view, /widgetBlock\('section-heading', \{/);
  assert.match(view, /widgetBlock\('agents-briefing-body', \{ text: data\.briefingText \}\)/);
  assert.match(view, /widgetBlock\('agents-briefing-actions', \{ \.\.\.data\.briefingActions \}\)/);
  assert.match(view, /when: f\('hasBriefing'\)/);
  assert.match(view, /when: f\('briefingEmpty'\)/);
  assert.match(view, /when: f\('showInboxChrome'\)/);
  assert.match(view, /briefing: 'true'/);
  assert.doesNotMatch(view, /widgetBlock\('agents-briefing',/);
});

// The briefing island is actions-only: generate + send over the briefing
// API, then refresh. No panel chrome, no markdown — those are spec blocks.
test("briefing actions island triggers and refreshes", () => {
  const actions = read("./AgentsBriefingActions.tsx");
  assert.match(actions, /\/api\/agents\/briefing/);
  assert.match(actions, /method: 'POST'/);
  assert.match(actions, /router\.refresh\(\)/);
  assert.doesNotMatch(actions, /ChatMarkdown/);
  assert.doesNotMatch(actions, /rounded-xl/);
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
