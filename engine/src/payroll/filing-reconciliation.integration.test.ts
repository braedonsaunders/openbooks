import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { calculatedRun, seedAdoption } from "./filing-test-fixtures.ts";
import { createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { commitPayRun } from "./run-commit.ts";
import { reconcilePayrollFilingAccounts } from "./filing-reconciliation.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const evidence = {
  reason: "Reviewed original payroll register",
  reference: "archive/payroll/2026-07",
};

type TwoEntityFixture = {
  orgId: string;
  adminId: string;
  rootId: string;
  entityB: string;
  stubA: string;
  stubB: string;
  accountA: string;
  accountB: string;
  restrictedId: string;
};

/**
 * Two entities, one committed legacy run each, three filing accounts (pinned
 * to A, pinned to B, org-wide), and an actor with payroll.manage scoped to
 * entity A only.
 */
async function seedTwoEntities(): Promise<TwoEntityFixture> {
  const fx = await seedAdoption();
  const entityB = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${entityB}, ${fx.orgId}, ${fx.subsidiaryId}, 'Entity B', 'CAD', 'CA')`);
  const scheduleB = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, subsidiary_id, is_active, created_by, updated_by)
    values (${scheduleB}, ${fx.orgId}, 'B schedule', 'biweekly', 26, '2026-07-18', 3,
            ${entityB}, true, ${fx.actorId}, ${fx.actorId})`);
  const employeeB = randomUUID();
  // Brenda belongs to entity B: a pinned schedule only rosters employees
  // whose party subsidiary matches.
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${employeeB}, ${fx.orgId}, 'person', 'Brenda Worker', ${entityB}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (org_id, party_id, hired_on, is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeB}, '2020-01-06', true, ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                  is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeB}, 'CAD', '30', 'hour', '2020-01-01', true,
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                           pay_basis, country, federal_claim_code,
                                           provincial_claim_code, vacation_percent, vacation_method,
                                           is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeB}, ${scheduleB}, 'ON', 'hourly', 'CA', 1, 1,
            '4', 'accrue', true, ${fx.actorId}, ${fx.actorId})`);

  // Entity A's run through the shared adoption helper, entity B's on its own
  // pinned schedule (a different schedule, so the same period may repeat).
  const { input: runA } = await calculatedRun(fx);
  await commitPayRun(runA);
  await db.execute(sql`
    insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
                              is_billable, billing_status, costing_basis, created_by, updated_by)
    values (${fx.orgId}, ${employeeB}, '2026-07-15', 8, 'approved', false,
            'unbilled', 'actual', ${fx.actorId}, ${fx.actorId})`);
  const runB = await createPayRun({
    orgId: fx.orgId,
    actorId: fx.actorId,
    payScheduleId: scheduleB,
    periodStart: "2026-07-05",
    periodEnd: "2026-07-18",
  });
  assert.deepEqual(
    (await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: runB.documentId })).errors,
    [],
  );
  await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: runB.documentId });

  // Both runs become legacy attribution work.
  await db.transaction(async (tx) => {
    await tx.execute(sql`alter table pay_stubs disable trigger pay_stub_filing_account_guard`);
    await tx.execute(sql`update pay_stubs set filing_account_id = null,
      filing_account_source = 'unknown', filing_account_evidence = null
      where org_id = ${fx.orgId}`);
    await tx.execute(sql`alter table pay_stubs enable trigger pay_stub_filing_account_guard`);
  });
  const stubs = (await db.execute<{ id: string; subsidiary_id: string | null }>(sql`
    select s.id, d.subsidiary_id
      from pay_stubs s
      join documents d on d.org_id = s.org_id and d.id = s.pay_run_document_id
     where s.org_id = ${fx.orgId}`)).rows;
  assert.equal(stubs.length, 2);
  const stubA = stubs.find((s) => s.subsidiary_id === fx.subsidiaryId)!.id;
  const stubB = stubs.find((s) => s.subsidiary_id === entityB)!.id;

  const accountA = randomUUID();
  const accountB = randomUUID();
  await db.execute(sql`
    insert into payroll_filing_accounts (id, org_id, country, program_type, account_number, name, subsidiary_id, is_default)
    values (${accountA}, ${fx.orgId}, 'CA', 'ca_rp', '111111111RP0001', 'Entity A program', ${fx.subsidiaryId}, true),
           (${accountB}, ${fx.orgId}, 'CA', 'ca_rp', '222222222RP0001', 'Entity B program', ${entityB}, false)`);

  const restrictedId = await createScratchUser(fx.orgId, "Entity A reconciler", "entity_a_reconciler");
  await db.execute(sql`
    update app_roles set permissions = '["payroll.manage"]'::jsonb,
      subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [fx.subsidiaryId] })}::jsonb
     where org_id = ${fx.orgId} and key = 'entity_a_reconciler'`);

  return {
    orgId: fx.orgId, adminId: fx.actorId, rootId: fx.subsidiaryId, entityB,
    stubA, stubB, accountA, accountB, restrictedId,
  };
}

async function stubSource(orgId: string, stubId: string) {
  return (await db.execute<{ source: string; account: string | null }>(sql`
    select filing_account_source as source, filing_account_id as account
      from pay_stubs where org_id = ${orgId} and id = ${stubId}`)).rows[0]!;
}

async function auditCount(orgId: string, stubId: string) {
  return (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log where org_id = ${orgId}
     and table_name = 'pay_stubs' and row_id = ${stubId}
     and changes ->> 'operation' = 'reconcile_filing_account'`)).rows[0]!.n;
}

test("a restricted actor cannot rewrite another entity's filing history", { skip: !DB }, async () => {
  const fx = await seedTwoEntities();
  try {
    // Entity B's stub with Entity B's own account: the account is right, the
    // actor is not — the refusal is the scope check, and it must land before
    // any write or audit evidence.
    await assert.rejects(
      reconcilePayrollFilingAccounts({
        orgId: fx.orgId,
        actorId: fx.restrictedId,
        rows: [{ stubId: fx.stubB, filingAccountId: fx.accountB, ...evidence }],
      }),
      /not visible in this organization and legal-entity scope/,
    );
    assert.equal((await stubSource(fx.orgId, fx.stubB)).source, "unknown");
    assert.equal((await stubSource(fx.orgId, fx.stubB)).account, null);
    assert.equal(await auditCount(fx.orgId, fx.stubB), 0);
    // Positive control: the same actor reconciles the entity it can see.
    assert.equal(
      await reconcilePayrollFilingAccounts({
        orgId: fx.orgId,
        actorId: fx.restrictedId,
        rows: [{ stubId: fx.stubA, filingAccountId: fx.accountA, ...evidence }],
      }),
      1,
    );
  } finally {
    await dropScratchOrgReporting(fx.orgId);
  }
});
