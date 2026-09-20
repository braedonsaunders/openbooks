import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Composition contract for the Me team (/me/team): roster, manager-assigned
// steps, pending leave, and pending change requests through the shared
// `table` block. Decisions ride native Approvals — rows deep-link there and
// the team builds no second decision path.
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const loader = readFileSync(new URL("../../../../lib/hrm/self-service.ts", import.meta.url), "utf8");

test("team renders through ModuleView with a loader-owned spec", () => {
  assert.match(page, /<ModuleView/, "page renders through the shared ModuleView host");
  assert.match(page, /loadMeTeamPage/, "page loads through the team loader");
  assert.match(view, /meTeamSpec/, "view exposes the spec builder");
  assert.match(view, /module-home-tabs/, "header carries the route-tab strip");
});

test("team rows render through the shared table block with approvals links", () => {
  assert.match(view, /table\(\{/, "rows compose a table block");
  assert.match(view, /variant: 'app'/, "the table uses the app list variant");
  assert.match(view, /rows: f\('roster'\)/, "the roster reads the loader-resolved reports");
  assert.match(view, /rows: f\('pendingLeave'\)/, "pending leave reads the loader-resolved rows");
  assert.match(view, /rows: f\('pendingChanges'\)/, "pending changes read the loader-resolved rows");
  assert.match(view, /link\(item\('decideLabel'\), item\('decideHref'\)\)/, "decisions deep-link to native Approvals");
  assert.ok(!/<table/.test(view), "the spec holds no hand-rolled table");
  const code = view.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/approve|decline/i.test(code.split('decideInApprovals').join('').split('approvalsHref').join('')), "the spec builds no decision path of its own");
});

test("the team loader resolves structure in the engine and gates the drawer link", () => {
  assert.match(loader, /getTeamView\(\{\s*orgId/, "the team reads the structural team service");
  assert.match(loader, /partyTab=employment/, "report names deep-link the employee drawer on the Employment tab");
  assert.match(loader, /can\(authz, 'parties\.read'\)/, "names render plain when the viewer cannot open the drawer");
  assert.match(view, /requirePermission\('hrm\.self\.read'\)/, "page requires the self-service grant");
});
