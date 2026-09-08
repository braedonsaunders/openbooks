import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { db } from "../db.ts";
import { createScratchOrg, dropScratchOrgReporting } from "../test-fixtures.ts";
import { createSandbox, deleteSandbox, refreshSandbox, resetSandbox } from "./lifecycle.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
const immutable = (error: unknown) => {
  const value = error as { message?: string; cause?: { message?: string } };
  return `${value.message} ${value.cause?.message}`.includes("published project financial profile versions are immutable");
};

for (const operation of ["delete", "refresh", "reset"] as const) {
  test(`sandbox ${operation} preserves production financial policy history`, enabled, async () => {
    const org = await createScratchOrg();
    let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
    try {
      const type = randomUUID();
      const profile = BUILTIN_PROJECT_TYPES.find(p => p.key === "schedule_of_values")!;
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values(${type},${org.orgId},'sandbox_policy','Sandbox policy','fixed_price',${JSON.stringify(profile.invoicingProfile)}::jsonb,${JSON.stringify(profile.backupProfile)}::jsonb)`);
      await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
        values(${org.orgId},${type},'2000-01-01',${JSON.stringify(profile.financialProfile)}::jsonb,'Scratch sandbox policy')`);
      const before = (await db.execute(sql`select to_jsonb(v) as value from project_financial_profile_versions v where org_id=${org.orgId}`)).rows;
      sandbox = await createSandbox({ productionOrgId: org.orgId, name: "Scratch financial policy sandbox", tier: "full", masked: false });
      assert.equal((await db.execute(sql`select id from project_financial_profile_versions where org_id=${sandbox.sandboxOrgId}`)).rows.length, 1);
      // The teardown flag alone cannot unlock production history, and cannot
      // turn a sandbox teardown exception into permission to edit policy.
      for (const target of [org.orgId, sandbox.sandboxOrgId]) {
        await assert.rejects(db.transaction(async tx => {
          await tx.execute(sql`select set_config('openbooks.sandbox_wipe','on',true)`);
          await tx.execute(sql`update project_financial_profile_versions set reason='Unauthorized edit' where org_id=${target}`);
        }), immutable);
      }
      await assert.rejects(db.transaction(async tx => {
        await tx.execute(sql`select set_config('openbooks.sandbox_wipe','on',true)`);
        await tx.execute(sql`delete from project_financial_profile_versions where org_id=${org.orgId}`);
      }), immutable);
      await assert.rejects(db.execute(sql`delete from project_financial_profile_versions where org_id=${sandbox.sandboxOrgId}`), immutable);
      if (operation === "refresh") await refreshSandbox(sandbox.sandboxId);
      else if (operation === "reset") await resetSandbox(sandbox.sandboxId);
      if (operation !== "delete") {
        assert.equal((await db.execute(sql`select id from project_financial_profile_versions where org_id=${sandbox.sandboxOrgId}`)).rows.length, 1);
        assert.equal((await db.execute(sql`select status from sandboxes where id=${sandbox.sandboxId}`)).rows[0]!.status, "ready");
      }
      await deleteSandbox(sandbox.sandboxId);
      assert.equal((await db.execute(sql`select id from orgs where id=${sandbox.sandboxOrgId}`)).rows.length, 0);
      assert.deepEqual((await db.execute(sql`select to_jsonb(v) as value from project_financial_profile_versions v where org_id=${org.orgId}`)).rows, before);
    } finally {
      if (sandbox) await dropScratchOrgReporting(sandbox.sandboxOrgId);
      await dropScratchOrgReporting(org.orgId);
    }
  });
}
