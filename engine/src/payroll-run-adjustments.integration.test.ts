import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { PayrollError } from "./payroll-error.ts";
import { mutatePayRunAdjustment } from "./payroll-run-adjustments.ts";
import { createPayRun, seedPayrollComponents } from "./payroll-run.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function payrollFixture(label: string) {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  // The pay-run pipeline is feature-gated (engine/src/payroll-run.ts
  // createPayRun); every other gated payroll fixture enables it the same way.
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      features: { payroll: true },
    })}::jsonb where id = ${org.orgId}`);
  await seedPayrollComponents(org.orgId, actorId, "CA");
  const employeeId = randomUUID();
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${org.orgId}, 'person', ${`${label} Employee`}, true, '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into pay_schedules
      (id, org_id, name, frequency, periods_per_year, anchor_period_end,
       pay_date_offset_days, is_active, created_by, updated_by)
    values
      (${scheduleId}, ${org.orgId}, ${`${label} Schedule`}, 'biweekly', 26, '2026-07-18',
       3, true, ${actorId}, ${actorId})
  `);
  await db.execute(sql`
    insert into employee_payroll_profiles
      (org_id, employee_party_id, pay_schedule_id, province, pay_basis,
       federal_claim_code, provincial_claim_code, is_active, created_by, updated_by)
    values
      (${org.orgId}, ${employeeId}, ${scheduleId}, 'ON', 'salary', 1, 1, true,
       ${actorId}, ${actorId})
  `);
  const run = await createPayRun({
    orgId: org.orgId,
    actorId,
    payScheduleId: scheduleId,
    periodStart: "2026-07-05",
    periodEnd: "2026-07-18",
  });
  const component = (await db.execute<{ id: string }>(sql`
    select id from pay_components where org_id = ${org.orgId} and code = 'BONUS'
  `));
  return {
    orgId: org.orgId,
    actorId,
    employeeId,
    scheduleId,
    documentId: run.documentId,
    componentId: component.rows[0]!.id,
  };
}

