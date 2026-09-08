import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../test-fixtures.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";
import { applyChangeSet, approveChangeSet, buildChangeSet, reviewChangeSet } from "./promote.ts";

for (const scenario of ["foreign view owner", "foreign report owner", "foreign list owner", "admin foreign list owner", "built-in report delete", "built-in report identity", "disabled scripts"] as const) {
  test(`promotion record controls: ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
    try {
      const actors: string[] = [];
      for (const name of ["Creator", "Reviewer", "Approver"]) actors.push(await createScratchUser(org.orgId, name, "admin"));
      const applier = await createScratchUser(org.orgId, "Applying manager", "manager");
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
      const held = scenario.startsWith("built-in") || scenario === "disabled scripts" || scenario === "admin foreign list owner" ? ["*"] : ["admin.sandboxes.manage", "reports.create", "admin.customization.manage"];
      await db.execute(sql`update app_roles set permissions=${JSON.stringify(held)}::jsonb where org_id=${org.orgId} and key='manager'`);
      let table: string;
      if (scenario === "foreign view owner") {
        table = "saved_views";
        await db.execute(sql`insert into saved_views(org_id,slug,name,query,scope,owner_id) values(${org.orgId},'owner-test','Original','{}','private',${actors[0]})`);
      } else if (scenario === "foreign report owner") {
        table = "saved_reports";
        await db.execute(sql`insert into saved_reports(org_id,name,path,params,created_by_user_id) values(${org.orgId},'Original','/reports/pnl','{}',${actors[0]})`);
      } else if (scenario.includes("list owner")) {
        table = "list_views";
        await db.execute(sql`insert into list_views(org_id,record_type,name,scope,owner_id,config) values(${org.orgId},'customer','Original','user',${actors[0]},'{"schemaVersion":1,"recordType":"customer","columns":[],"filters":[],"sort":null,"perPage":25}')`);
      } else if (scenario.startsWith("built-in")) {
        table = "report_definitions";
        await db.execute(sql`insert into report_definitions(org_id,slug,name,kind,query) values(${org.orgId},'locked-report','Original','built_in','{}')`);
      } else {
        table = "user_scripts";
        await db.execute(sql`update orgs set settings='{"features":{"scripts":false}}'::jsonb where id=${org.orgId}`);
        await db.execute(sql`insert into user_scripts(org_id,name,trigger_point,source,is_active) values(${org.orgId},'Original','before_submit','function main(ctx) { return true; }',true)`);
      }
      const tableSql = sql.identifier(table);
      const before = (await db.execute(sql`select to_jsonb(r) as value from ${tableSql} r where org_id=${org.orgId}`)).rows;
      sandbox = await createSandbox({ productionOrgId: org.orgId, name: "Record controls", tier: "full", masked: false });
      if (scenario === "built-in report delete") await db.execute(sql`delete from report_definitions where org_id=${sandbox.sandboxOrgId}`);
      else if (scenario === "built-in report identity") await db.execute(sql`update report_definitions set kind='custom' where org_id=${sandbox.sandboxOrgId}`);
      else await db.execute(sql`update ${tableSql} set name='Unapproved domain change' where org_id=${sandbox.sandboxOrgId}`);
      const change = await buildChangeSet(sandbox.sandboxId, "Record controls", actors[0]);
      await reviewChangeSet(change.changeSetId, actors[1]);
      await approveChangeSet(change.changeSetId, actors[2]);
      await assert.rejects(applyChangeSet(change.changeSetId, applier), scenario === "disabled scripts" ? /scripts feature is disabled/ : scenario.startsWith("built-in") ? /built-in|report identity/i : /owner|own/i);
      assert.deepEqual((await db.execute(sql`select to_jsonb(r) as value from ${tableSql} r where org_id=${org.orgId}`)).rows, before);
      assert.equal((await db.execute(sql`select status from change_sets where id=${change.changeSetId}`)).rows[0]!.status, "approved");
    } finally {
      if (sandbox) await deleteSandbox(sandbox.sandboxId);
      await dropScratchOrgReporting(org.orgId);
    }
  });
}

for (const table of ["saved_views", "saved_reports", "list_views"] as const) {
  for (const scenario of ["owner update", "owner delete", "owner insert", "take ownership", "give ownership"] as const) {
    test(`${table} promotion: ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await createScratchOrg();
      let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
      try {
        const actors: string[] = [];
        for (const name of ["Creator", "Reviewer", "Approver"]) actors.push(await createScratchUser(org.orgId, name, "admin"));
        const applier = await createScratchUser(org.orgId, "Record owner", "manager");
        await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
        await db.execute(sql`update app_roles set permissions='["admin.sandboxes.manage","reports.create","admin.customization.manage"]'::jsonb where org_id=${org.orgId} and key='manager'`);
        const owner = scenario === "take ownership" ? actors[0]! : applier;
        if (table === "saved_views") await db.execute(sql`insert into saved_views(org_id,slug,name,query,scope,owner_id)
          values(${org.orgId},'owned-record','Original','{}','private',${owner})`);
        else if (table === "saved_reports") await db.execute(sql`insert into saved_reports(org_id,name,path,params,created_by_user_id)
          values(${org.orgId},'Original','/reports/pnl','{}',${owner})`);
        else await db.execute(sql`insert into list_views(org_id,record_type,name,scope,owner_id,config)
          values(${org.orgId},'customer','Original','user',${owner},'{"schemaVersion":1,"recordType":"customer","columns":[],"filters":[],"sort":null,"perPage":25}')`);
        sandbox = await createSandbox({ productionOrgId: org.orgId, name: "Owner transitions", tier: "full", masked: false });
        const identifier = sql.identifier(table);
        const field = sql.identifier(table === "saved_reports" ? "created_by_user_id" : "owner_id");
        if (scenario === "owner delete") await db.execute(sql`delete from ${identifier} where org_id=${sandbox.sandboxOrgId}`);
        else if (scenario === "owner insert") await db.execute(sql`delete from ${identifier} where org_id=${org.orgId}`);
        else if (scenario === "take ownership" || scenario === "give ownership") {
          const nextOwner = scenario === "take ownership" ? applier : actors[0]!;
          await db.execute(sql`update ${identifier} set ${field}=ob_rebase(${nextOwner}::uuid,o.sandbox_seed)
            from orgs o where o.id=${sandbox.sandboxOrgId} and org_id=o.id`);
        } else await db.execute(sql`update ${identifier} set name='Reviewed owner edit' where org_id=${sandbox.sandboxOrgId}`);
        const before = (await db.execute(sql`select to_jsonb(r) as value from ${identifier} r where org_id=${org.orgId}`)).rows;
        const change = await buildChangeSet(sandbox.sandboxId, scenario, actors[0]);
        assert.equal(change.itemCount, 1);
        await reviewChangeSet(change.changeSetId, actors[1]);
        await approveChangeSet(change.changeSetId, actors[2]);
        if (scenario === "take ownership" || scenario === "give ownership") {
          await assert.rejects(applyChangeSet(change.changeSetId, applier), /record owner/);
          assert.deepEqual((await db.execute(sql`select to_jsonb(r) as value from ${identifier} r where org_id=${org.orgId}`)).rows, before);
        } else {
          await applyChangeSet(change.changeSetId, applier);
          const after = (await db.execute(sql`select name,${field} as owner from ${identifier} where org_id=${org.orgId}`)).rows;
          assert.deepEqual(after, scenario === "owner delete" ? [] : [{ name: scenario === "owner update" ? "Reviewed owner edit" : "Original", owner: applier }]);
          assert.equal((await db.execute(sql`select status from change_sets where id=${change.changeSetId}`)).rows[0]!.status, "applied");
        }
      } finally {
        if (sandbox) await deleteSandbox(sandbox.sandboxId);
        await dropScratchOrgReporting(org.orgId);
      }
    });
  }
}

