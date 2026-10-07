import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withMaintenanceTransaction, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { createSandbox, deleteSandbox, refreshSandbox } from "./lifecycle.ts";

test("full clone and refresh retain original inactive sales references without permitting new assignments", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const name = `Historical sales references ${randomUUID()}`;
  const employeeId = randomUUID(), otherEmployeeId = randomUUID(), prospectId = randomUUID(), profileId = randomUUID();
  let actorId: string | null = null;
  try {
    actorId = await createScratchUser(org.orgId, "Sandbox sales owner", "admin");
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values
      (${employeeId},${org.orgId},'employee','Original sales representative',${org.subsidiaryId}),
      (${otherEmployeeId},${org.orgId},'employee','Other sales representative',${org.subsidiaryId}),
      (${prospectId},${org.orgId},'company','Unassigned sales prospect',${org.subsidiaryId})`);
    for (const id of [employeeId, otherEmployeeId]) {
      await db.execute(sql`insert into employee_roles(org_id,party_id,is_sales_rep,sales_rep_since)
        values(${org.orgId},${id},true,'2020-01-01')`);
    }
    await db.execute(sql`insert into crm_account_profiles(id,org_id,party_id,lifecycle_stage,sales_rep_id,custom)
      values(${profileId},${org.orgId},${org.customerId},'customer',${employeeId},'{"reference":"retained assignment"}'::jsonb)`);
    // The account keeps its historical designation; it is not an active
    // customer-role assignment that would prevent native employee retirement.
    await db.execute(sql`update employee_roles set is_active=false where org_id=${org.orgId} and party_id in (${employeeId},${otherEmployeeId})`);
    await db.execute(sql`update parties set is_active=false where org_id=${org.orgId} and id in (${employeeId},${otherEmployeeId})`);
    const source = async () => (await db.execute(sql`select to_jsonb(c) as profile,to_jsonb(e) as role,to_jsonb(p) as person
      from crm_account_profiles c join employee_roles e on e.org_id=c.org_id and e.party_id=c.sales_rep_id
      join parties p on p.org_id=e.org_id and p.id=e.party_id where c.org_id=${org.orgId} and c.id=${profileId}`)).rows;
    const before = await source();
    const created = await withOrgContext(org.orgId, () => createSandbox({
      productionOrgId: org.orgId, name, tier: "full", masked: false, createdBy: actorId,
      lifecycleAuthority: { actorId: actorId! },
    }));
    const target = created.sandboxOrgId;
    const identities = (await db.execute<{ employee: string; other_employee: string; prospect: string; customer: string; profile: string }>(sql`
      select ob_rebase(${employeeId}::uuid,sandbox_seed) as employee,ob_rebase(${otherEmployeeId}::uuid,sandbox_seed) as other_employee,
        ob_rebase(${prospectId}::uuid,sandbox_seed) as prospect,ob_rebase(${org.customerId}::uuid,sandbox_seed) as customer,
        ob_rebase(${profileId}::uuid,sandbox_seed) as profile from orgs where id=${target}
    `)).rows[0]!;
    const copied = async () => (await db.execute(sql`select c.id,c.party_id,c.sales_rep_id,
        to_jsonb(c)-'id'-'org_id'-'party_id'-'sales_rep_id' as evidence,
        e.is_active as employee_active,e.is_sales_rep,e.sales_rep_since::text,p.is_active as person_active
      from crm_account_profiles c join employee_roles e on e.org_id=c.org_id and e.party_id=c.sales_rep_id
      join parties p on p.org_id=e.org_id and p.id=e.party_id where c.org_id=${target}`)).rows;
    const assertCopy = async () => {
      const rows = await copied();
      const evidence = (await db.execute(sql`select to_jsonb(c)-'id'-'org_id'-'party_id'-'sales_rep_id' as evidence
        from crm_account_profiles c where c.org_id=${org.orgId} and c.id=${profileId}`)).rows[0]!.evidence;
      assert.deepEqual(rows, [{ id: identities.profile, party_id: identities.customer, sales_rep_id: identities.employee,
        evidence, employee_active: false, is_sales_rep: true, sales_rep_since: "2020-01-01", person_active: false }]);
      assert.notEqual(identities.employee, employeeId);
      assert.equal((await db.execute<{ status: string }>(sql`select status from sandboxes where id=${created.sandboxId}`)).rows[0]!.status, "ready");
      assert.deepEqual(await source(), before, "cloning never changes original sales or employment evidence");
    };
    await assertCopy();
    const designation = /Select an active employee designated as a sales representative in Sales/;
    for (const [query, scope, privileged] of [
      [sql`insert into crm_account_profiles(org_id,party_id,sales_rep_id) values(${target},${identities.prospect},${identities.employee})`, target, false],
      [sql`insert into crm_account_profiles(org_id,party_id,sales_rep_id) values(${org.orgId},${prospectId},${employeeId})`, org.orgId, true],
      [sql`insert into crm_account_profiles(org_id,party_id,sales_rep_id) values(${target},${identities.prospect},${identities.employee})`, target, true],
      [sql`update crm_account_profiles set sales_rep_id=${identities.other_employee} where org_id=${target} and id=${identities.profile}`, target, true],
    ] as const) {
      const write = async () => {
        await db.execute(sql`select set_config('openbooks.clone','on',true),set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true)`);
        assert.equal((await db.execute<{ allowed: boolean }>(sql`select openbooks_clone_authority() as allowed`)).rows[0]!.allowed, privileged);
        await db.execute(query);
      };
      await assert.rejects(privileged ? withMaintenanceTransaction(null, write) : withOrgTransaction(scope, write),
        error => errorChainMatches(error, designation));
      await assertCopy();
    }
    // Even privileged clone flags cannot substitute another employee on the
    // same source row. The refused transaction restores the copied row.
    await assert.rejects(withMaintenanceTransaction(null, async () => {
      await db.execute(sql`select set_config('openbooks.clone','on',true),set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true)`);
      await db.execute(sql`delete from crm_account_profiles where org_id=${target} and id=${identities.profile}`);
      await db.execute(sql`insert into crm_account_profiles(id,org_id,party_id,sales_rep_id)
        values(${identities.profile},${target},${identities.customer},${identities.other_employee})`);
    }), error => errorChainMatches(error, designation));
    await assertCopy();
    await withOrgContext(org.orgId, () => refreshSandbox(created.sandboxId, { keepCustomizations: false, authority: { actorId: actorId! } }));
    await assertCopy();
  } finally {
    const rows = (await db.execute<{ id: string }>(sql`select id from sandboxes where production_org_id=${org.orgId} and name=${name}`)).rows;
    for (const row of rows) await deleteSandbox(row.id, { systemReason: "Remove historical sales clone fixture" });
    await dropScratchOrgReporting(org.orgId);
  }
});