test("pay-run adjustment mutations enforce tenant, schedule membership, and calculation invalidation", { skip: !DB }, async () => {
  const a = await payrollFixture("Alpha");
  const b = await payrollFixture("Beta");
  try {
    await db.execute(sql`
      update pay_runs set run_status = 'calculated', gross_total = 125, net_total = 100,
             employer_cost_total = 25, employee_count = 1, calculated_at = now()
       where org_id = ${a.orgId} and document_id = ${a.documentId}
    `);
    await mutatePayRunAdjustment({
      orgId: a.orgId,
      documentId: a.documentId,
      actorId: a.actorId,
      mutation: {
        action: "add",
        employeePartyId: a.employeeId,
        componentId: a.componentId,
        amount: "125.00",
        note: "Approved one-off",
      },
    });
    const reset = (await db.execute<Record<string, unknown>>(sql`
      select run_status, gross_total, net_total, employer_cost_total, employee_count, calculated_at
        from pay_runs where org_id = ${a.orgId} and document_id = ${a.documentId}
    `));
    assert.deepEqual(reset.rows[0], {
      run_status: "draft",
      gross_total: "0.0000",
      net_total: "0.0000",
      employer_cost_total: "0.0000",
      employee_count: 0,
      calculated_at: null,
    });

    // A cross-tenant add is refused with the employee's id echoed, so the
    // operator can tell whose row failed on a large roster.
    await assert.rejects(
      mutatePayRunAdjustment({
        orgId: a.orgId,
        documentId: a.documentId,
        actorId: a.actorId,
        mutation: { action: "add", employeePartyId: b.employeeId, componentId: a.componentId, amount: "1.00" },
      }),
      new RegExp(`employee "${b.employeeId}" is not an active member.*no employee with that id`),
    );
    await assert.rejects(
      mutatePayRunAdjustment({
        orgId: a.orgId,
        documentId: a.documentId,
        actorId: a.actorId,
        mutation: { action: "add", employeePartyId: a.employeeId, componentId: b.componentId, amount: "1.00" },
      }),
      /component cannot be adjusted/,
    );

    const otherScheduleId = randomUUID();
    const otherEmployeeId = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${otherEmployeeId}, ${a.orgId}, 'person', 'Other Schedule Employee', true, '{}'::jsonb)
    `);
    await db.execute(sql`
      insert into pay_schedules
        (id, org_id, name, frequency, periods_per_year, anchor_period_end,
         pay_date_offset_days, is_active, created_by, updated_by)
      values
        (${otherScheduleId}, ${a.orgId}, 'Other Schedule', 'monthly', 12, '2026-07-31',
         3, true, ${a.actorId}, ${a.actorId})
    `);
    await db.execute(sql`
      insert into employee_payroll_profiles
        (org_id, employee_party_id, pay_schedule_id, province, pay_basis,
         federal_claim_code, provincial_claim_code, is_active, created_by, updated_by)
      values
        (${a.orgId}, ${otherEmployeeId}, ${otherScheduleId}, 'ON', 'salary', 1, 1, true,
         ${a.actorId}, ${a.actorId})
    `);
    // Excluding someone who was never on this run's schedule is still
    // refused — and the refusal names them, so a roster of up to 2000 does
    // not leave the operator guessing which member failed.
    await assert.rejects(
      mutatePayRunAdjustment({
        orgId: a.orgId,
        documentId: a.documentId,
        actorId: a.actorId,
        mutation: { action: "exclude", employeePartyId: otherEmployeeId },
      }),
      /employee "Other Schedule Employee" is not on this run's pay schedule/,
    );

    await mutatePayRunAdjustment({
      orgId: b.orgId,
      documentId: b.documentId,
      actorId: b.actorId,
      mutation: { action: "exclude", employeePartyId: b.employeeId },
    });
    const bAdjustment = (await db.execute<{ id: string }>(sql`
      select id from pay_run_adjustments where org_id = ${b.orgId} and pay_run_document_id = ${b.documentId}
    `));
    await assert.rejects(
      mutatePayRunAdjustment({
        orgId: a.orgId,
        documentId: a.documentId,
        actorId: a.actorId,
        mutation: { action: "delete", adjustmentId: bAdjustment.rows[0]!.id },
      }),
      /pay run adjustment not found/,
    );
    const preserved = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pay_run_adjustments
       where org_id = ${b.orgId} and id = ${bAdjustment.rows[0]!.id}
    `));
    assert.equal(preserved.rows[0]!.n, 1);
  } finally {
    await dropScratchOrgReporting(a.orgId);
    await dropScratchOrgReporting(b.orgId);
  }
});

