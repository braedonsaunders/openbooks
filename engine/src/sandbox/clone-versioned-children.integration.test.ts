import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "a clone copies the targets of a published allocation rule version that live writes cannot change",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const bookId = randomUUID();
    const departmentId = randomUUID();
    const ruleId = randomUUID();
    const versionId = randomUUID();
    let sandboxId: string | null = null;
    try {
      await withOrgContext(org.orgId, async () => {
        await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl)
          values(${bookId},${org.orgId},'ALLOC','Allocation book',false,true,true)`);
        await db.execute(sql`insert into departments(id,org_id,name,is_active)
          values(${departmentId},${org.orgId},'Target department',true)`);
        await db.execute(sql`insert into allocation_rules
          (id,org_id,key,name,mode,sort_order,is_active,is_system,current_version_id)
          values(${ruleId},${org.orgId},'clone-attribution','Clone attribution','post',100,true,false,null)`);
        await db.execute(sql`insert into allocation_rule_versions
          (id,org_id,rule_id,version_no,status,effective_from,definition_hash,book_scope,book_ids,document_kinds,
           account_scope,dimension_filters,basis_kind,driver_id,driver_as_of,target_kind,impact,offset_account_id,residual_policy)
          values(${versionId},${org.orgId},${ruleId},1,'draft','2026-01-01',null,'books',
            ${JSON.stringify([bookId])}::jsonb,'["vendor_bill"]'::jsonb,
            ${JSON.stringify({ kind: "accounts", accountIds: [org.accounts.cogs] })}::jsonb,
            '{}'::jsonb,'fixed_percent',null,'period','explicit','net_zero_pair',null,'largest_share')`);
        await db.execute(sql`insert into allocation_rule_targets
          (org_id,version_id,sequence,department_id,fixed_percent,is_remainder)
          values(${org.orgId},${versionId},1,${departmentId},'100',false)`);
        const published = await db.execute<{ id: string }>(
          sql`update allocation_rule_versions set status='published',definition_hash='clone-attribution'
            where org_id=${org.orgId} and id=${versionId} and status='draft' returning id`,
          "objects",
        );
        assert.equal(published.length, 1);
        await assert.rejects(
          db.execute(sql`insert into allocation_rule_targets
            (org_id,version_id,sequence,department_id,fixed_percent,is_remainder)
            values(${org.orgId},${versionId},2,${departmentId},'0',true)`),
          (err: unknown) =>
            /its targets are immutable/.test(
              String((err as { cause?: { message?: string } }).cause?.message ?? err),
            ),
        );
      });

      const created = await createSandbox({
        productionOrgId: org.orgId,
        name: `Versioned children ${randomUUID()}`,
        tier: "full",
        masked: false,
      });
      sandboxId = created.sandboxId;
      const copied = await db.execute<{ status: string; targets: number }>(
        sql`
        select v.status, (select count(*)::int from allocation_rule_targets t
                           where t.org_id = v.org_id and t.version_id = v.id) as targets
          from allocation_rule_versions v
         where v.org_id = ${created.sandboxOrgId}`,
        "objects",
      );
      assert.deepEqual(copied, [{ status: "published", targets: 1 }]);
    } finally {
      if (sandboxId) await deleteSandbox(sandboxId);
      await dropScratchOrg(org.orgId);
    }
  },
);
