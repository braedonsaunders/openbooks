import assert from "node:assert/strict";
import test from "node:test";
import { ref } from "@braedonsaunders/appkit-viewspec";
import { resolveListToolbarProps } from "./list-toolbar-props";
import { resolveWidgetProps } from "./widget-props";

const f = ref<{
  path: string;
  params: Record<string, string>;
  search: string;
  label: string;
  options: { value: string; label: string }[];
  date: string;
}>();

test("native toolbar resolves structured filter and search references for each request scope", () => {
  const input = {
    basePath: f("path"),
    currentParams: f("params"),
    search: { placeholder: f("search") },
    filters: [{ paramKey: "status", label: f("label"), options: f("options") }],
    date: { paramKey: "asOf", label: f("label"), resolved: f("date") },
  };
  const first = {
    path: "/tax?tab=history",
    params: { status: "filed" },
    search: "Search filings",
    label: "Status",
    options: [{ value: "filed", label: "Filed" }],
    date: "2026-06-30",
  };
  const result = resolveListToolbarProps(input, first);
  assert.equal(result.basePath, first.path);
  assert.equal(result.currentParams, first.params);
  assert.equal(result.search?.placeholder, "Search filings");
  assert.equal(result.filters?.[0]?.label, "Status");
  assert.equal(
    result.filters?.[0]?.options.find((option) => option.value === "filed")?.label,
    "Filed",
  );
  assert.equal(result.date?.resolved, "2026-06-30");
  const second = resolveListToolbarProps(input, { ...first, label: "État", options: [] });
  assert.equal(second.filters?.[0]?.label, "État");
  assert.deepEqual(second.filters?.[0]?.options, []);
  assert.deepEqual(input.filters[0]?.options, f("options"));
});

test("literal native controls and opaque table field definitions retain their identity", () => {
  const options = [{ value: "active", label: "Active" }];
  const filter = { paramKey: "state", label: "State", options };
  assert.equal(
    resolveListToolbarProps({ basePath: "/items", currentParams: {}, filters: [filter] }, {})
      .filters?.[0]?.options,
    options,
  );
  const table = { rows: f("options"), columns: [{ field: { $: "row.name" } }] };
  assert.equal(resolveWidgetProps({ table }, {}).table, table);
  assert.equal(resolveListToolbarProps({ basePath: "/items", currentParams: {} }, {}).search, null);
});
