import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const baseline = readFileSync(
  "schema/migrations/generated/0001_baseline.sql",
  "utf8",
);
const service = readFileSync(
  "engine/src/project-financial-adjustments.ts",
  "utf8",
);
const resolver = readFileSync("web/lib/project-financials.ts", "utf8");

test("project financial adjustments are immutable controlled evidence", () => {
  assert.match(baseline, /project_financial_adjustments/i);
  assert.match(baseline, /append-only/i);
  assert.match(baseline, /reversing project financial adjustment/i);
  assert.match(baseline, /project_id = new\.project_id/i);
  assert.match(baseline, /original\.measure = new\.measure/i);
  assert.match(baseline, /original\.amount = -new\.amount/i);
  assert.match(baseline, /force row level security/i);
  assert.match(
    baseline,
    /\(source_system is null\) = \(source_ref is null\)/i,
  );
  assert.match(service, /source identity/i);
  assert.match(service, /insert into audit_log/i);
  assert.match(service, /evidence_matches/i);
});

test("project financial adjustments preserve explicit derived reconciliation", () => {
  assert.match(resolver, /from project_financial_adjustments/i);
  assert.match(resolver, /actual_cost_adjustment/)
  assert.match(resolver, /invoiced_to_date_adjustment/)
  assert.match(resolver, /billable_value_adjustment/)
  assert.match(resolver, /total_price_adjustment/)
  assert.match(resolver, /could_be_invoiced_adjustment/)
  assert.match(resolver, /gross_profit_adjustment/)
  assert.match(
    resolver,
    /const calculatedGrossProfit = add\(totalPrice, neg\(totalCost\)\)/,
  )
  assert.match(
    resolver,
    /add\(calculatedGrossProfit, adjustments\.gross_profit\)/,
  )
});
