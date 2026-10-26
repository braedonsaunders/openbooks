import assert from "node:assert/strict";
import test from "node:test";
import { REPORT_AS_OF, REPORT_ENTITY_MAP } from "./entities";
import { BUILT_IN_REPORT_DEFINITION_MAP } from "./built-ins";
import { compileCustomQuery } from "./custom-query";
import { runCustomQuery } from "./run";
import { SERVICE_REPORT_ENTITIES } from "./service-entities";
import { validateCustomQuery } from "./validate";

const ORG = "00000000-0000-4000-8000-000000000001";
const ENTITY = "00000000-0000-4000-8000-000000000002";
const AS_OF = "2026-10-18";

const SERVICE_BUILT_INS = {
  "service-jobs-by-status": "service_jobs_by_status",
  "service-technician-utilization": "service_technician_utilization",
  "service-first-time-fix": "service_first_time_fix",
  "service-quote-win-rate": "service_quote_win_rate",
  "service-revenue-per-job": "service_revenue_per_job",
} as const;

/** A pg client returning the given summarize rows, with a single observed
 *  transaction currency on statements that probe denominations. */
const clientFor = (rows: Record<string, unknown>[]) => ({
  query: async (text: string) => ({
    rows: rows.map((row) => ({
      ...row,
      __book_group_n: "1",
      ...(text.includes("WITH __denom AS") ? { __txn_n: "1", __txn_v: "CAD" } : {}),
    })),
  }),
});

test("service sources sit in the core catalog behind the Service dispatch feature and service read permission", () => {
  for (const entity of SERVICE_REPORT_ENTITIES) {
    assert.equal(
      REPORT_ENTITY_MAP[entity.key],
      entity,
      `${entity.key} is executable through the core catalog`,
    );
    assert.equal(entity.featureKey, "serviceDispatch", entity.key);
    assert.equal(entity.requiredPermission, "service.read", entity.key);
    assert.equal(entity.category, "service", entity.key);
    assert.ok(entity.subsidiaryScope?.column, `${entity.key} declares its legal-entity boundary`);
  }
});

test("every service join stays inside the base row organization and the legal-entity fence always applies", () => {
  for (const entity of SERVICE_REPORT_ENTITIES) {
    const base = entity.orgColumn.split(".")[0]!;
    for (const line of entity.from.split("\n").filter((text) => /^\s*(LEFT )?JOIN\b/i.test(text))) {
      if (/\bJOIN orgs o ON o\.id = /.test(line)) continue;
      assert.match(line, /\borg_id = [a-z]+\.org_id\b/, `${entity.key}: ${line.trim()}`);
    }
    const compiled = compileCustomQuery(
      entity,
      {
        entity: entity.key,
        mode: "rows",
        columns: [entity.columns[0]!.key],
        filters: null,
        limit: 10,
      },
      ORG,
      { asOf: AS_OF, allowedSubsidiaryIds: [ENTITY] },
    );
    assert.match(compiled.text, new RegExp(`WHERE ${base}\\.org_id = \\$1`), entity.key);
    assert.ok(
      compiled.text.includes(`${entity.subsidiaryScope!.column} = ANY($2::uuid[])`),
      `${entity.key} applies the entity fence`,
    );
    assert.deepEqual(compiled.values.slice(0, 2), [ORG, [ENTITY]]);
    assert.match(
      compileCustomQuery(
        entity,
        {
          entity: entity.key,
          mode: "rows",
          columns: [entity.columns[0]!.key],
          filters: null,
          limit: 10,
        },
        ORG,
        { asOf: AS_OF, allowedSubsidiaryIds: [] },
      ).text,
      /FALSE/,
      `${entity.key} reads nothing for a reader with no legal entities`,
    );
  }
});

test("open-job age is measured to the run business date, never the database clock", () => {
  const entity = REPORT_ENTITY_MAP.service_jobs_by_status!;
  assert.ok(entity.from.includes(REPORT_AS_OF));
  assert.doesNotMatch(entity.from, /current_date|now\(\)/i);
  assert.equal(
    entity.defaultPeriodField,
    null,
    "aging is current state and ignores the period window",
  );
  const compiled = compileCustomQuery(
    entity,
    {
      entity: entity.key,
      mode: "rows",
      columns: ["job_number", "age_days", "age_bucket"],
      filters: null,
      limit: 10,
    },
    ORG,
    { asOf: AS_OF },
  );
  assert.ok(!compiled.text.includes(REPORT_AS_OF), "the sentinel never reaches Postgres");
  assert.ok(compiled.values.includes(AS_OF));
  assert.throws(
    () =>
      compileCustomQuery(
        entity,
        {
          entity: entity.key,
          mode: "rows",
          columns: ["job_number"],
          filters: null,
          limit: 10,
        },
        ORG,
      ),
    /requires asOf/,
  );
  const buckets = entity.columns.find((column) => column.key === "age_bucket")!.options!;
  assert.deepEqual([...buckets].sort(), [...buckets], "bucket values sort in age order");
});

