import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { installEngineSeams } from "../composition/install.ts";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import { getProfile } from "../sim/profiles/index.ts";
import { provisionOrg, wipeSimOrg } from "../sim/world.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { verifyAndRegisterDemoAccounting } from "./accounting.ts";
import { installDemoScenarios } from "./install-scenarios.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
installEngineSeams();

test("master accounting verification is audited, idempotent, and refuses stock that does not reconcile", enabled, async () => {
  const world = await provisionOrg(getProfile("general-business"), { startDate: "2026-01-01", endDate: "2026-12-31" });
  let foreignOrgId: string | undefined;
  try {
    foreignOrgId = (await provisionOrg(getProfile("general-business"), { startDate: "2026-01-01", endDate: "2026-12-31" })).orgId;
    await installDemoScenarios(world.orgId, "general_business");
    const first = await verifyAndRegisterDemoAccounting(world.orgId);
    assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
    const evidence = () => withOrgContext(world.orgId, async () => (await db.execute(sql`
      select settings->'demoData'->'accountingVerification' as proof,
        (select count(*)::int from audit_log where org_id=${world.orgId} and changes->>'reason'='Verify master demonstration accounting before making it available as a source') as audits
      from orgs where id=${world.orgId}
    `)).rows[0]);
    const before = await evidence();
    assert.equal(before!.audits, 1);
    assert.equal((before!.proof as { status: string }).status, "passed");
    assert.deepEqual(await verifyAndRegisterDemoAccounting(world.orgId), first);
    assert.deepEqual(await evidence(), before);
    // Reclassifying an opening-balance account as stock control without
    // corresponding cost layers reproduces a real reconciliation refusal.
    await withOrgContext(world.orgId, async () => {
      const itemId = randomUUID();
      await db.execute(sql`insert into items(id,org_id,code,name,kind) values(${itemId},${world.orgId},'UNRECONCILED-STOCK','Unreconciled opening stock','inventory')`);
      await db.execute(sql`insert into item_inventory_profiles(org_id,item_id,asset_account_id,cogs_account_id,adjustment_account_id) values(${world.orgId},${itemId},${world.accounts.inventory},${world.accounts.cogs},${world.accounts.cogs})`);
    });
    await assert.rejects(verifyAndRegisterDemoAccounting(world.orgId), (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /inventory-subledger-gl-tieout/);
      assert.match(message, /46000/);
      assert.match(message, /Reconcile the named source records through their normal accounting workflows/);
      return true;
    });
    assert.deepEqual(await evidence(), before, "a refusal must neither certify the changed books nor emit a success audit");
  } finally { await wipeSimOrg(world.orgId); if (foreignOrgId) await wipeSimOrg(foreignOrgId); }
});

test("accounting certification refuses ordinary tenant books before inspecting or updating them", enabled, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await assert.rejects(verifyAndRegisterDemoAccounting(org.orgId), /requires an installed synthetic master demo/);
    await withOrgContext(org.orgId, async () => {
      const row = (await db.execute(sql`select settings ? 'demoData' as certified from orgs where id=${org.orgId}`)).rows[0];
      assert.equal(row!.certified, false);
    });
  } finally { await withBypass(() => dropScratchOrg(org.orgId)); }
});
