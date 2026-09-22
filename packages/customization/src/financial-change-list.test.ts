import assert from "node:assert/strict";
import test from "node:test";
import { defaultListView } from "./schema.ts";
import { getRecordType } from "./registry.ts";

test("the accounting-event register lists the event, subject, and legal entity", () => {
  const meta = getRecordType("financial_change");
  assert.ok(meta);
  assert.equal(meta.labelKey, "accounting.lifecycle.financial_change");
  assert.deepEqual(
    meta.listColumns.map((column) => column.key),
    [
      "operation",
      "subject",
      "domain",
      "subsidiary",
      "reason",
      "effective_on",
      "status",
      "_actions",
    ],
  );
  assert.equal(meta.listColumns.find((column) => column.key === "reason")?.defaultHidden, true);
  assert.deepEqual(
    meta.listFilters.map((filter) => filter.key),
    ["queue", "domain", "operation", "status"],
  );
  assert.deepEqual(meta.defaultSort, { sortKey: "date", dir: "desc" });
  assert.deepEqual(defaultListView("financial_change").sort, {
    column: "effective_on",
    dir: "desc",
  });
  assert.equal(
    defaultListView("financial_change").columns.find((column) => column.key === "reason")?.visible,
    false,
  );
});