test("pay-run adjustment mutations serialize with commit and reject every post-commit operation", { skip: !DB }, async () => {
  const fixture = await payrollFixture("Lifecycle");
  try {
    await mutatePayRunAdjustment({
      orgId: fixture.orgId,
      documentId: fixture.documentId,
      actorId: fixture.actorId,
      mutation: {
        action: "add",
        employeePartyId: fixture.employeeId,
        componentId: fixture.componentId,
        amount: "10.00",
      },
    });
    const adjustment = (await db.execute<{ id: string }>(sql`
      select id from pay_run_adjustments
       where org_id = ${fixture.orgId} and pay_run_document_id = ${fixture.documentId}
    `));

    let signalLocked!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const commitWinner = db.transaction(async (tx) => {
      await tx.execute(sql`
        select document_id from pay_runs
         where org_id = ${fixture.orgId} and document_id = ${fixture.documentId}
         for update
      `);
      signalLocked();
      await release;
      await tx.execute(sql`
        update pay_runs set run_status = 'committed'
         where org_id = ${fixture.orgId} and document_id = ${fixture.documentId}
      `);
    });
    await locked;
    const losingMutation = mutatePayRunAdjustment({
      orgId: fixture.orgId,
      documentId: fixture.documentId,
      actorId: fixture.actorId,
      mutation: { action: "exclude", employeePartyId: fixture.employeeId },
    });
    releaseLock();
    await commitWinner;
    await assert.rejects(losingMutation, /pay run is not editable/);

    const operations = [
      { action: "add", employeePartyId: fixture.employeeId, componentId: fixture.componentId, amount: "5.00" } as const,
      { action: "delete", adjustmentId: adjustment.rows[0]!.id } as const,
      { action: "exclude", employeePartyId: fixture.employeeId } as const,
      { action: "include", employeePartyId: fixture.employeeId } as const,
    ];
    for (const mutation of operations) {
      await assert.rejects(
        mutatePayRunAdjustment({
          orgId: fixture.orgId,
          documentId: fixture.documentId,
          actorId: fixture.actorId,
          mutation,
        }),
        /pay run is not editable/,
      );
    }
    const unchanged = (await db.execute<{ adjustment_type: string }>(sql`
      select adjustment_type from pay_run_adjustments
       where org_id = ${fixture.orgId} and pay_run_document_id = ${fixture.documentId}
       order by created_at
    `));
    assert.deepEqual(unchanged.rows, [{ adjustment_type: "line" }]);

    await db.execute(sql`
      update pay_runs set run_status = 'draft'
       where org_id = ${fixture.orgId} and document_id = ${fixture.documentId}
    `);
    await db.execute(sql`
      update documents set status = 'approved'
       where org_id = ${fixture.orgId} and id = ${fixture.documentId}
    `);
    await assert.rejects(
      mutatePayRunAdjustment({
        orgId: fixture.orgId,
        documentId: fixture.documentId,
        actorId: fixture.actorId,
        mutation: { action: "exclude", employeePartyId: fixture.employeeId },
      }),
      /pay run is not editable/,
    );
  } finally {
    await dropScratchOrgReporting(fixture.orgId);
  }
});

test("pay-run adjustments refuse amounts and hours the ledger columns cannot hold", { skip: !DB }, async () => {
  // amount is numeric(19,4) and hours numeric(12,2): an oversized paste died
  // at storage with a driver error, and 4dp hours were silently rounded to
  // the column scale. Fail closed with a named error before any write.
  const fixture = await payrollFixture("Magnitude");
  try {
    const mutations = [
      { action: "add", employeePartyId: fixture.employeeId, componentId: fixture.componentId, amount: "9999999999999999" },
      { action: "add", employeePartyId: fixture.employeeId, componentId: fixture.componentId, amount: "100.00", hours: "9999999999999" },
      { action: "add", employeePartyId: fixture.employeeId, componentId: fixture.componentId, amount: "100.00", hours: "1.2345" },
    ] as const;
    for (const [index, mutation] of mutations.entries()) {
      await assert.rejects(
        mutatePayRunAdjustment({
          orgId: fixture.orgId,
          documentId: fixture.documentId,
          actorId: fixture.actorId,
          mutation: { ...mutation },
        }),
        (error: unknown) =>
          error instanceof PayrollError && /range|decimal places/.test(error.message),
        `adjustment case ${index} should fail closed with a named error`,
      );
    }
    const rows = await db.execute<{ count: string }>(sql`
      select count(*) as count from pay_run_adjustments
       where org_id = ${fixture.orgId} and pay_run_document_id = ${fixture.documentId}`);
    assert.equal(rows.rows[0]!.count, "0");
    // In-range values, including 2dp hours at the column scale, still save.
    await mutatePayRunAdjustment({
      orgId: fixture.orgId,
      documentId: fixture.documentId,
      actorId: fixture.actorId,
      mutation: {
        action: "add",
        employeePartyId: fixture.employeeId,
        componentId: fixture.componentId,
        amount: "100.00",
        hours: "7.50",
      },
    });
    const saved = await db.execute<{ amount: string; hours: string }>(sql`
      select amount::text as amount, hours::text as hours from pay_run_adjustments
       where org_id = ${fixture.orgId} and pay_run_document_id = ${fixture.documentId}`);
    assert.deepEqual(saved.rows[0], { amount: "100.0000", hours: "7.50" });
  } finally {
    await dropScratchOrgReporting(fixture.orgId);
  }
});
