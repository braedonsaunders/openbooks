import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../../testing/fixtures.ts";
import { provisionPayrollPackDefaults } from "../run-setup.ts";

test("installed Canada defaults are audited, isolated and preserve configured rates and later edits", {
  skip: !process.env.OPENBOOKS_DB_URL,
}, async () => {
  const org = await createScratchOrg();
  const other = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  try {
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{payroll}', '{"countries":["CA"]}') where id = ${org.orgId}`);
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{payroll}', '{"countries":["US"]}') where id = ${other.orgId}`);
    const component = async (orgId: string, country: string | null) => {
      const id = randomUUID();
      await db.execute(sql`insert into pay_components (id, org_id, code, name, kind, taxable, country)
        values (${id}, ${orgId}, ${id}, 'Non-taxable allowance', 'earning', false, ${country})`);
      return id;
    };
    const shared = await component(org.orgId, null);
    const foreign = await component(org.orgId, "US");
    const otherShared = await component(other.orgId, null);
    const filing = async (suffix: string) => {
      const id = randomUUID();
      await db.execute(sql`insert into payroll_filing_accounts
        (id, org_id, country, program_type, account_number, name, created_at)
        values (${id}, ${org.orgId}, 'CA', 'ca_rp', ${suffix}, ${suffix}, '2026-01-01')`);
      return id;
    };
    const standard = await filing("111111111RP0001");
    const reduced = await filing("111111111RP0002");
    await db.execute(sql`insert into payroll_employer_facts
      (org_id, filing_account_id, country, fact_key, effective_from, value_kind, fact_value, value_scale, change_reason)
      values (${org.orgId}, ${reduced}, 'CA', 'ei_employer_multiplier', '2026-08-01', 'decimal', '1.1670', 4, 'Approved reduced rate')`);
    await Promise.all([
      provisionPayrollPackDefaults(org.orgId, actorId),
      provisionPayrollPackDefaults(org.orgId, actorId),
    ]);
    await provisionPayrollPackDefaults(other.orgId);
    const exclusions = async (id: string) => (await db.execute<{ program_exclusions: string[] }>(
      sql`select program_exclusions from pay_components where id = ${id}`,
    )).rows[0]!.program_exclusions;
    assert.deepEqual(await exclusions(shared), ["cnt", "eht", "hsf", "wcb"]);
    assert.deepEqual(await exclusions(foreign), []);
    assert.deepEqual(await exclusions(otherShared), []);
    const facts = (await db.execute<{ filing_account_id: string; fact_value: string; effective_from: string }>(sql`
      select filing_account_id, fact_value, effective_from::text from payroll_employer_facts
       where org_id = ${org.orgId} order by filing_account_id
    `)).rows;
    assert.equal(facts.length, 2);
    assert.deepEqual(facts.find(row => row.filing_account_id === standard), {
      filing_account_id: standard, fact_value: "1.4000", effective_from: "2026-01-01",
    });
    assert.deepEqual(facts.find(row => row.filing_account_id === reduced), {
      filing_account_id: reduced, fact_value: "1.1670", effective_from: "2026-08-01",
    });
    const audits = (await db.execute<{ table_name: string; actor_id: string; changes: Record<string, unknown> }>(sql`
      select table_name, actor_id, changes from audit_log
       where org_id = ${org.orgId} and (row_id = ${shared} or table_name = 'payroll_employer_facts')
    `)).rows;
    assert.equal(audits.length, 2);
    assert.ok(audits.every(row => row.actor_id === actorId && row.changes.before !== undefined && row.changes.after !== undefined && row.changes.reason));
    await db.execute(sql`update pay_components set program_exclusions = '{}' where org_id = ${org.orgId} and id = ${shared}`);
    await provisionPayrollPackDefaults(org.orgId, actorId);
    assert.deepEqual(await exclusions(shared), [], "a later explicit assessability choice remains authoritative");
    assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from payroll_employer_facts where org_id = ${org.orgId}`)).rows[0]!.count, 2);
  } finally {
    await dropScratchOrgReporting(other.orgId);
    await dropScratchOrgReporting(org.orgId);
  }
});
