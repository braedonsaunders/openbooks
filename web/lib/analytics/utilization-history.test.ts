import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
const dialect = new PgDialect();
const statements: { sql: string; params: unknown[] }[] = [];
let refuse = false;
Object.assign(globalThis, {
  __utilizationHistoryRead: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
    const statement = dialect.sqlToQuery(query);
    statements.push(statement);
    if (refuse) throw new Error("Time history source is unavailable.");
    if (/\band false\b/i.test(statement.sql)) return { rows: [] };
    return {
      rows: [
        {
          window_index: 1,
          department: "services",
          total_hours: "12.5000",
          billable_hours: "8.2500",
        },
        { window_index: 0, department: null, total_hours: "3.0000", billable_hours: "1.5000" },
        {
          window_index: 0,
          department: "services",
          total_hours: "10.0000",
          billable_hours: "7.0000",
        },
      ],
    };
  },
});
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === "@openbooks/engine/platform/database" ||
      specifier === "@openbooks/engine/platform/db"
    )
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function ambientTenantOrgId(){return null} export async function withBypassContext(read){return read()} export const db={execute(query, mode){ const inMode = (result) => (mode === "objects" ? result.rows : result);return Promise.resolve(globalThis.__utilizationHistoryRead(query)).then(inMode)}}',
      };
    return next(specifier, context);
  },
});
const { fetchHistoryHours, planHistoryWindows } = await import("./utilization-history");
const plans = [
  { start: "2026-01-01", end: "2026-01-31" },
  { start: "2025-12-01", end: "2025-12-31" },
  { start: "2025-11-01", end: "2025-11-30" },
];
const orgId = "00000000-0000-4000-8000-000000000001";
const entityId = "00000000-0000-4000-8000-000000000002";

test("history uses one approved-time read, binds tenant and legal entity, and transfers only department hours", async () => {
  statements.length = 0;
  const rows = await fetchHistoryHours(orgId, plans, new Set([entityId]));
  assert.equal(statements.length, 1);
  const statement = statements[0]!;
  assert.match(statement.sql, /join \(values/i);
  assert.match(statement.sql, /t\.status = 'approved'/);
  assert.match(statement.sql, /coalesce\(project\.subsidiary_id, p\.subsidiary_id\)/);
  assert.match(statement.sql, /group by periods\.window_index, t\.department_id/i);
  assert.doesNotMatch(statement.sql, /cost_rate|fx_rates|employee_name|item_name/);
  assert.ok(statement.params.includes(orgId));
  assert.ok(statement.params.some((value) => value === `{${entityId}}`));
  for (const plan of plans)
    assert.ok(statement.params.includes(plan.start) && statement.params.includes(plan.end));
  assert.equal(rows[0]!.length, 2);
  assert.equal(rows[1]![0]!.total_hours, "12.5000");
  assert.deepEqual(rows[2], []);
});

test("an empty legal-entity grant cannot read time history; an empty plan does not query", async () => {
  statements.length = 0;
  assert.deepEqual(await fetchHistoryHours(orgId, [], null), []);
  assert.equal(statements.length, 0);
  assert.deepEqual(await fetchHistoryHours(orgId, plans, new Set()), [[], [], []]);
  assert.match(statements[0]!.sql, /\band false\b/i);
});

test("history source failures are raised instead of becoming a zero utilization chart", async (t) => {
  refuse = true;
  t.after(() => {
    refuse = false;
  });
  await assert.rejects(
    () => fetchHistoryHours(orgId, plans, null),
    /Time history source is unavailable/,
  );
});

// History windows feed the trend chart oldest→newest downstream, so every
// window must run start ≤ end with the fiscal-correct year — a reversed or
// wrong-year window would silently query an empty BETWEEN and flatten the
// trend. Plans arrive newest first, matching the loader's contract.
function assertWellFormed(windows: { start: string; end: string; endYm: string }[]) {
  assert.ok(windows.length > 0);
  for (const w of windows) {
    assert.ok(w.start <= w.end, `window runs end → start: ${w.start} → ${w.end}`);
    assert.equal(w.end.slice(0, 7), w.endYm);
  }
}

test("a month period plans the five prior calendar months", () => {
  const { periodMonths, windows } = planHistoryWindows("2025-10-01", "2025-10-31", 5);
  assert.equal(periodMonths, 1);
  assert.deepEqual(
    windows.map((w) => [w.start, w.end]),
    [
      ["2025-09-01", "2025-09-30"],
      ["2025-08-01", "2025-08-31"],
      ["2025-07-01", "2025-07-31"],
      ["2025-06-01", "2025-06-30"],
      ["2025-05-01", "2025-05-31"],
    ],
  );
  assert.deepEqual(
    windows.map((w) => w.endYm),
    ["2025-09", "2025-08", "2025-07", "2025-06", "2025-05"],
  );
  assertWellFormed(windows);
});

test("a quarter period plans prior quarters across the year boundary", () => {
  const { periodMonths, windows } = planHistoryWindows("2026-04-01", "2026-06-30", 5);
  assert.equal(periodMonths, 3);
  assert.deepEqual(
    windows.map((w) => [w.start, w.end]),
    [
      ["2026-01-01", "2026-03-31"],
      ["2025-10-01", "2025-12-31"],
      ["2025-07-01", "2025-09-30"],
      ["2025-04-01", "2025-06-30"],
      ["2025-01-01", "2025-03-31"],
    ],
  );
  assertWellFormed(windows);
});

test("a calendar-year period plans prior calendar years", () => {
  const { periodMonths, windows } = planHistoryWindows("2026-01-01", "2026-12-31", 5);
  assert.equal(periodMonths, 12);
  assert.deepEqual(
    windows.map((w) => [w.start, w.end]),
    [
      ["2025-01-01", "2025-12-31"],
      ["2024-01-01", "2024-12-31"],
      ["2023-01-01", "2023-12-31"],
      ["2022-01-01", "2022-12-31"],
      ["2021-01-01", "2021-12-31"],
    ],
  );
  assertWellFormed(windows);
});

test("an April-start fiscal year plans fiscal years, not calendar years", () => {
  const { periodMonths, windows } = planHistoryWindows("2026-04-01", "2027-03-31", 5);
  assert.equal(periodMonths, 12);
  assert.deepEqual(
    windows.map((w) => [w.start, w.end]),
    [
      ["2025-04-01", "2026-03-31"],
      ["2024-04-01", "2025-03-31"],
      ["2023-04-01", "2024-03-31"],
      ["2022-04-01", "2023-03-31"],
      ["2021-04-01", "2022-03-31"],
    ],
  );
  assertWellFormed(windows);
});

test("a leap-February month plans January ending on the 31st", () => {
  const { windows } = planHistoryWindows("2024-02-01", "2024-02-29", 1);
  assert.deepEqual(
    windows.map((w) => [w.start, w.end]),
    [["2024-01-01", "2024-01-31"]],
  );
  assertWellFormed(windows);
});
