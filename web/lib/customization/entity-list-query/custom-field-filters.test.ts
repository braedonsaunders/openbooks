import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { defaultListView } = await import("@openbooks/customization");
const { projectWhere } = await import("./projects.ts");
const { customerWhere, vendorWhere } = await import("./customers.ts");
const { itemWhere } = await import("./items.ts");
const { timesheetWeekWhere } = await import("./timesheet-weeks.ts");
const { bankRuleWhere } = await import("./banking.ts");

const ORG = "00000000-0000-0000-0000-000000000001";
const cfEq = [{ key: "cf_region", operator: "eq" as const, value: "west" }];

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

function assertCustomApplied(text: string, alias: string) {
  assert.match(text, new RegExp(`${alias}\\.custom->>`), `cf_* must bind against ${alias}.custom`);
  assert.match(text, /region/, "the custom field def key must appear");
  assert.match(text, /west/, "the filter value must be parameterized");
}

test("projectWhere ANDs custom-field filters against p.custom", () => {
  const where = projectWhere({ ...defaultListView("project"), filters: cfEq }, {}, ORG, null);
  assertCustomApplied(sqlText(where as { queryChunks?: unknown[] }), "p");
});

test("customerWhere ANDs custom-field filters against p.custom", () => {
  const where = customerWhere({ ...defaultListView("customer"), filters: cfEq }, {}, ORG, null);
  assertCustomApplied(sqlText(where as { queryChunks?: unknown[] }), "p");
});

test("vendorWhere ANDs custom-field filters against p.custom", () => {
  const where = vendorWhere({ ...defaultListView("vendor"), filters: cfEq }, {}, ORG, null);
  assertCustomApplied(sqlText(where as { queryChunks?: unknown[] }), "p");
});

test("itemWhere ANDs custom-field filters against i.custom", () => {
  const where = itemWhere({ ...defaultListView("item"), filters: cfEq }, {}, ORG);
  assertCustomApplied(sqlText(where as { queryChunks?: unknown[] }), "i");
});

test("timesheetWeekWhere fails closed on custom-field filters (no custom jsonb)", () => {
  const where = timesheetWeekWhere({ ...defaultListView("timesheet_week"), filters: cfEq }, {}, ORG, null);
  const text = sqlText(where as { queryChunks?: unknown[] });
  assert.match(text, /false/, "lists without a custom store must empty-match, not drop");
  assert.doesNotMatch(text, /custom->>/, "must not reference a nonexistent custom column");
});

test("bankRuleWhere fails closed on custom-field filters (no custom jsonb)", () => {
  const where = bankRuleWhere({ ...defaultListView("bank_rule"), filters: cfEq }, {}, ORG);
  const text = sqlText(where as { queryChunks?: unknown[] });
  assert.match(text, /false/, "lists without a custom store must empty-match, not drop");
  assert.doesNotMatch(text, /custom->>/, "must not reference a nonexistent custom column");
});
