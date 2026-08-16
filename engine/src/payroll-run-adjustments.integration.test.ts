import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { mutatePayRunAdjustment } from "./payroll-run-adjustments.ts";
import { createPayRun, seedPayrollComponents } from "./payroll-run.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function payrollFixture(label: string) {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
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
  const component = (await db.execute(sql`
    select id from pay_components where org_id = ${org.orgId} and code = 'BONUS'
  `)) as unknown as { rows: { id: string }[] };
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
    const reset = (await db.execute(sql`
      select run_status, gross_total, net_total, employer_cost_total, employee_count, calculated_at
        from pay_runs where org_id = ${a.orgId} and document_id = ${a.documentId}
    `)) as unknown as { rows: Record<string, unknown>[] };
    assert.deepEqual(reset.rows[0], {
      run_status: "draft",
      gross_total: "0.0000",
      net_total: "0.0000",
      employer_cost_total: "0.0000",
      employee_count: 0,
      calculated_at: null,
    });

    await assert.rejects(
      mutatePayRunAdjustment({
        orgId: a.orgId,
        documentId: a.documentId,
        actorId: a.actorId,
        mutation: { action: "add", employeePartyId: b.employeeId, componentId: a.componentId, amount: "1.00" },
      }),
      /employee is not an active member/,
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
    await assert.rejects(
      mutatePayRunAdjustment({
        orgId: a.orgId,
        documentId: a.documentId,
        actorId: a.actorId,
        mutation: { action: "exclude", employeePartyId: otherEmployeeId },
      }),
      /employee is not an active member/,
    );

    await mutatePayRunAdjustment({
      orgId: b.orgId,
      documentId: b.documentId,
      actorId: b.actorId,
      mutation: { action: "exclude", employeePartyId: b.employeeId },
    });
    const bAdjustment = (await db.execute(sql`
      select id from pay_run_adjustments where org_id = ${b.orgId} and pay_run_document_id = ${b.documentId}
    `)) as unknown as { rows: { id: string }[] };
    await assert.rejects(
      mutatePayRunAdjustment({
        orgId: a.orgId,
        documentId: a.documentId,
        actorId: a.actorId,
        mutation: { action: "delete", adjustmentId: bAdjustment.rows[0]!.id },
      }),
      /pay run adjustment not found/,
    );
    const preserved = (await db.execute(sql`
      select count(*)::int as n from pay_run_adjustments
       where org_id = ${b.orgId} and id = ${bAdjustment.rows[0]!.id}
    `)) as unknown as { rows: { n: number }[] };
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
    const adjustment = (await db.execute(sql`
      select id from pay_run_adjustments
       where org_id = ${fixture.orgId} and pay_run_document_id = ${fixture.documentId}
    `)) as unknown as { rows: { id: string }[] };

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
    const unchanged = (await db.execute(sql`
      select adjustment_type from pay_run_adjustments
       where org_id = ${fixture.orgId} and pay_run_document_id = ${fixture.documentId}
       order by created_at
    `)) as unknown as { rows: { adjustment_type: string }[] };
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
