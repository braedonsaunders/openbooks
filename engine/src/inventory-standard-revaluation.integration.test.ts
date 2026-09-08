import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "./db.ts";
import { withSimClock } from "./clock.ts";
import { receiveInventory, revalueOpenLayersToStandardCost } from "./inventory.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

async function evidence(orgId: string) {
  return (await db.execute<{ state: unknown }>(sql`select jsonb_build_object(
    'layers',(select jsonb_agg(to_jsonb(l) order by id) from cost_layers l where org_id=${orgId}),
    'journals',(select jsonb_agg(to_jsonb(j) order by id) from journal_entries j where org_id=${orgId}),
    'lines',(select jsonb_agg(to_jsonb(l) order by id) from journal_lines l where org_id=${orgId})
  ) as state`)).rows[0]!.state;
}

for (const scenario of ["disabled feature", "disabled book", "missing period", "restricted account", "inactive owner", "later owner restriction", "missing account", "aliased accounts", "uppercase aliased accounts"] as const) {
  test(`standard revaluation preserves financial evidence: ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const ownerId = randomUUID();
      const siblingId = randomUUID();
      for (const id of [ownerId, siblingId]) await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${id},${org.orgId},${org.subsidiaryId},${id},'CAD','CA')`);
      const receipt = { itemId: org.items.fifo, stockLocationId: org.stockLocationId, subsidiaryId: ownerId,
        quantity: "10", unitCost: "5", date: org.date, offsetAccountId: org.accounts.clearing };
      await receiveInventory(org.orgId, actorId, receipt);
      if (scenario === "later owner restriction") await receiveInventory(org.orgId, actorId, { ...receipt, subsidiaryId: siblingId });
      if (scenario === "disabled feature") await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":false}'::jsonb) where id=${org.orgId}`);
      if (scenario === "disabled book") await db.execute(sql`update accounting_books set posts_gl=false where org_id=${org.orgId} and id=${org.bookId}`);
      if (scenario === "restricted account" || scenario === "later owner restriction") await db.execute(sql`update accounts
        set subsidiary_id=${scenario === "restricted account" ? siblingId : ownerId},subsidiary_include_children=false
        where org_id=${org.orgId} and id=${org.accounts.invAsset}`);
      if (scenario === "inactive owner") await db.execute(sql`update subsidiaries set is_active=false where org_id=${org.orgId} and id=${ownerId}`);
      const before = await evidence(org.orgId);
      const options = { standardCost: "6", assetAccountId: scenario === "missing account" ? randomUUID() : org.accounts.invAsset,
        varianceAccountId: scenario === "aliased accounts" ? org.accounts.invAsset
          : scenario === "uppercase aliased accounts" ? org.accounts.invAsset.toUpperCase() : org.accounts.adjustment };
      const run = () => revalueOpenLayersToStandardCost(db, org.orgId, actorId, org.items.fifo, options);
      await withSimClock(scenario === "missing period" ? "2026-08-15" : org.date, () => withOrgTransaction(org.orgId, async () => {
        await db.execute(sql`update orgs set name='Scratch revaluation caller work' where id=${org.orgId}`);
        if (scenario === "missing account") await assert.rejects(run());
        else await assert.rejects(run(), scenario === "disabled feature" ? /inventory feature is disabled/i
          : scenario === "disabled book" ? /active primary posting book/
          : scenario === "missing period" ? /no accounting period/
          : scenario.endsWith("aliased accounts") ? /variance account must be distinct/
          : scenario === "inactive owner" ? /inactive/ : /restricted to another subsidiary/);
        assert.deepEqual(await evidence(org.orgId), before, "caught refusal must restore all layers and journals");
      }));
      assert.deepEqual(await evidence(org.orgId), before);
      assert.equal((await db.execute<{ name: string }>(sql`select name from orgs where id=${org.orgId}`)).rows[0]!.name, "Scratch revaluation caller work");
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true}'::jsonb) where id=${org.orgId}`);
      await db.execute(sql`update accounting_books set posts_gl=true where org_id=${org.orgId} and id=${org.bookId}`);
      await db.execute(sql`update accounts set subsidiary_id=null where org_id=${org.orgId} and id=${org.accounts.invAsset}`);
      await db.execute(sql`update subsidiaries set is_active=true where org_id=${org.orgId} and id=${ownerId}`);
      options.assetAccountId = org.accounts.invAsset;
      options.varianceAccountId = org.accounts.adjustment;
      const entries = await withSimClock(org.date, () => withOrgTransaction(org.orgId, run));
      assert.equal(entries?.length, scenario === "later owner restriction" ? 2 : 1);
      const balance = (await db.execute<{ balanced: boolean }>(sql`select
        (select sum(remaining_quantity*unit_cost) from cost_layers where org_id=${org.orgId}) =
        (select sum(amount) from journal_lines where org_id=${org.orgId} and account_id=${org.accounts.invAsset}) as balanced`)).rows[0]!;
      assert.equal(balance.balanced, true, "successful retry preserves inventory GL = layer value");
    } finally { await dropScratchOrg(org.orgId); }
  });
}
