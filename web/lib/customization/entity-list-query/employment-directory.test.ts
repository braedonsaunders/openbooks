import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql, type SQL } from "drizzle-orm";

// HR-2b: the employee directory resolves employment through ONE shared
// as-of predicate and filters it in the source's where builder. This pins
// both without a database: the predicate text must carry the live-version
// rule, and the builder must turn every directory filter into an emp.*
// predicate — or fail it closed. SQL builders are real; only server-only
// is stubbed. Row-shape coverage lives in the companion
// employees-where-fail-closed.integration.test.ts, which needs a fixture
// database.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const {
  employeeBaseJoins,
  employeeBuiltInExpr,
  employeeSorts,
  employeeWhere,
  liveVersionAsOf,
} = await import("./employment-directory.ts");
const { PARTY_BUILT_IN_EXPR, PARTY_SORTS } = await import("./customers.ts");
const { defaultListView } = await import("@openbooks/customization");

const ORG = "019f5ea3-44c5-72c0-ad3b-ef34c19c8763";
const TODAY = "2026-09-20";
const DEPT = "11111111-1111-4111-8111-111111111111";
const SUB = "22222222-2222-4222-8222-222222222222";

function whereText(
  viewFilters: { key: string; operator: string; value?: unknown }[] = [],
  adhocFilters: Record<string, string> = {},
  hrmEnabled = true,
  allowed: Set<string> | null = null,
): string {
  const where = employeeWhere(
    { ...defaultListView("employee"), filters: viewFilters as never },
    { filters: adhocFilters, hrmEnabled },
    ORG,
    allowed,
  );
  return db.select({ n: sql`count(*)` }).from(sql.raw("parties p")).where(where).toSQL().sql;
}

function joinsText(hrmOn: boolean, allowed: Set<string> | null = null): string {
  return db
    .select({ one: sql`1` })
    .from(sql`parties p ${employeeBaseJoins(hrmOn, TODAY, allowed)}`)
    .toSQL().sql;
}

function predicateText(fragment: SQL): string {
  return db.select({ one: sql`1` }).from(sql.raw("parties p")).where(fragment).toSQL().sql;
}

