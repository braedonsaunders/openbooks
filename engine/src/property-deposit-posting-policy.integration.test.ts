import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { PropertyManagementError, recordSecurityDeposit } from "./property-management.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

for (const policy of ["bank", "location", "inactive subsidiary", "inactive book", "non-posting book"] as const) {
  test(`security-deposit receipt refuses ${policy} policy violations`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const branchId = randomUUID(), propertyId = randomUUID(), leaseId = randomUUID();
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
        coalesce(settings->'features','{}'::jsonb)||'{"propertyManagement":true}'::jsonb) where id=${org.orgId}`);
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${branchId},${org.orgId},${org.subsidiaryId},'Deposit policy branch','CAD','CA')`);
      await db.execute(sql`insert into managed_properties
        (id,org_id,subsidiary_id,location_id,code,name,property_type,status,currency,rent_income_account_id,deposit_liability_account_id,default_bank_account_id)
        values(${propertyId},${org.orgId},${policy === "inactive subsidiary" ? branchId : org.subsidiaryId},${org.locationId},
          'DEP-POLICY','Deposit policy','commercial','active','CAD',${org.accounts.revenue},${org.accounts.deferred},${org.accounts.bank})`);
      await db.execute(sql`insert into property_leases(id,org_id,property_id,tenant_id,lease_number,status,starts_on)
        values(${leaseId},${org.orgId},${propertyId},${org.customerId},'DEP-POLICY','active',${org.date})`);
      if (policy === "bank") await db.execute(sql`update accounts set subsidiary_id=${branchId},subsidiary_include_children=false
        where org_id=${org.orgId} and id=${org.accounts.bank}`);
      if (policy === "location") await db.execute(sql`update locations set subsidiary_id=${branchId},subsidiary_include_children=false
        where org_id=${org.orgId} and id=${org.locationId}`);
      if (policy === "inactive subsidiary") await db.execute(sql`update subsidiaries set is_active=false
        where org_id=${org.orgId} and id=${branchId}`);
      if (policy === "inactive book") await db.execute(sql`update accounting_books set is_active=false
        where org_id=${org.orgId} and id=${org.bookId}`);
      if (policy === "non-posting book") await db.execute(sql`update accounting_books set posts_gl=false
        where org_id=${org.orgId} and id=${org.bookId}`);
      const run = () => recordSecurityDeposit({orgId:org.orgId,actorId,leaseId,occurredOn:org.date,kind:"received",amount:"100"});
      await assert.rejects(run(), (error: unknown) => {
        assert.ok(error instanceof PropertyManagementError);
        assert.match(error.message, policy === "bank" || policy === "location" ? /restricted to another subsidiary/
          : policy === "inactive subsidiary" ? /inactive/ : /active primary posting book/);
        return true;
      });
      const counts = (await db.execute<{ journals: number; deposits: number }>(sql`
        select (select count(*)::int from journal_entries where org_id=${org.orgId}) as journals,
          (select count(*)::int from security_deposit_transactions where org_id=${org.orgId}) as deposits`)).rows[0]!;
      assert.deepEqual(counts,{journals:0,deposits:0});
      await db.execute(sql`update accounts set subsidiary_id=${org.subsidiaryId},subsidiary_include_children=true
        where org_id=${org.orgId} and id=${org.accounts.bank}`);
      await db.execute(sql`update locations set subsidiary_id=${org.subsidiaryId},subsidiary_include_children=true
        where org_id=${org.orgId} and id=${org.locationId}`);
      await db.execute(sql`update subsidiaries set is_active=true where org_id=${org.orgId} and id=${branchId}`);
      await db.execute(sql`update accounting_books set is_active=true,posts_gl=true where org_id=${org.orgId} and id=${org.bookId}`);
      assert.equal((await run()).balance,"100.0000");
    } finally { await dropScratchOrg(org.orgId); }
  });
}