test("a later ownership denial rolls back earlier authorized changes and audit records", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
  try {
    const actors: string[] = [];
    for (const name of ["Creator", "Reviewer", "Approver"]) actors.push(await createScratchUser(org.orgId, name, "admin"));
    const applier = await createScratchUser(org.orgId, "Applier", "manager");
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
    await db.execute(sql`update app_roles set permissions='["admin.sandboxes.manage","reports.create","admin.custom_fields.manage"]'::jsonb where org_id=${org.orgId} and key='manager'`);
    await db.execute(sql`insert into custom_field_defs(org_id,target_table,key,label,field_type) values(${org.orgId},'parties','atomic_control','Original','text')`);
    await db.execute(sql`insert into saved_views(org_id,slug,name,query,scope,owner_id) values(${org.orgId},'private-atomic','Original','{}','private',${actors[0]})`);
    sandbox = await createSandbox({ productionOrgId: org.orgId, name: "Atomic record controls", tier: "full", masked: false });
    await db.execute(sql`update custom_field_defs set label='Must roll back' where org_id=${sandbox.sandboxOrgId}`);
    await db.execute(sql`update saved_views set name='Denied' where org_id=${sandbox.sandboxOrgId}`);
    const change = await buildChangeSet(sandbox.sandboxId, "Atomic controls", actors[0]);
    assert.equal(change.itemCount, 2);
    // Fix item order before immutable review to exercise a late rejection.
    await db.execute(sql`update change_set_items set created_at=case when table_name='custom_field_defs' then '2026-01-01'::timestamptz else '2026-01-02'::timestamptz end where change_set_id=${change.changeSetId}`);
    await reviewChangeSet(change.changeSetId, actors[1]);
    await approveChangeSet(change.changeSetId, actors[2]);
    await assert.rejects(applyChangeSet(change.changeSetId, applier), /record owner/);
    assert.equal((await db.execute(sql`select label from custom_field_defs where org_id=${org.orgId} and key='atomic_control'`)).rows[0]!.label, "Original");
    assert.equal((await db.execute(sql`select name from saved_views where org_id=${org.orgId}`)).rows[0]!.name, "Original");
    assert.equal((await db.execute(sql`select count(*)::int as n from audit_log where org_id=${org.orgId} and changes->>'changeSetId'=${change.changeSetId}`)).rows[0]!.n, 0);
    assert.equal((await db.execute(sql`select status from change_sets where id=${change.changeSetId}`)).rows[0]!.status, "approved");
  } finally {
    if (sandbox) await deleteSandbox(sandbox.sandboxId);
    await dropScratchOrgReporting(org.orgId);
  }
});
