import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

// Wave-4 UI consistency (shard c02): the Agents overview must compose the
// globally available components — the KpiStrip, the spec table (app variant,
// shared sort headers) and a small row-actions island — instead of the
// monolithic `agents-overview-workspace` island that hand-rolled its cards,
// switches and layout with raw primitives.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const view = read("./view.ts");
const widgets = read("../../../../../components/viewspec/widgets.tsx");
const lib = read("../../../../../lib/setup/agents.ts");

test("the overview spec binds the shared KPI strip and the spec table", () => {
  assert.match(view, /widgetBlock\('kpi-strip'/);
  assert.match(view, /table\(\{/);
  assert.match(view, /variant: 'app'/);
  assert.match(view, /sorting: \{ basePath: '\/admin\/setup\/agents'/);
});

test("row actions arrive through a small island cell, not a page monolith", () => {
  assert.match(view, /widgetCell\('agents-pack-actions'/);
  assert.doesNotMatch(view, /agents-overview-workspace/);
  assert.equal(
    existsSync(new URL("./AgentsOverviewWorkspace.tsx", import.meta.url)),
    false,
    "the monolithic overview island must be retired",
  );
});

test("the registry exposes the shared strip and the row island", () => {
  assert.match(widgets, /'kpi-strip'/);
  assert.match(widgets, /'agents-pack-actions'/);
  assert.doesNotMatch(widgets, /agents-overview-workspace/);
});

test("the loader resolves display strings and KPI stats from the read model", () => {
  assert.match(view, /getTranslations\('admin'\)/);
  assert.match(view, /getAgentsOverview/);
  assert.match(lib, /export async function getAgentRunStats/);
});
