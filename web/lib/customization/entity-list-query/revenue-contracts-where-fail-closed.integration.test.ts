import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The revenue-contract list interpolates the customer_id / starts_on /
// ends_on structured filters into uuid/date columns uncast: a crafted value
// (or a saved view holding one) dies as a raw throw and the whole page 500s.
// The builder must fail such filters closed to an empty row set. SQL
// builders and storage are real; only server-only is stubbed.
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
const { revenueContractWhere } = await import("./revenue-contracts.ts");
const { defaultListView } = await import("@openbooks/customization");

const DB = !!process.env.OPENBOOKS_DB_URL;

type Filter = { key: string; operator: string; value?: string | null; to?: string | null };

async function contractCount(orgId: string, viewFilters: Filter[] = []): Promise<number> {
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from revenue_contracts rc
      where ${revenueContractWhere({ ...defaultListView("revenue_contract"), filters: viewFilters as never }, {}, orgId)}`)
  ).rows;
  return rows[0]!.n;
}

test("malformed revenue-contract filters match nothing instead of throwing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.ok((await contractCount(org.orgId)) >= 0, "baseline counts without throwing");
    assert.equal(
      await contractCount(org.orgId, [{ key: "customer_id", operator: "eq", value: "not-a-uuid" }]),
      0,
      "malformed customer filter matches nothing",
    );
    assert.equal(
      await contractCount(org.orgId, [{ key: "starts_on", operator: "gte", value: "not-a-date" }]),
      0,
      "malformed starts_on filter matches nothing",
    );
    assert.equal(
      await contractCount(org.orgId, [
        { key: "customer_id", operator: "eq", value: "00000000-0000-4000-8000-000000000000" },
      ]),
      0,
      "well-formed unknown customer stays empty without throwing",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
