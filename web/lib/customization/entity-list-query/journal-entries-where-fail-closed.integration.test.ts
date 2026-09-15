import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The journal-entries list interpolates posting-date filter values into a
// DATE column uncast: a crafted date filter (or a saved view holding one)
// dies as a raw date throw and the whole Journal page 500s. The builder must
// fail those closed to an empty row set. SQL builders and storage are real;
// only server-only is stubbed.
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
const { JOURNAL_ENTRY_TABLE, journalEntryWhere } = await import("./journal-entries.ts");
const { defaultListView } = await import("@openbooks/customization");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function entryCount(
  orgId: string,
  viewFilters: { key: string; operator: string; value?: string | null; to?: string | null }[] = [],
): Promise<number> {
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.raw(JOURNAL_ENTRY_TABLE)} e
      where ${journalEntryWhere({ ...defaultListView("journal"), filters: viewFilters as never }, {}, orgId, null)}`)
  ).rows;
  return rows[0]!.n;
}

test("malformed journal posting-date filters match nothing instead of throwing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.equal(await entryCount(org.orgId), 0, "empty org starts empty");
    assert.equal(
      await entryCount(org.orgId, [{ key: "posting_date", operator: "gte", value: "not-a-date" }]),
      0,
      "malformed date filter matches nothing",
    );
    assert.equal(
      await entryCount(org.orgId, [
        { key: "posting_date", operator: "between", value: "2026-01-01", to: "2026-02-30" },
      ]),
      0,
      "malformed between-upper matches nothing",
    );
    assert.equal(
      await entryCount(org.orgId, [{ key: "posting_date", operator: "gte", value: "2020-01-01" }]),
      0,
      "well-formed date filter stays empty without throwing",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