test("first-time fix counts completed one-visit jobs outside agreements, and money stays in one currency", () => {
  const fix = REPORT_ENTITY_MAP.service_first_time_fix!;
  assert.deepEqual(fix.baseFilter, {
    combinator: "and",
    rules: [
      { field: "status", op: "eq", value: "completed" },
      { field: "recurring", op: "is_false" },
    ],
  });
  assert.equal(
    fix.columns.find((column) => column.key === "first_time_fix")!.expr,
    "(visits.completed_visits = 1 AND visits.unable_visits = 0)",
  );
  assert.match(fix.from, /v\.kind = 'service'/);

  const revenue = REPORT_ENTITY_MAP.service_revenue_per_job!;
  assert.match(revenue.from, /b\.released_at IS NULL AND d\.status = 'posted'/);
  assert.match(revenue.from, /d\.kind = 'customer_invoice'/);
  assert.match(revenue.from, /sum\(d\.subtotal\) FILTER \(WHERE d\.currency = j\.currency\)/);
  assert.match(
    revenue.from,
    /count\(\*\) FILTER \(WHERE d\.currency <> j\.currency\) AS other_currency_invoices/,
  );
  for (const entity of [revenue, REPORT_ENTITY_MAP.service_quote_win_rate!]) {
    assert.equal(entity.currencyColumn, "currency");
    for (const column of entity.columns.filter((entry) => entry.kind === "money")) {
      assert.equal(
        column.txnCurrency,
        true,
        `${entity.key}.${column.key} is denominated in the row currency`,
      );
    }
  }
});

test("service built-ins validate against their sources and compute rates as guarded formula measures", () => {
  for (const [slug, entityKey] of Object.entries(SERVICE_BUILT_INS)) {
    const definition = BUILT_IN_REPORT_DEFINITION_MAP[slug];
    assert.ok(definition, `${slug} is a built-in`);
    assert.equal(definition.query.entity, entityKey);
    const plan = validateCustomQuery(definition.query);
    assert.doesNotThrow(
      () => compileCustomQuery(REPORT_ENTITY_MAP[entityKey]!, plan, ORG, { asOf: AS_OF }),
      slug,
    );
    for (const measure of plan.measures ?? []) {
      if (
        measure.fn !== "formula" ||
        (measure.expr && !("op" in measure.expr && measure.expr.op === "/"))
      )
        continue;
      assert.ok(measure.guards?.length, `${slug}.${measure.key} names an empty denominator`);
    }
  }
  const moneyBreakouts = ["service-quote-win-rate", "service-revenue-per-job"];
  for (const slug of moneyBreakouts) {
    assert.ok(
      BUILT_IN_REPORT_DEFINITION_MAP[slug]!.query.breakouts?.some(
        (breakout) => breakout.column === "currency",
      ),
      `${slug} partitions money by currency`,
    );
  }
});

test("quote win rate divides accepted by decided quotes exactly and explains a month with no decisions", async () => {
  const definition = BUILT_IN_REPORT_DEFINITION_MAP["service-quote-win-rate"]!;
  const result = await runCustomQuery(
    clientFor([
      { d0: "2026-09-01", d1: "CAD", m0: 5, m1: 2, m2: 1, m3: 3, m4: "1234.5600", m5: null },
      { d0: "2026-10-01", d1: "CAD", m0: 2, m1: 0, m2: 0, m3: 0, m4: null, m5: null },
    ]),
    definition.query,
    { orgId: ORG, entityMap: REPORT_ENTITY_MAP, asOf: AS_OF },
  );
  const table = result.groups[0]!;
  const winRate = table.columns.indexOf("Win rate");
  assert.ok(winRate > 0);
  assert.ok(!table.columns.includes("decided"), "the decided component stays hidden");
  assert.equal(String(table.rows[0]![winRate]), "66.67%");
  assert.equal(
    table.rows[1]![winRate],
    "No decided quotes",
    "an empty denominator is explained, never printed as zero",
  );
  assert.equal(table.undefinedCells?.[1]?.[winRate], "No decided quotes");
});

test("first-time fix rate and revenue per job are exact ratios of their components", async () => {
  const fix = await runCustomQuery(
    clientFor([{ d0: "2026-09-01", m0: 3, m1: 2, m2: "1.3333333333333333", m3: null }]),
    BUILT_IN_REPORT_DEFINITION_MAP["service-first-time-fix"]!.query,
    { orgId: ORG, entityMap: REPORT_ENTITY_MAP, asOf: AS_OF },
  );
  const fixTable = fix.groups[0]!;
  assert.equal(
    String(fixTable.rows[0]![fixTable.columns.indexOf("First-time fix rate")]),
    "66.67%",
  );

  const revenue = await runCustomQuery(
    clientFor([{ d0: "2026-09-01", d1: "CAD", m0: 3, m1: "1000.0000", m2: null }]),
    BUILT_IN_REPORT_DEFINITION_MAP["service-revenue-per-job"]!.query,
    { orgId: ORG, entityMap: REPORT_ENTITY_MAP, asOf: AS_OF },
  );
  const revenueTable = revenue.groups[0]!;
  assert.equal(
    String(revenueTable.rows[0]![revenueTable.columns.indexOf("Revenue per job")]),
    "333.3333",
  );
});
