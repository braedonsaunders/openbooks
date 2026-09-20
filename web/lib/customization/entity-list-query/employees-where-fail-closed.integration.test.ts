import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The employee directory interpolates department/employer quick filters
// and saved-view filters into uuid columns: a crafted value (or a saved
// view holding one) must fail closed to an empty row set instead of dying
// as a raw throw and 500ing the page. SQL builders and storage are real;
// only server-only is stubbed. Runs in the database partition.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { employeeBaseJoins, employeeWhere } = await import("./employment-directory.ts");
const { defaultListView } = await import("@openbooks/customization");

const DB = !!process.env.OPENBOOKS_DB_URL;
const TODAY = "2026-09-20";

type Filter = { key: string; operator: string; value?: string | string[] | null };

// The real page shape: the employment joins AND hrmEnabled: true, both from
// the same caller decision (entity-list-view passes hrmOn to each).
async function employeeCount(
  orgId: string,
  viewFilters: Filter[] = [],
  adhocFilters: Record<string, string> = {},
): Promise<number> {
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from parties p
      ${employeeBaseJoins(true, TODAY, null)}
      where ${employeeWhere(
        { ...defaultListView("employee"), filters: viewFilters as never },
        { filters: adhocFilters, hrmEnabled: true },
        orgId,
        null,
      )}`)
  ).rows;
  return rows[0]!.n;
}

// A caller that emits NO joins and says nothing about HRM (hrmEnabled
// undefined): the builder must fail closed to matching nothing, never emit
// emp.* into a query whose FROM never made that table.
async function employeeCountWithoutJoins(
  orgId: string,
  viewFilters: Filter[] = [],
  adhocFilters: Record<string, string> = {},
  hrmEnabled?: boolean,
): Promise<number> {
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from parties p
      where ${employeeWhere(
        { ...defaultListView("employee"), filters: viewFilters as never },
        { filters: adhocFilters, hrmEnabled },
        orgId,
        null,
      )}`)
  ).rows;
  return rows[0]!.n;
}

test("malformed employee-directory filters match nothing instead of throwing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.ok((await employeeCount(org.orgId)) >= 0, "baseline counts without throwing");
    assert.equal(
      await employeeCount(org.orgId, [], { department: "not-a-uuid" }),
      0,
      "malformed department quick filter matches nothing",
    );
    assert.equal(
      await employeeCount(org.orgId, [], { employer: "not-a-uuid" }),
      0,
      "malformed employer quick filter matches nothing",
    );
    assert.equal(
      await employeeCount(org.orgId, [], { employment_status: "tenured" }),
      0,
      "unknown employment status matches nothing",
    );
    assert.equal(
      await employeeCount(org.orgId, [{ key: "department", operator: "eq", value: "not-a-uuid" }]),
      0,
      "malformed saved-view department filter matches nothing",
    );
    assert.equal(
      await employeeCount(org.orgId, [{ key: "employer", operator: "eq", value: "not-a-uuid" }]),
      0,
      "malformed saved-view employer filter matches nothing",
    );
    assert.equal(
      await employeeCount(
        org.orgId,
        [{ key: "department", operator: "eq", value: "00000000-0000-4000-8000-000000000000" }],
      ),
      0,
      "well-formed unknown department stays empty without throwing",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});


test("directory filters without the joins fail closed to nothing instead of a SQL error", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.ok((await employeeCountWithoutJoins(org.orgId)) >= 0, "no filter, no joins: the base list still counts");
    // The caller said nothing: undefined must read as off.
    // Annotated: an array of differing object literals infers a UNION whose
    // members carry optional-undefined siblings, and `undefined` is not
    // assignable to a Record<string, string> index signature.
    const unstated: Record<string, string>[] = [
      { department: "unassigned" },
      { employment_status: "active" },
      { employer: org.orgId },
    ];
    for (const adhoc of unstated) {
      assert.equal(await employeeCountWithoutJoins(org.orgId, [], adhoc), 0, `${JSON.stringify(adhoc)} matches nothing without the joins`);
    }
    // The caller said off: same answer, by the same predicate.
    assert.equal(
      await employeeCountWithoutJoins(org.orgId, [{ key: "department", operator: "eq", value: "unassigned" }], {}, false),
      0,
      "a stale saved-view filter with HRM off matches nothing",
    );
    assert.equal(
      await employeeCountWithoutJoins(org.orgId, [], { employment_status: "no_employment" }, false),
      0,
      "an HRM-off quick filter matches nothing",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
