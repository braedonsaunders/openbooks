import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../test-fixtures.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";
import { applyChangeSet, approveChangeSet, buildChangeSet, reviewChangeSet } from "./promote.ts";

const permissions = {
  user_scripts: "scripts.manage", custom_field_defs: "admin.custom_fields.manage",
  form_layouts: "admin.customization.manage", list_views: "admin.customization.manage",
  saved_reports: "reports.create", saved_views: "reports.create",
  report_definitions: "reports.create", account_groups: "admin.setup.manage",
} as const;
for (const [table, permission] of Object.entries(permissions)) {
  test(`promotion requires the normal ${table} write permission`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
    try {
      const actors: string[] = [];
      for (const name of ["Creator", "Reviewer", "Approver"]) actors.push(await createScratchUser(org.orgId, name, "admin"));
      const applier = await createScratchUser(org.orgId, "Applying manager", "manager");
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
      await db.execute(sql`update app_roles set permissions='["admin.sandboxes.manage"]'::jsonb where org_id=${org.orgId} and key='manager'`);
      await db.execute(sql`update orgs set settings='{"features":{"scripts":true}}'::jsonb where id=${org.orgId}`);
      if (table === "user_scripts") await db.execute(sql`insert into user_scripts(org_id,name,trigger_point,source,is_active) values(${org.orgId},'Original','before_submit','function main(ctx) { return true; }',false)`);
      if (table === "custom_field_defs") await db.execute(sql`insert into custom_field_defs(org_id,target_table,key,label,field_type) values(${org.orgId},'parties','promotion_test','Original','text')`);
      if (table === "form_layouts") await db.execute(sql`insert into form_layouts(org_id,record_type,name,layout) values(${org.orgId},'vendor_bill','Original','{"schemaVersion":1,"recordType":"vendor_bill","header":[],"lineColumns":[]}'::jsonb)`);
      if (table === "list_views") await db.execute(sql`insert into list_views(org_id,record_type,name,scope,config) values(${org.orgId},'customer','Original','org','{"schemaVersion":1,"recordType":"customer","columns":[],"filters":[],"sort":null,"perPage":25}'::jsonb)`);
      if (table === "saved_reports") await db.execute(sql`insert into saved_reports(org_id,name,path,params,created_by_user_id) values(${org.orgId},'Original','/reports/pnl','{}',${applier})`);
      if (table === "saved_views") await db.execute(sql`insert into saved_views(org_id,slug,name,query,scope,owner_id) values(${org.orgId},'promotion-test','Original','{}','private',${applier})`);
      if (table === "report_definitions") await db.execute(sql`insert into report_definitions(org_id,slug,name,kind,query) values(${org.orgId},'promotion-test','Original','custom','{}')`);
      if (table === "account_groups") await db.execute(sql`insert into account_groups(org_id,dimension,key,name) values(${org.orgId},'cost_pool','promotion_test','Original')`);
      const label = table === "custom_field_defs" ? "label" : "name";
      const tableSql = sql.identifier(table), columnSql = sql.identifier(label);
      sandbox = await createSandbox({ productionOrgId: org.orgId, name: "Domain authority", tier: "full", masked: false });
      await db.execute(sql`update ${tableSql} set ${columnSql}='Promoted' where org_id=${sandbox.sandboxOrgId}`);
      const change = await buildChangeSet(sandbox.sandboxId, "Domain authority", actors[0]);
      await reviewChangeSet(change.changeSetId, actors[1]);
      await approveChangeSet(change.changeSetId, actors[2]);
      await assert.rejects(applyChangeSet(change.changeSetId, applier), new RegExp(`requires ${permission.replaceAll('.', '\\.')}`));
      assert.equal((await db.execute(sql`select ${columnSql} as value from ${tableSql} where org_id=${org.orgId}`)).rows[0]!.value, "Original");
      assert.equal((await db.execute(sql`select status from change_sets where id=${change.changeSetId}`)).rows[0]!.status, "approved");
      await db.execute(sql`update app_roles set permissions=${JSON.stringify(["admin.sandboxes.manage", permission])}::jsonb where org_id=${org.orgId} and key='manager'`);
      await applyChangeSet(change.changeSetId, applier);
      assert.equal((await db.execute(sql`select ${columnSql} as value from ${tableSql} where org_id=${org.orgId}`)).rows[0]!.value, "Promoted");
    } finally {
      if (sandbox) await deleteSandbox(sandbox.sandboxId);
      await dropScratchOrgReporting(org.orgId);
    }
  });
}
