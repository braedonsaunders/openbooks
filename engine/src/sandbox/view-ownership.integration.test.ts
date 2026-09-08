import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../test-fixtures.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";
import { applyChangeSet, approveChangeSet, buildChangeSet, reviewChangeSet } from "./promote.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
for (const table of ["saved_views", "list_views", "saved_reports"] as const) {
  for (const scenario of ["ordinary change", "legacy owner repair"] as const) {
    test(`${table} ${scenario} retains production ownership after sandbox deletion`, enabled, async () => {
      const org = await createScratchOrg();
      let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
      try {
        const actors: string[] = [];
        for (const name of ["Creator", "Reviewer", "Approver", "Applier"]) actors.push(await createScratchUser(org.orgId, name, "admin"));
        await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
        const view = randomUUID();
        if (table === "saved_views") await db.execute(sql`insert into saved_views(id,org_id,slug,name,query,scope,owner_id)
          values(${view},${org.orgId},'private-audit','Private audit','{"entity":"documents","columns":["id"]}'::jsonb,'private',${actors[0]})`);
        else if (table === "list_views") await db.execute(sql`insert into list_views(id,org_id,record_type,name,scope,owner_id,config)
          values(${view},${org.orgId},'customer_invoice','Private audit','user',${actors[0]},'{}'::jsonb)`);
        else await db.execute(sql`insert into saved_reports(id,org_id,name,path,created_by_user_id)
          values(${view},${org.orgId},'Private audit','/reports/pnl',${actors[0]})`);
        sandbox = await createSandbox({ productionOrgId: org.orgId, name: "View owner regression", tier: "full", masked: false });
        const field = table === "saved_reports" ? "created_by_user_id" : "owner_id";
        const sandboxView = (await db.execute<{ id: string; owner: string }>(sql`select id,${sql.identifier(field)} as owner from ${sql.identifier(table)} where org_id=${sandbox.sandboxOrgId}`)).rows[0]!;
        assert.notEqual(sandboxView.owner, actors[0]);
        const unchanged = await buildChangeSet(sandbox.sandboxId, "Unchanged views", actors[0]);
        assert.equal((await db.execute(sql`select id from change_set_items where change_set_id=${unchanged.changeSetId} and table_name=${table}`)).rows.length, 0);
        if (scenario === "legacy owner repair") {
          await db.execute(sql`update ${sql.identifier(table)} set ${sql.identifier(field)}=${sandboxView.owner} where org_id=${org.orgId} and id=${view}`);
        } else await db.execute(sql`update ${sql.identifier(table)} set name='Reviewed view' where org_id=${sandbox.sandboxOrgId} and id=${sandboxView.id}`);
        const change = await buildChangeSet(sandbox.sandboxId, "Reviewed owner mapping", actors[0]);
        const items = (await db.execute<{ payload: Record<string, unknown> }>(sql`select payload from change_set_items where change_set_id=${change.changeSetId} and table_name=${table}`)).rows;
        assert.equal(items.length, 1);
        assert.equal(items[0]!.payload[field], actors[0]);
        await reviewChangeSet(change.changeSetId, actors[1]);
        await approveChangeSet(change.changeSetId, actors[2]);
        await applyChangeSet(change.changeSetId, actors[3]);
        await deleteSandbox(sandbox.sandboxId);
        sandbox = undefined;
        const retained = (await db.execute<{ owner: string; name: string }>(sql`select ${sql.identifier(field)} as owner,name from ${sql.identifier(table)} where org_id=${org.orgId} and id=${view}`)).rows;
        assert.deepEqual(retained, [{ owner: actors[0], name: scenario === "legacy owner repair" ? "Private audit" : "Reviewed view" }]);
      } finally {
        if (sandbox) await deleteSandbox(sandbox.sandboxId);
        await dropScratchOrgReporting(org.orgId);
      }
    });
  }
}

test("a previously captured sandbox owner is refused at application without changing the production view", enabled, async () => {
  const org = await createScratchOrg();
  let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
  try {
    const actors: string[] = [];
    for (const name of ["Creator", "Reviewer", "Approver", "Applier"]) actors.push(await createScratchUser(org.orgId, name, "admin"));
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
    const view = randomUUID();
    await db.execute(sql`insert into saved_views(id,org_id,slug,name,query,scope,owner_id) values(${view},${org.orgId},'owner-guard','Owner guard','{}'::jsonb,'private',${actors[0]})`);
    sandbox = await createSandbox({ productionOrgId: org.orgId, name: "Stale owner payload", tier: "full", masked: false });
    const copied = (await db.execute<{ owner_id: string }>(sql`update saved_views set name='Changed' where org_id=${sandbox.sandboxOrgId} returning owner_id`)).rows[0]!;
    const change = await buildChangeSet(sandbox.sandboxId, "Old payload", actors[0]);
    await db.execute(sql`update change_set_items set payload=jsonb_set(payload,'{owner_id}',to_jsonb(${copied.owner_id}::text)) where change_set_id=${change.changeSetId} and table_name='saved_views'`);
    await reviewChangeSet(change.changeSetId, actors[1]);
    await approveChangeSet(change.changeSetId, actors[2]);
    await assert.rejects(applyChangeSet(change.changeSetId, actors[3]), /user reference must belong to production/);
    assert.deepEqual((await db.execute(sql`select owner_id,name from saved_views where org_id=${org.orgId} and id=${view}`)).rows, [{ owner_id: actors[0], name: "Owner guard" }]);
    assert.equal((await db.execute(sql`select status from change_sets where org_id=${org.orgId} and id=${change.changeSetId}`)).rows[0]!.status, "approved");
  } finally {
    if (sandbox) await deleteSandbox(sandbox.sandboxId);
    await dropScratchOrgReporting(org.orgId);
  }
});
