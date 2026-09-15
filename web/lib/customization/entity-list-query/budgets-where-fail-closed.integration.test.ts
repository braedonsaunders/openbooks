import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The budget list interpolates the book_id (uuid) and fiscal_year (integer)
// structured filters — and the book quick filter — uncast: a crafted value
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

const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { budgetWhere } = await import("./budgets.ts");
const { defaultListView } = await import("@openbooks/customization");

const DB = !!process.env.OPENBOOKS_DB_URL;

type Filter = { key: string; operator: string; value?: string | null; to?: string | null };

async function budgetCount(
  orgId: string,
  viewFilters: Filter[] = [],
  adhocFilters: Record<string, string> = {},
): Promise<number> {
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from budget_scenarios bs
      where ${budgetWhere({ ...defaultListView("budget_scenario"), filters: viewFilters as never }, { filters: adhocFilters }, orgId, null)}`)
  ).rows;
  return rows[0]!.n;
}

test("malformed budget filters match nothing instead of throwing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.ok((await budgetCount(org.orgId)) >= 0, "baseline counts without throwing");
    assert.equal(
      await budgetCount(org.orgId, [{ key: "book_id", operator: "eq", value: "not-a-uuid" }]),
      0,
      "malformed book filter matches nothing",
    );
    assert.equal(
      await budgetCount(org.orgId, [{ key: "fiscal_year", operator: "eq", value: "not-a-year" }]),
      0,
      "malformed fiscal-year filter matches nothing",
    );
    assert.equal(
      await budgetCount(org.orgId, [], { book_id: "not-a-uuid" }),
      0,
      "malformed book quick filter matches nothing",
    );
    assert.equal(
      await budgetCount(org.orgId, [
        { key: "book_id", operator: "eq", value: "00000000-0000-4000-8000-000000000000" },
      ]),
      0,
      "well-formed unknown book stays empty without throwing",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
