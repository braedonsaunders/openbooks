import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScratchOrg, dropScratchOrgReporting } from "../test-fixtures.ts";
import { createSandbox, deleteSandbox, refreshSandbox } from "./lifecycle.ts";

for (const tier of ["full", "masked", "dev", "as_of"] as const) {
  test(`${tier} sandbox copies a subsidiary tree whose parents scan after children`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
    try {
      const branch = randomUUID(), leaf = randomUUID();
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${branch},${org.orgId},${org.subsidiaryId},'Branch','CAD','CA')`);
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${leaf},${org.orgId},${branch},'Leaf','CAD','CA')`);
      // Replace the live root tuple after its children, reproducing an ordinary
      // parent edit that can make a heap or bitmap scan return children first.
      await db.execute(sql`update subsidiaries set name='Root moved after children' where id=${org.subsidiaryId}`);
      sandbox = await createSandbox({ productionOrgId: org.orgId, name: 'Scratch ordered tree', tier, masked: tier === 'masked', asOfPeriodId: tier === 'as_of' ? org.periodId : null });
      await refreshSandbox(sandbox.sandboxId);
      const copied = (await db.execute<{ id: string; parent_id: string | null }>(sql`select id,parent_id from subsidiaries where org_id=${sandbox!.sandboxOrgId}`)).rows;
      assert.equal(copied.length, 3);
      const root = copied.find(row => row.parent_id === null)!;
      assert.ok(root);
      const child = copied.find(row => row.parent_id === root.id)!;
      assert.ok(child);
      assert.equal(copied.filter(row => row.parent_id === child.id).length, 1);
      await deleteSandbox(sandbox!.sandboxId);
    } finally {
      if (sandbox) await dropScratchOrgReporting(sandbox.sandboxOrgId);
      await dropScratchOrgReporting(org.orgId);
    }
  });
}
