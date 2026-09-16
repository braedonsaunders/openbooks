import assert from "node:assert/strict";
import test from "node:test";
import { REPORT_ENTITY_MAP } from "@openbooks/reports";
import {
  applyReportPeriodWindow,
  resolveReportPeriodField,
} from "./report-window.ts";
import type { ReportCustomQuery, ReportRule, ReportRuleGroup } from "@openbooks/reports";

const ledger = REPORT_ENTITY_MAP["ledger_lines"]!;
const accounts = REPORT_ENTITY_MAP["accounts"]!;

function plan(over: Partial<ReportCustomQuery> = {}): ReportCustomQuery {
  return { entity: "ledger_lines", mode: "rows", columns: ["account_id"], ...over };
}

test("an explicit temporal filter on a date column wins over the entity default", () => {
  const field = resolveReportPeriodField(
    ledger,
    plan({
      filters: {
        combinator: "and",
        rules: [
          { field: "account_id", op: "eq", value: "abc" },
          { field: "due_date", op: "gte", value: "2026-01-01" },
        ],
      },
    }),
  );
  assert.equal(field, "due_date");
});

test("no temporal filter falls back to the entity default, then the first date column", () => {
  assert.equal(resolveReportPeriodField(ledger, plan()), "posting_date");
  assert.equal(resolveReportPeriodField(accounts, plan({ entity: "accounts" })), null);
});

test("the window replaces stored bounds on the field and keeps every other filter", () => {
  const out = applyReportPeriodWindow(
    plan({
      filters: {
        combinator: "and",
        rules: [
          { field: "posting_date", op: "gte", value: "2020-01-01" },
          { field: "posting_date", op: "lte", value: "2020-12-31" },
          { field: "account_id", op: "eq", value: "abc" },
        ],
      },
    }),
    "posting_date",
    { from: "2026-07-01", to: "2026-07-31" },
  );
  const leaves: { field: string; op: string; value: unknown }[] = [];
  const collect = (rules: unknown): void => {
    for (const r of (rules as (ReportRule | ReportRuleGroup)[]) ?? []) {
      if (r && typeof r === "object" && Array.isArray((r as ReportRuleGroup).rules)) {
        collect((r as ReportRuleGroup).rules);
      } else {
        leaves.push(r as { field: string; op: string; value: unknown });
      }
    }
  };
  collect(out.filters?.rules);
  assert.deepEqual(
    leaves.filter((l) => l.field === "posting_date").map((l) => [l.op, l.value]),
    [["gte", "2026-07-01"], ["lte", "2026-07-31"]],
  );
  assert.ok(leaves.some((l) => l.field === "account_id" && l.value === "abc"));
});
