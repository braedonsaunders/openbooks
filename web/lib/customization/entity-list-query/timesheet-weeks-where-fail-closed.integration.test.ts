import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The timesheet-week list interpolates the employee_party_id structured
// filter — and the employee quick filter — into a uuid column uncast: a
// crafted value (or a saved view holding one) dies as a raw throw and the
// whole page 500s. The builder must fail such filters closed to an empty row
// set. SQL builders and storage are real; only server-only is stubbed.
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
const { timesheetWeekWhere } = await import("./timesheet-weeks.ts");
const { defaultListView } = await import("@openbooks/customization");

const DB = !!process.env.OPENBOOKS_DB_URL;

type Filter = { key: string; operator: string; value?: string | null; to?: string | null };

async function weekCount(
  orgId: string,
  viewFilters: Filter[] = [],
  adhocFilters: Record<string, string> = {},
): Promise<number> {
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from time_entries tw
      where ${timesheetWeekWhere({ ...defaultListView("timesheet_week"), filters: viewFilters as never }, { filters: adhocFilters }, orgId, null)}`)
  ).rows;
  return rows[0]!.n;
}

test("malformed timesheet-week filters match nothing instead of throwing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.ok((await weekCount(org.orgId)) >= 0, "baseline counts without throwing");
    assert.equal(
      await weekCount(org.orgId, [{ key: "employee_party_id", operator: "eq", value: "not-a-uuid" }]),
      0,
      "malformed employee filter matches nothing",
    );
    assert.equal(
      await weekCount(org.orgId, [], { employee_party_id: "not-a-uuid" }),
      0,
      "malformed employee quick filter matches nothing",
    );
    assert.equal(
      await weekCount(org.orgId, [
        { key: "employee_party_id", operator: "eq", value: "00000000-0000-4000-8000-000000000000" },
      ]),
      0,
      "well-formed unknown employee stays empty without throwing",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
