import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The opportunity list interpolates status_id / owner_user_id / party_id /
// expected_close_date structured filters — and the status/owner quick
// filters — into uuid/date columns uncast: a crafted value (or a saved view
// holding one) dies as a raw throw and the whole page 500s. The builder
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

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { opportunityWhere } = await import("./opportunities.ts");
const { defaultListView } = await import("@openbooks/customization");

const DB = !!process.env.OPENBOOKS_DB_URL;

type Filter = { key: string; operator: string; value?: string | null; to?: string | null };

async function oppCount(
  orgId: string,
  viewFilters: Filter[] = [],
  adhocFilters: Record<string, string> = {},
): Promise<number> {
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from crm_opportunities o
      where ${opportunityWhere({ ...defaultListView("opportunity"), filters: viewFilters as never }, { filters: adhocFilters }, orgId, null)}`)
  ).rows;
  return rows[0]!.n;
}

test("malformed opportunity filters match nothing instead of throwing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.ok((await oppCount(org.orgId)) >= 0, "baseline counts without throwing");
    assert.equal(
      await oppCount(org.orgId, [{ key: "status_id", operator: "eq", value: "not-a-uuid" }]),
      0,
      "malformed status filter matches nothing",
    );
    assert.equal(
      await oppCount(org.orgId, [{ key: "expected_close_date", operator: "gte", value: "not-a-date" }]),
      0,
      "malformed close-date filter matches nothing",
    );
    assert.equal(
      await oppCount(org.orgId, [], { status_id: "not-a-uuid" }),
      0,
      "malformed status quick filter matches nothing",
    );
    assert.equal(
      await oppCount(org.orgId, [
        { key: "party_id", operator: "eq", value: "00000000-0000-4000-8000-000000000000" },
      ]),
      0,
      "well-formed unknown party stays empty without throwing",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
