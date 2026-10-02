import {
  seedPayrollSchedule, seedPayrollEmployeeRole, seedPayrollPerson, seedPayrollTime, seedPayrollProfile, seedPayrollWage,
  createScratchUser, dropScratchOrgReporting, seedWorkerEmployment,
} from "../testing/fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { calculatedRun, seedAdoption } from "./filing-test-fixtures.ts";
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
  rootName: string;
  entityB: string;
  stubA: string;
  stubB: string;
  accountA: string;
  accountB: string;
  accountOrg: string;
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
  await seedPayrollSchedule(fx.orgId, scheduleB, fx.actorId, {
    name: 'B schedule', frequency: 'biweekly', periodsPerYear: 26, anchorPeriodEnd: '2026-07-18',
    payDateOffsetDays: 3, subsidiaryId: entityB,
  });
  const employeeB = randomUUID();
  // Brenda belongs to entity B: a pinned schedule only rosters employees
  // whose party subsidiary matches.
  await seedPayrollPerson(fx.orgId, employeeB, 'Brenda Worker', {
    subsidiaryId: entityB,
  });
  await seedPayrollEmployeeRole(fx.orgId, employeeB, { hiredOn: '2020-01-06', isActive: true, createdBy: fx.actorId, updatedBy: fx.actorId });
  const employmentB = await seedWorkerEmployment(fx.orgId, employeeB, entityB);
  await seedPayrollWage(fx.orgId, employeeB, fx.actorId, {
    currency: 'CAD', rate: '30', basis: 'hour', effectiveFrom: '2020-01-01',
  });
  await seedPayrollProfile(fx.orgId, employeeB, employmentB, scheduleB, fx.actorId, {
    province: 'ON', payBasis: 'hourly', country: 'CA', federalClaimCode: 1, provincialClaimCode: 1,
  }, { percentFloor: '4', method: 'accrue' });


  // Entity A's run through the shared adoption helper, entity B's on its own
  // pinned schedule (a different schedule, so the same period may repeat).
  const { input: runA } = await calculatedRun(fx);
  await commitPayRun(runA);
  await seedPayrollTime(fx.orgId, employeeB, fx.actorId, {
    workedOn: '2026-07-15', hours: 8, status: 'approved', isBillable: false, billingStatus: 'unbilled',
    costingBasis: 'actual',
  });
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
  const accountOrg = randomUUID();
  await db.execute(sql`
    insert into payroll_filing_accounts (id, org_id, country, program_type, account_number, name, subsidiary_id, is_default)
    values (${accountA}, ${fx.orgId}, 'CA', 'ca_rp', '111111111RP0001', 'Entity A program', ${fx.subsidiaryId}, true),
           (${accountB}, ${fx.orgId}, 'CA', 'ca_rp', '222222222RP0001', 'Entity B program', ${entityB}, false),
           (${accountOrg}, ${fx.orgId}, 'CA', 'ca_rp', '333333333RP0001', 'Org-wide program', null, false)`);

  const restrictedId = await createScratchUser(fx.orgId, "Entity A reconciler", "entity_a_reconciler");
  await db.execute(sql`
    update app_roles set permissions = '["payroll.manage"]'::jsonb,
      subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [fx.subsidiaryId] })}::jsonb
     where org_id = ${fx.orgId} and key = 'entity_a_reconciler'`);

  const rootName = (await db.execute<{ name: string }>(sql`
    select name from subsidiaries where org_id = ${fx.orgId} and id = ${fx.subsidiaryId}`)).rows[0]!.name;
  return {
    orgId: fx.orgId, adminId: fx.actorId, rootId: fx.subsidiaryId, rootName, entityB,
    stubA, stubB, accountA, accountB, accountOrg, restrictedId,
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

test("a filing account from the wrong legal entity refuses before the update", { skip: !DB }, async () => {
  const fx = await seedTwoEntities();
  try {
    // An account the org does not hold refuses by name (not a raw FK error),
    // naming the unknown id so the preflight row stays visible.
    const unknownAccount = randomUUID();
    await assert.rejects(
      reconcilePayrollFilingAccounts({
        orgId: fx.orgId,
        actorId: fx.adminId,
        rows: [{ stubId: fx.stubA, filingAccountId: unknownAccount, ...evidence }],
      }),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.ok(message.includes(unknownAccount), `refusal names ${unknownAccount}: ${message}`);
        return true;
      },
    );
    await assert.rejects(
      reconcilePayrollFilingAccounts({
        orgId: fx.orgId,
        actorId: fx.adminId,
        rows: [{ stubId: fx.stubA, filingAccountId: fx.accountB, ...evidence }],
      }),
      (error: unknown) => {
        const message = (error as Error).message;
        for (const expected of ["222222222RP0001", "Entity B", fx.rootName]) {
          assert.ok(message.includes(expected), `refusal names ${expected}: ${message}`);
        }
        return true;
      },
    );
    // The stub stays unknown with no audit: the one-time guard must still
    // allow the correct attribution afterwards.
    assert.equal((await stubSource(fx.orgId, fx.stubA)).source, "unknown");
    assert.equal(await auditCount(fx.orgId, fx.stubA), 0);
    assert.equal(
      await reconcilePayrollFilingAccounts({
        orgId: fx.orgId,
        actorId: fx.adminId,
        rows: [{ stubId: fx.stubA, filingAccountId: fx.accountA, ...evidence }],
      }),
      1,
    );
    // An org-wide account stays usable on any entity's stub.
    assert.equal(
      await reconcilePayrollFilingAccounts({
        orgId: fx.orgId,
        actorId: fx.adminId,
        rows: [{ stubId: fx.stubB, filingAccountId: fx.accountOrg, ...evidence }],
      }),
      1,
    );
  } finally {
    await dropScratchOrgReporting(fx.orgId);
  }
});