test("the shared as-of predicate carries the live-version rule", () => {
  const { text } = { text: predicateText(liveVersionAsOf("ev", TODAY)) };
  assert.match(text, /recorded_until is null/, "only the still-current version is live");
  assert.match(text, /effective_from <=/, "the window opens on or before today");
  assert.match(text, /coalesce\(/, "a null end is unbounded, never unknown");
  assert.match(text, /effective_to/, "the window end is compared");
  assert.match(text, /infinity/, "unbounded maps to infinity inside the comparison");
  assert.match(text, /< coalesce/, "the end bound is strict: adjacent windows never overlap");
});

test("the as-of predicate cannot drift from the read service's own rule", () => {
  // The read service resolves through temporal.ts resolveAsOf; the list
  // mirrors it in SQL at asKnown = now. Both texts are quoted here so a
  // change to either rule breaks this test and forces a joint review.
  const temporal = readFileSync(
    new URL("../../../../engine/src/hrm/temporal.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    temporal.includes("recordedAt <= asKnown < recordedUntil"),
    "temporal still defines liveness as recordedAt <= asKnown < recordedUntil",
  );
  assert.ok(
    temporal.includes("[start, end)"),
    "temporal still defines effective membership half-open",
  );
  const helper = readFileSync(new URL("./employment-directory.ts", import.meta.url), "utf8");
  assert.ok(
    helper.includes("recorded_until is null"),
    "the helper still selects the still-current version",
  );
  assert.ok(
    helper.includes("coalesce(") && helper.includes("infinity"),
    "the helper still maps a null end to infinity",
  );
});

test("the unfiltered directory reads no employment predicate", () => {
  const text = whereText();
  assert.match(text, /employee_roles/, "role membership still scopes the list");
  assert.doesNotMatch(text, /emp\./, "no directory predicate without a directory filter");
});

test("department quick filter resolves to the primary assignment", () => {
  assert.match(
    whereText([], { department: DEPT }),
    /emp\.department_id/,
    "a department id filters the live primary assignment",
  );
  const unassigned = whereText([], { department: "unassigned" });
  assert.match(unassigned, /emp\.department_id is null/, "unassigned names a null department");
  assert.match(
    unassigned,
    /emp\.employment_status is not null/,
    "unassigned still requires a live employment — parties without one are no_employment, not unassigned",
  );
  assert.match(
    whereText([], { department: "not-a-uuid" }),
    /false/,
    "a malformed department id matches nothing instead of throwing",
  );
});

test("employment-status quick filter names the live version status", () => {
  assert.match(
    whereText([], { employment_status: "active" }),
    /emp\.employment_status/,
    "a status filters the live version",
  );
  assert.match(
    whereText([], { employment_status: "no_employment" }),
    /emp\.employment_status is null/,
    "no_employment names parties with no live employment",
  );
  assert.match(
    whereText([], { employment_status: "tenured" }),
    /false/,
    "an unknown status matches nothing instead of widening the list",
  );
});

test("employer quick filter resolves to the employment's subsidiary", () => {
  assert.match(
    whereText([], { employer: SUB }),
    /emp\.employer_subsidiary_id/,
    "an employer id filters the live employment's subsidiary",
  );
  assert.match(
    whereText([], { employer: "not-a-uuid" }),
    /false/,
    "a malformed employer id matches nothing instead of throwing",
  );
});

test("directory filters fail closed while HRM is off", () => {
  for (const adhoc of [
    { department: DEPT },
    { department: "unassigned" },
    { employment_status: "active" },
    { employment_status: "no_employment" },
    { employer: SUB },
  ]) {
    assert.match(
      whereText([], adhoc, false),
      /false/,
      `hrm-off quick filter ${JSON.stringify(adhoc)} matches nothing`,
    );
  }
  assert.match(
    whereText([{ key: "department", operator: "eq", value: DEPT }], {}, false),
    /false/,
    "a stale saved-view directory filter matches nothing while HRM is off",
  );
  const off = whereText([], {}, false);
  assert.doesNotMatch(off, /emp\./, "hrm-off reads no employment predicate");
});

test("saved-view directory filters support eq and in", () => {
  assert.match(
    whereText([{ key: "department", operator: "eq", value: DEPT }]),
    /emp\.department_id/,
    "saved-view department eq filters the live primary assignment",
  );
  assert.match(
    whereText([{ key: "employment_status", operator: "in", value: ["active", "on_leave"] }]),
    /emp\.employment_status in/,
    "saved-view status in filters the live version",
  );
  assert.match(
    whereText([{ key: "employer", operator: "eq", value: SUB }]),
    /emp\.employer_subsidiary_id/,
    "saved-view employer eq filters the live employment's subsidiary",
  );
});

test("directory columns read the shared joins, gated by the switch", () => {
  const exprText = (expr: SQL): string =>
    db.select({ value: expr }).from(sql.raw("parties p")).toSQL().sql;
  const on = employeeBuiltInExpr(true);
  assert.deepEqual(
    Object.keys(on).sort(),
    [...Object.keys(PARTY_BUILT_IN_EXPR), "department", "job_title", "employment_status", "employer", "service_start"].sort(),
    "hrm-on keeps every party column and adds the five directory columns",
  );
  for (const key of ["department", "job_title", "employment_status", "employer", "service_start"]) {
    assert.match(
      exprText(on[key]!),
      /emp/,
      `${key} selects off the shared employment joins — no column carries its own version subquery`,
    );
  }
  assert.doesNotMatch(
    exprText(on.department!),
    /worker_employment_versions|employment_assignment_versions/,
    "columns read the lateral, never a second version scan",
  );
  assert.deepEqual(
    Object.keys(employeeBuiltInExpr(false)).sort(),
    Object.keys(PARTY_BUILT_IN_EXPR).sort(),
    "hrm-off selects the party columns only — directory columns are absent, not empty",
  );
  const sortsOn = employeeSorts(true);
  for (const key of ["department", "job_title", "employment_status", "employer", "service_start"]) {
    assert.ok(sortsOn[key], `${key} is sortable`);
  }
  assert.deepEqual(
    Object.keys(employeeSorts(false)).sort(),
    Object.keys(PARTY_SORTS).sort(),
    "hrm-off sorts the party keys only",
  );
});

test("the employment joins stay single-row and fenced", () => {
  const on = joinsText(true);
  assert.match(on, /left join lateral/, "the directory employment resolves per party");
  assert.match(on, /limit 1/, "at most one employment row per party — never a fan-out");
  assert.match(on, /is_primary/, "assignments resolve primary-only");
  assert.match(on, /recorded_until is null/, "versions resolve live-only");
  assert.match(on, /emp_dept/, "department names join, never a second query");
  assert.match(on, /emp_sub/, "employer names join, never a second query");
  assert.equal(joinsText(false).includes("lateral"), false, "hrm-off makes no employment joins");
  assert.match(
    joinsText(true, new Set([SUB])),
    /e\.employer_subsidiary_id = any/,
    "a scoped viewer fences employments to their allowed employers",
  );
  assert.match(joinsText(true, new Set()), /false/, "an empty scope matches no employment");
  assert.doesNotMatch(
    joinsText(true, null),
    /employer_subsidiary_id = any/,
    "an unrestricted viewer carries no employer fence",
  );
});
