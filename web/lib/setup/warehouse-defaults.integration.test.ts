import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/platform/db.ts");
const {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
} = await import("@openbooks/engine/src/testing/fixtures.ts");
const { createSetupRecord } = await import("./write.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedOrg() {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update orgs set settings = settings || '{"features": {"warehousing": true}}'::jsonb
     where id = ${org.orgId}`);
  const main = (
    await db.execute<{ id: string }>(sql`
      select id from stock_locations where org_id = ${org.orgId} and code = 'MAIN'`)
  ).rows[0]!.id;
  const secondId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                              is_elimination, is_active, custom)
    values (${secondId}, ${org.orgId}, ${org.subsidiaryId}, 'Branch', 'CAD', 'CA',
            '{}'::jsonb, false, true, '{}'::jsonb)`);
  const actor = { orgId: org.orgId, id: actorId, permissions: [] as string[] };
  return { orgId: org.orgId, main, secondId, actor };
}

test(
  "warehouse defaults are designated per legal entity through Setup and audited",
  { skip: !DB },
  async () => {
    const f = await seedOrg();
    try {
      const company = await createSetupRecord(f.actor, "warehouse-defaults", {
        warehouseId: f.main,
        isActive: true,
      });
      assert.equal(company.status, 200, JSON.stringify(company.body));
      assert.ok(typeof company.body.id === "string");

      const entity = await createSetupRecord(f.actor, "warehouse-defaults", {
        subsidiaryId: f.secondId,
        warehouseId: f.main,
        isActive: true,
      });
      assert.equal(entity.status, 200, JSON.stringify(entity.body));

      const duplicate = await createSetupRecord(f.actor, "warehouse-defaults", {
        subsidiaryId: f.secondId,
        warehouseId: f.main,
        isActive: true,
      });
      assert.ok(duplicate.status >= 400, "a second default for one entity is refused");
      const rows = (
        await db.execute<{ n: number }>(sql`
          select count(*)::int as n from warehouse_defaults where org_id = ${f.orgId}`)
      ).rows[0]!.n;
      assert.equal(rows, 2, "the refused duplicate writes nothing");

      const audits = (
        await db.execute<{ n: number }>(sql`
          select count(*)::int as n from audit_log
           where org_id = ${f.orgId} and table_name = 'warehouse_defaults'`)
      ).rows[0]!.n;
      assert.ok(audits >= 2, "designations carry audit evidence");
    } finally {
      await dropScratchOrgReporting(f.orgId);
    }
  },
);
