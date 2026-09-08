import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../test-fixtures.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";
import { applyChangeSet, approveChangeSet, buildChangeSet, reviewChangeSet } from "./promote.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
for (const scenario of ["unchanged", "update drift", "delete drift", "late conflict", "legacy", "invalid base", "insert", "insert collision"] as const) {
  test(`promotion captured base: ${scenario}`, enabled, async () => {
    const org = await createScratchOrg();
    let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
    try {
      const actors: string[] = [];
      for (const name of ["Creator", "Reviewer", "Approver", "Applier"]) actors.push(await createScratchUser(org.orgId, name, "admin"));
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
      await db.execute(sql`insert into app_roles(org_id,key,name) values(${org.orgId},'capture_a','Original A'),(${org.orgId},'capture_b','Original B')`);
      sandbox = await createSandbox({ productionOrgId: org.orgId, name: "Capture preconditions", tier: "full", masked: false });
      if (scenario === "delete drift") await db.execute(sql`delete from app_roles where org_id=${sandbox.sandboxOrgId} and key='capture_a'`);
      else if (scenario === "insert" || scenario === "insert collision") await db.execute(sql`insert into app_roles(org_id,key,name) values(${sandbox.sandboxOrgId},'capture_new','New role')`);
      else await db.execute(sql`update app_roles set name='Reviewed name' where org_id=${sandbox.sandboxOrgId} and (key='capture_a' or (${scenario === 'late conflict'} and key='capture_b'))`);
      const change = await buildChangeSet(sandbox.sandboxId, "Reviewed snapshot", actors[0]);
      const items = (await db.execute<{ id: string; target_id: string; base_captured: boolean; expected_before: Record<string, unknown> | null; op: string }>(sql`
        select id,target_id,base_captured,expected_before,op from change_set_items where change_set_id=${change.changeSetId} order by created_at,id`)).rows;
      assert.ok(items.length > 0);
      for (const item of items) {
        assert.equal(item.base_captured, true);
        if (item.op === "insert") assert.equal(item.expected_before, null);
        else {
          assert.equal(item.expected_before!.id, item.target_id);
          assert.equal(item.expected_before!.org_id, org.orgId);
        }
      }
      if (scenario === "legacy") await db.execute(sql`update change_set_items set base_captured=false where change_set_id=${change.changeSetId}`);
      else if (scenario === "invalid base") {
        await assert.rejects(db.execute(sql`update change_set_items set expected_before='{}'::jsonb where change_set_id=${change.changeSetId}`),
          (error: unknown) => (error as { cause?: { constraint?: string } }).cause?.constraint === "change_set_items_captured_base_valid");
      }
      await reviewChangeSet(change.changeSetId, actors[1]);
      await approveChangeSet(change.changeSetId, actors[2]);
      if (["update drift", "delete drift", "late conflict"].includes(scenario)) {
        await db.execute(sql`update app_roles set name='Later production change',updated_at=clock_timestamp() where org_id=${org.orgId} and id=${items.at(-1)!.target_id}`);
      } else if (scenario === "insert collision") {
        await db.execute(sql`insert into app_roles(id,org_id,key,name) values(${items[0]!.target_id},${org.orgId},'collision','Existing production record')`);
      }
      const before = (await db.execute(sql`select id,name from app_roles where org_id=${org.orgId} order by id`)).rows;
      if (["update drift", "delete drift", "late conflict", "legacy", "insert collision"].includes(scenario)) {
        await assert.rejects(applyChangeSet(change.changeSetId, actors[3]), scenario === "legacy" ? /no captured production base/
          : scenario === "insert collision" ? /already exists/ : /changed since capture/);
        assert.deepEqual((await db.execute(sql`select id,name from app_roles where org_id=${org.orgId} order by id`)).rows, before);
        assert.equal((await db.execute(sql`select status from change_sets where id=${change.changeSetId}`)).rows[0]!.status, "approved");
        assert.equal((await db.execute(sql`select id from audit_log where org_id=${org.orgId} and changes->>'changeSetId'=${change.changeSetId}`)).rows.length, 0);
      } else {
        await applyChangeSet(change.changeSetId, actors[3]);
        assert.equal((await db.execute(sql`select status from change_sets where id=${change.changeSetId}`)).rows[0]!.status, "applied");
        assert.equal((await db.execute(sql`select name from app_roles where org_id=${org.orgId} and id=${items[0]!.target_id}`)).rows[0]!.name, scenario === "insert" ? "New role" : "Reviewed name");
      }
    } finally {
      if (sandbox) await deleteSandbox(sandbox.sandboxId);
      await dropScratchOrgReporting(org.orgId);
    }
  });
}
