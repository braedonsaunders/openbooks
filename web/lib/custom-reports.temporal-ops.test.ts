import assert from "node:assert/strict";
import test from "node:test";
import { REPORT_FILTER_OPERATORS } from "@openbooks/reports";

// custom-reports is server-only in production; this suite runs the one pure
// export it needs with that guard stubbed.
const { TEMPORAL_OPS, reportAsOfField, reportPeriodField } = await import("./custom-reports.ts");

test("every viewer-override temporal op is a real filter operator", () => {
  // E47: a dead 'between' sat in the override set while no compiler or
  // validator accepts it, so the set claimed to govern filters that can
  // never exist. The set must stay within the valid operators.
  const valid = new Set<string>(REPORT_FILTER_OPERATORS as readonly string[]);
  for (const op of TEMPORAL_OPS) {
    assert.ok(valid.has(op), `TEMPORAL_OPS member '${op}' is not a valid filter operator`);
  }
  assert.ok(
    !TEMPORAL_OPS.has("between"),
    "'between' compiles nowhere and must stay out of the override set",
  );
});

test("current-state reports stay complete while explicit and legacy date reports retain their period", () => {
  const snapshot = { entity: "projects", columns: [], periodField: null };
  assert.equal(
    reportPeriodField(snapshot),
    null,
    "current project counts must not become a start-date cohort",
  );
  assert.equal(reportPeriodField({ ...snapshot, periodField: "starts_on" }), "starts_on");
  assert.equal(
    reportPeriodField({
      entity: "pay_stubs",
      columns: [],
      filters: {
        combinator: "and",
        rules: [{ field: "pay_date", op: "period_preset", value: "this_fiscal_year" }],
      },
    }),
    "pay_date",
  );
});

test("a point-in-time source is read as of a date and never acquires a period window on its as-of field", () => {
  const positions = { entity: "equity_cap_table_positions", columns: [] };
  assert.equal(reportAsOfField(positions), "effective_on");
  assert.equal(
    reportPeriodField(positions),
    null,
    "no implicit fiscal window over cumulative movements",
  );
  assert.equal(
    reportPeriodField({ ...positions, periodField: "effective_on" }),
    null,
    "an explicit window on the as-of field is not honored",
  );
  assert.equal(
    reportPeriodField({
      ...positions,
      filters: {
        combinator: "and",
        rules: [{ field: "effective_on", op: "gte", value: "2026-01-01" }],
      },
    }),
    null,
  );
  assert.equal(
    reportAsOfField({ entity: "pay_stubs", columns: [] }),
    null,
    "period sources keep their period picker",
  );
});
