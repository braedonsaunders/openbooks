import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

// Wave-4 UI consistency (shard c02): the per-pack policy page must follow the
// Setup form pattern (sections in shared Card shells, form fields from the
// shared @openbooks/ui components, notification routing as shared
// select/multi-select) instead of the monolithic `agents-policy-workspace`
// island that hand-rolled its sections, native selects, checkbox scroll boxes
// and buttons with local classes.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const view = read("./view.ts");
const widgets = read("../../../../../../components/viewspec/widgets.tsx");
const form = read("./AgentPolicyForm.tsx");

test("the policy spec binds the shared form island, not the workspace", () => {
  assert.match(view, /widgetBlock\('agents-policy-form'/);
  assert.match(view, /widgetBlock\('attention-list'/);
  assert.doesNotMatch(view, /agents-policy-workspace/);
  assert.equal(
    existsSync(new URL("./AgentPolicyWorkspace.tsx", import.meta.url)),
    false,
    "the monolithic policy island must be retired",
  );
});

test("the registry exposes the policy form and drops the workspace", () => {
  assert.match(widgets, /'agents-policy-form'/);
  assert.doesNotMatch(widgets, /agents-policy-workspace/);
});

test("the form builds on shared components, never native selects", () => {
  assert.match(form, /from '@openbooks\/ui'/);
  assert.match(form, /SearchSelect/);
  assert.match(form, /<Card[ >]/);
  assert.doesNotMatch(form, /<select/);
  assert.doesNotMatch(form, /agents-policy-workspace/i);
});

test("the loader resolves the header strings", () => {
  assert.match(view, /getTranslations\('admin'\)/);
});

test("toggles are the shared Switch, never raw checkboxes", () => {
  assert.match(form, /from '@\/components\/switch'/);
  assert.match(form, /on=\{draft\.enabled\}/);
  assert.match(form, /on=\{draft\.automaticRuns\}/);
  assert.match(form, /on=\{detector\.enabled\}/);
  assert.doesNotMatch(form, /<Check checked=\{draft/);
  assert.doesNotMatch(form, /<Check checked=\{detector/);
});

test("materiality is a 2-decimal money input with formatted helper copy", () => {
  assert.match(form, /<MoneyInput/);
  assert.match(form, /step="0\.01"/);
  assert.match(form, /twoDecimals\(policy\.materialityThreshold\)/);
  assert.match(form, /formatMoney\(draft\.materialityThreshold\)/);
  assert.match(form, /currency=\{currency\}/);
});

test("the loader hands the island the org currency and a formatted run line", () => {
  assert.match(view, /getMoneyFormatter\(authz\.user\.orgId\)/);
  assert.match(view, /currency: data\.currency/);
  assert.match(view, /dateTime\(row\.lastRun\.startedAt\)/);
  assert.match(view, /setup\.agents\.runStatuses\./);
});

test("the overview actions cell shares the same Switch", () => {
  const actions = read("../AgentsPackActions.tsx");
  assert.match(actions, /from '@\/components\/switch'/);
  assert.match(actions, /<Switch/);
});
