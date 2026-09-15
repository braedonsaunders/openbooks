import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The CRM lists interpolate status_id / owner_user_id / territory_id /
// assigned_user_id structured filters — and the status/owner/assignee quick
// filters — into uuid columns uncast: a crafted value (or a saved view
// holding one) dies as a raw throw and the whole page 500s. The builders
// must fail such filters closed to an empty row set. SQL builders and
// storage are real; only server-only is stubbed.
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
const { leadWhere, activityWhere } = await import("./crm.ts");
const { defaultListView } = await import("@openbooks/customization");

const DB = !!process.env.OPENBOOKS_DB_URL;

type Filter = { key: string; operator: string; value?: string | null; to?: string | null };

async function leadCount(
  orgId: string,
  viewFilters: Filter[] = [],
  adhocFilters: Record<string, string> = {},
): Promise<number> {
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from crm_account_profiles cp
      join parties p on p.id = cp.party_id and p.org_id = cp.org_id
      where ${leadWhere({ ...defaultListView("lead"), filters: viewFilters as never }, { filters: adhocFilters }, orgId, null)}`)
  ).rows;
  return rows[0]!.n;
}

async function activityCount(
  orgId: string,
  viewFilters: Filter[] = [],
  adhocFilters: Record<string, string> = {},
): Promise<number> {
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from crm_activities a
      where ${activityWhere({ ...defaultListView("activity"), filters: viewFilters as never }, { filters: adhocFilters }, orgId, null)}`)
  ).rows;
  return rows[0]!.n;
}

test("malformed CRM filters match nothing instead of throwing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.ok((await leadCount(org.orgId)) >= 0, "lead baseline counts without throwing");
    assert.ok((await activityCount(org.orgId)) >= 0, "activity baseline counts without throwing");
    assert.equal(
      await leadCount(org.orgId, [{ key: "status_id", operator: "eq", value: "not-a-uuid" }]),
      0,
      "malformed lead status filter matches nothing",
    );
    assert.equal(
      await leadCount(org.orgId, [], { owner_user_id: "not-a-uuid" }),
      0,
      "malformed lead owner quick filter matches nothing",
    );
    assert.equal(
      await activityCount(org.orgId, [{ key: "assigned_user_id", operator: "eq", value: "not-a-uuid" }]),
      0,
      "malformed assignee filter matches nothing",
    );
    assert.equal(
      await activityCount(org.orgId, [], { assigned_user_id: "not-a-uuid" }),
      0,
      "malformed assignee quick filter matches nothing",
    );
    assert.equal(
      await leadCount(org.orgId, [
        { key: "territory_id", operator: "eq", value: "00000000-0000-4000-8000-000000000000" },
      ]),
      0,
      "well-formed unknown territory stays empty without throwing",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
