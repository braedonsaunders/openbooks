import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

// Wave-4 UI consistency (shard c02): the Agents activity must be the shared
// filter + table + server pagination composition (the [entity] setup
// precedent — `filter-chips` with URL state, a card-wrapped spec `table` with
// shared sort headers, the `pagination` block, the shared `empty-state`) with
// re-run as one small row island, instead of the monolithic
// `agents-activity-workspace` island that hand-rolled its select filter,
// table, show-more paging and empty note with raw primitives and client
// fetches.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const view = read("./view.ts");
const widgets = read("../../../../../../components/viewspec/widgets-agents.tsx");
const lib = read("../../../../../../lib/setup/agents.ts");

test("the activity spec binds shared filter, table, paging and empty state", () => {
  assert.match(view, /widgetBlock\('filter-chips'/);
  assert.match(view, /table\(\{/);
  assert.match(view, /variant: 'app'/);
  assert.match(view, /pagination\(\{/);
  assert.match(view, /widgetBlock\('empty-state'/);
  assert.match(view, /widgetCell\('agents-run-actions'/);
  assert.doesNotMatch(view, /agents-activity-workspace/);
  assert.equal(
    existsSync(new URL("./AgentsActivityWorkspace.tsx", import.meta.url)),
    false,
    "the monolithic activity island must be retired",
  );
});

test("the registry exposes the run-actions island and drops the workspace", () => {
  assert.match(widgets, /'agents-run-actions'/);
  assert.doesNotMatch(widgets, /agents-activity-workspace/);
});

test("the list contract pages and sorts server-side", () => {
  assert.match(view, /parseListParams/);
  assert.match(lib, /offset/);
  assert.match(lib, /sort/);
});

test("status badges are Title case and started uses the shared dateTime", () => {
  assert.match(view, /setup\.agents\.runStatuses\./);
  assert.doesNotMatch(view, /overview\.runStatus/);
  assert.match(view, /dateTime\(run\.startedAt\)/);
  assert.doesNotMatch(view, /toLocaleString\(\)/);
});

test("status and since filter chips sit beside pack with URL state", () => {
  assert.match(view, /paramKey: 'status'/);
  assert.match(view, /paramKey: 'since'/);
  assert.match(view, /findingsSinceIso\(sinceKey\)/);
  assert.match(view, /currentParams: data\.currentParams/);
  assert.match(lib, /AGENT_RUN_STATUSES/);
  assert.match(lib, /and status = /);
  assert.match(lib, /and started_at > /);
});
