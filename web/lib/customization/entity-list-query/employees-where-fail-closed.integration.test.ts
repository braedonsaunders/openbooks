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

const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { employeeWhere } = await import("./employment-directory.ts");
const { defaultListView } = await import("@openbooks/customization");

const DB = !!process.env.OPENBOOKS_DB_URL;

type Filter = { key: string; operator: string; value?: string | string[] | null };

async function employeeCount(
  orgId: string,
  viewFilters: Filter[] = [],
  adhocFilters: Record<string, string> = {},
): Promise<number> {
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from parties p
      where ${employeeWhere({ ...defaultListView("employee"), filters: viewFilters as never }, { filters: adhocFilters }, orgId, null)}`)
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
