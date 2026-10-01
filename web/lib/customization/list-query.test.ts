import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";

// SQL builders only. The server-only seam is stubbed the same way as
// list-where-fail-closed.integration.test.ts — no database.
const { documentWhere, columnDescriptors } = await import("./list-query.ts");
const { defaultListView } = await import("@openbooks/customization");

const KINDS = ["vendor_bill", "vendor_credit"] as const;
const view = { ...defaultListView("vendor_bill"), filters: [] };

test("account saved views omit the retired row action and keep the account link", () => {
  const accountView = defaultListView("account");
  assert.ok(!accountView.columns.some((column) => column.key === "_actions"));
  const legacyView = { ...accountView, columns: [...accountView.columns, { key: "_actions", visible: true }] };
  const cols = columnDescriptors("account", legacyView, [], { name: sql`a.name` }, {});
  assert.ok(!cols.some((column) => column.kind === "actions"));
  assert.ok(cols.some((column) => column.key === "name" && column.kind === "reference"));
  assert.ok(columnDescriptors("vendor_bill", view, [], {}, {}).some((column) => column.kind === "actions"));
});

function sqlText(query: { queryChunks?: unknown[] } | null | undefined): string {
  const top = query == null ? undefined : query.queryChunks;
  if (!Array.isArray(top)) return String(query);
  let out = "";
  const walk = (chunks: unknown[]) => {
    for (const chunk of chunks) {
      if (typeof chunk === "string") {
        out += chunk;
        continue;
      }
      if (chunk && typeof chunk === "object") {
        const nested = (chunk as { queryChunks?: unknown[] }).queryChunks;
        if (Array.isArray(nested)) {
          walk(nested);
          continue;
        }
        const value = (chunk as { value?: unknown }).value;
        if (typeof value === "string") {
          out += value;
          continue;
        }
        if (Array.isArray(value)) {
          out += value.join("");
          continue;
        }
        if (value != null) out += String(value);
      }
    }
  };
  walk(top);
  return out;
}

test("documentWhere ANDs custom-field filters instead of dropping them", () => {
  const where = documentWhere(
    [...KINDS],
    { ...view, filters: [{ key: "cf_region", operator: "eq", value: "west" }] },
    {},
    "00000000-0000-0000-0000-000000000001",
    null,
  );
  const text = sqlText(where as { queryChunks?: unknown[] });
  assert.match(text, /custom->>/, "cf_* filters must bind against custom jsonb");
  assert.match(text, /region/, "the custom field def key must appear in the predicate");
  assert.match(text, /west/, "the filter value must be parameterized into the predicate");
  assert.match(text, /\band\b/i, "the clause must be AND-ed, not omitted");
});

test("documentWhere fails closed on an untyped custom-field range operator", () => {
  const where = documentWhere(
    [...KINDS],
    { ...view, filters: [{ key: "cf_region", operator: "between", value: "a", to: "z" }] },
    {},
    "00000000-0000-0000-0000-000000000001",
    null,
  );
  const text = sqlText(where as { queryChunks?: unknown[] });
  assert.match(text, /false/, "unsupported cf_* operators must empty-match, not drop");
});
