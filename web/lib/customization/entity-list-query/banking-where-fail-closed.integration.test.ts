import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Banking entity lists interpolate account/date filter values into typed
// columns uncast, like the document lists did: a crafted account or date
// filter (or a saved view holding one) dies as a raw uuid/date throw and
// the whole page 500s. The builders must fail those closed to an empty row
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
const { bankReconciliationWhere, bankStatementWhere } = await import("./banking.ts");
const { defaultListView } = await import("@openbooks/customization");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function reconCount(orgId: string, adhoc: { filters?: Record<string, string> }): Promise<number> {
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from reconciliations r
      join accounts bank_account on bank_account.id = r.account_id and bank_account.org_id = r.org_id
      where ${bankReconciliationWhere({ ...defaultListView("bank_reconciliation"), filters: [] }, { filters: adhoc.filters }, orgId, null)}`)
  ).rows;
  return rows[0]!.n;
}

async function statementCount(
  orgId: string,
  adhoc: { filters?: Record<string, string> },
  viewFilters: { key: string; operator: string; value?: string | null }[] = [],
): Promise<number> {
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from bank_statements bs
      join accounts statement_account on statement_account.id = bs.account_id and statement_account.org_id = bs.org_id
      where ${bankStatementWhere({ ...defaultListView("bank_statement"), filters: viewFilters as never }, { filters: adhoc.filters }, orgId, null)}`)
  ).rows;
  return rows[0]!.n;
}

test("malformed banking list filters match nothing instead of throwing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.equal(await reconCount(org.orgId, {}), 0, "empty org starts empty");
    assert.equal(await reconCount(org.orgId, { filters: { account_id: "not-a-uuid" } }), 0, "malformed account matches nothing");
    assert.equal(
      await statementCount(org.orgId, { filters: { account_id: "not-a-uuid" } }),
      0,
      "malformed statement account matches nothing",
    );
    assert.equal(
      await statementCount(
        org.orgId,
        {},
        [{ key: "statement_date", operator: "gte", value: "not-a-date" }],
      ),
      0,
      "malformed saved date filter matches nothing",
    );
    // Well-formed values keep working (empty on unknown ids, never a throw).
    assert.equal(
      await reconCount(org.orgId, { filters: { account_id: org.accounts.bank } }),
      0,
      "well-formed unknown account stays empty",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
