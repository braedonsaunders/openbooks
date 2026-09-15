import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Pagination stability over tied sort keys, through the real shared ORDER BY
// clauses: five bills sharing one date/status/total must page out exactly
// once each, in a repeatable order, and four vendors sharing one name must
// do the same. Only the session seam is stubbed; SQL and storage are real.
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
const { listOrderClause } = await import("./sources.ts");
const { entityListSource, entityOrderClause } = await import("./entity-sources.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function pageIds(
  base: { select: string; from: string; where: unknown },
  order: ReturnType<typeof listOrderClause>,
  perPage: number,
  pages: number,
): Promise<string[][]> {
  const out: string[][] = [];
  for (let page = 1; page <= pages; page++) {
    const rows = (
      await db.execute<{ id: string }>(sql`select ${sql.raw(base.select)} ${sql.raw(base.from)} where ${base.where} order by ${order} limit ${perPage} offset ${(page - 1) * perPage}`)
    ).rows;
    out.push(rows.map((r) => r.id));
  }
  return out;
}

test("tied document rows page out exactly once in a repeatable order", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = randomUUID();
      ids.push(id);
      await db.execute(sql`insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom)
        values (${id}, ${org.orgId}, 'vendor_bill', 'draft', ${`BILL-T${i}`}, ${org.date}, ${org.subsidiaryId}, 'CAD', '10', '0', '10', '{}'::jsonb)`);
    }
    const base = {
      select: "d.id",
      from: "from documents d",
      where: sql`d.org_id = ${org.orgId} and d.kind = 'vendor_bill'`,
    };
    const first = await pageIds(base, listOrderClause(sql`d.document_date`, "desc"), 2, 3);
    const flat = first.flat();
    assert.deepEqual([...flat].sort(), [...ids].sort(), "every tied row appears exactly once across pages");
    assert.equal(new Set(flat).size, 5, "no row duplicates across pages");
    const second = await pageIds(base, listOrderClause(sql`d.document_date`, "desc"), 2, 3);
    assert.deepEqual(second, first, "repeat visits return the identical page layout");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("tied entity rows page out exactly once in a repeatable order", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const vendor = entityListSource("vendor");
    assert.ok(vendor, "vendor entity source exists");
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = randomUUID();
      ids.push(id);
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active)
        values (${id}, ${org.orgId}, 'vendor', 'Tied Vendor', true)`);
    }
    const base = {
      select: "p.id",
      from: "from parties p",
      where: sql`p.org_id = ${org.orgId} and p.kind = 'vendor' and p.display_name = 'Tied Vendor'`,
    };
    const first = await pageIds(base, entityOrderClause(vendor, sql`p.display_name`, "asc"), 3, 2);
    const flat = first.flat();
    assert.deepEqual([...flat].sort(), [...ids].sort(), "every tied row appears exactly once across pages");
    assert.equal(new Set(flat).size, 4, "no row duplicates across pages");
    const second = await pageIds(base, entityOrderClause(vendor, sql`p.display_name`, "asc"), 3, 2);
    assert.deepEqual(second, first, "repeat visits return the identical page layout");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
