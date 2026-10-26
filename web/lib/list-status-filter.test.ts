import assert from "node:assert/strict";
import test from "node:test";
import { defaultListView } from "@openbooks/customization";
import { resolveListStatusFilter, selectedListStatuses } from "./list-status-filter";

const values = ["draft", "pending_approval", "approved", "posted", "voided"];
const view = defaultListView("vendor_bill");

test("the working bill list excludes voids while preserving other saved filters", () => {
  const saved = {
    ...view,
    filters: [{ key: "transaction_kind", operator: "eq" as const, value: "vendor_bill" }],
  };
  const result = resolveListStatusFilter(saved, undefined, ["voided"]);
  assert.deepEqual(
    selectedListStatuses(values, result.view.filters, result.statuses),
    values.slice(0, -1),
  );
  assert.deepEqual(result.view.filters[0], saved.filters[0]);
  assert.equal(saved.filters.length, 1, "resolving the default must not mutate the saved view");
});

test("a saved voided view remains usable and an explicit multi-selection replaces its status only", () => {
  const saved = {
    ...view,
    filters: [
      { key: "status", operator: "eq" as const, value: "voided" },
      { key: "transaction_kind", operator: "eq" as const, value: "vendor_bill" },
    ],
  };
  const inherited = resolveListStatusFilter(saved, undefined, ["voided"]);
  assert.deepEqual(selectedListStatuses(values, inherited.view.filters, inherited.statuses), [
    "voided",
  ]);
  const explicit = resolveListStatusFilter(saved, "posted,pending_approval", ["voided"]);
  assert.deepEqual(selectedListStatuses(values, explicit.view.filters, explicit.statuses), [
    "pending_approval",
    "posted",
  ]);
  assert.deepEqual(explicit.view.filters, [saved.filters[1]]);
});

test("All and an empty selection remain distinct from the default exclusion", () => {
  const all = resolveListStatusFilter(view, "all", ["voided"]);
  assert.deepEqual(selectedListStatuses(values, all.view.filters, all.statuses), values);
  const none = resolveListStatusFilter(view, "none", ["voided"]);
  assert.deepEqual(none.statuses, []);
  assert.deepEqual(selectedListStatuses(values, none.view.filters, none.statuses), []);
  assert.deepEqual(resolveListStatusFilter(view, "voided", ["voided"]).statuses, ["voided"]);
});

test("saved set exclusions and single-status links share the same status semantics", () => {
  const saved = {
    ...view,
    filters: [{ key: "status", operator: "not_in" as const, value: ["draft", "voided"] }],
  };
  assert.deepEqual(selectedListStatuses(values, saved.filters), [
    "pending_approval",
    "approved",
    "posted",
  ]);
  assert.deepEqual(resolveListStatusFilter(saved, "draft,draft,posted").statuses, [
    "draft",
    "posted",
  ]);
  assert.deepEqual(resolveListStatusFilter(saved, "unrecognized").statuses, ["unrecognized"]);
});
