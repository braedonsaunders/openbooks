import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// List filter values reach typed columns uncast: a crafted ?vendor=, ?from=
// or ?to= (or a saved view holding one) dies at the database as a raw uuid /
// date throw and the whole list page 500s. The canonical WHERE must fail
// those closed to an empty row set instead. SQL builders and storage are
// real; only the server-only seam is stubbed.
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
const { documentWhere } = await import("./list-query.ts");
const { defaultListView } = await import("@openbooks/customization");

const DB = !!process.env.OPENBOOKS_DB_URL;
const KINDS = ["vendor_bill", "vendor_credit"] as const;
const view = { ...defaultListView("vendor_bill"), filters: [] };

async function countRows(orgId: string, adhoc: Parameters<typeof documentWhere>[2]): Promise<number> {
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      where ${documentWhere([...KINDS], { ...view, filters: [] }, adhoc, orgId, null)}`)
  ).rows;
  return rows[0]!.n;
}

test("malformed list date and reference filters match nothing instead of throwing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const id = randomUUID();
    await db.execute(sql`insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom)
      values (${id}, ${org.orgId}, 'vendor_bill', 'draft', 'BILL-F', ${org.date}, ${org.subsidiaryId}, 'CAD', '10', '0', '10', '{}'::jsonb)`);
    assert.equal(await countRows(org.orgId, {}), 1, "unfiltered list sees the bill");
    assert.equal(await countRows(org.orgId, { vendor: "not-a-uuid" }), 0, "malformed vendor matches nothing");
    assert.equal(await countRows(org.orgId, { from: "not-a-date" }), 0, "malformed from matches nothing");
    assert.equal(await countRows(org.orgId, { to: "2026-02-30" }), 0, "impossible to matches nothing");
    assert.equal(
      await countRows(org.orgId, { filters: { party_id: "not-a-uuid" } }),
      0,
      "malformed party filter matches nothing",
    );
    // Well-formed values keep working: own vendor matches, unknown vendor is empty.
    assert.equal(await countRows(org.orgId, { vendor: org.vendorId }), 0, "unrelated own-org vendor is empty");
    assert.equal(await countRows(org.orgId, { from: "2020-01-01", to: "2030-01-01" }), 1, "covering range sees the bill");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("malformed saved-view structured filters match nothing instead of throwing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const id = randomUUID();
    await db.execute(sql`insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom)
      values (${id}, ${org.orgId}, 'vendor_bill', 'draft', 'BILL-F', ${org.date}, ${org.subsidiaryId}, 'CAD', '10', '0', '10', '{}'::jsonb)`);
    const run = async (filters: { key: string; operator: string; value?: string | null }[]): Promise<number> => {
      const rows = (
        await db.execute<{ n: number }>(sql`select count(*)::int as n from documents d
          left join parties p on p.id = d.party_id and p.org_id = d.org_id
          where ${documentWhere([...KINDS], { ...view, filters: filters as never }, {}, org.orgId, null)}`)
      ).rows;
      return rows[0]!.n;
    };
    assert.equal(
      await run([{ key: "party_id", operator: "eq", value: "not-a-uuid" }]),
      0,
      "malformed saved party filter matches nothing",
    );
    assert.equal(
      await run([{ key: "document_date", operator: "gte", value: "not-a-date" }]),
      0,
      "malformed saved date filter matches nothing",
    );
    assert.equal(
      await run([{ key: "status", operator: "eq", value: "draft" }]),
      1,
      "well-formed saved filters keep working",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("saved custom-field filters restrict the document list instead of dropping", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const west = randomUUID();
    const east = randomUUID();
    await db.execute(sql`insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom)
      values
        (${west}, ${org.orgId}, 'vendor_bill', 'draft', 'BILL-W', ${org.date}, ${org.subsidiaryId}, 'CAD', '10', '0', '10', ${'{"region":"west"}'}::jsonb),
        (${east}, ${org.orgId}, 'vendor_bill', 'draft', 'BILL-E', ${org.date}, ${org.subsidiaryId}, 'CAD', '10', '0', '10', ${'{"region":"east"}'}::jsonb)`);
    const run = async (filters: { key: string; operator: string; value?: string | string[] | null }[]): Promise<number> => {
      const rows = (
        await db.execute<{ n: number }>(sql`select count(*)::int as n from documents d
          left join parties p on p.id = d.party_id and p.org_id = d.org_id
          where ${documentWhere([...KINDS], { ...view, filters: filters as never }, {}, org.orgId, null)}`)
      ).rows;
      return rows[0]!.n;
    };
    assert.equal(await run([]), 2, "unfiltered list sees both bills");
    assert.equal(
      await run([{ key: "cf_region", operator: "eq", value: "west" }]),
      1,
      "eq on a custom field must AND, not drop",
    );
    assert.equal(
      await run([{ key: "cf_region", operator: "eq", value: "south" }]),
      0,
      "a non-matching custom-field filter must empty the list, not return the tenant",
    );
    assert.equal(
      await run([{ key: "cf_region", operator: "in", value: ["west", "east"] }]),
      2,
      "in on a custom field keeps matching rows",
    );
    assert.equal(
      await run([{ key: "cf_region", operator: "between", value: "east", to: "west" }]),
      0,
      "an untyped range operator fails closed to empty, never drops",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
