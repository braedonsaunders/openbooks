import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { mutatePayRunAdjustment, type PayRunAdjustmentMutation } from "./run-adjustments.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  actorId: string;
  scheduleId: string;
  documentId: string;
  componentId: string;
  activeId: string;
  deactivatedId: string;
  profileOffId: string;
  otherEmployeeId: string;
}

async function scopeFixture(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      features: { payroll: true },
    })}::jsonb where id = ${org.orgId}`);
  await seedPayrollComponents(org.orgId, actorId, "CA");
  const scheduleId = randomUUID();
  const otherScheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules
      (id, org_id, name, frequency, periods_per_year, anchor_period_end,
       pay_date_offset_days, is_active, created_by, updated_by)
    values
      (${scheduleId}, ${org.orgId}, 'Scope Schedule', 'biweekly', 26, '2026-07-18',
       3, true, ${actorId}, ${actorId}),
      (${otherScheduleId}, ${org.orgId}, 'Other Schedule', 'monthly', 12, '2026-07-31',
       3, true, ${actorId}, ${actorId})
  `);
  const activeId = randomUUID();
  const deactivatedId = randomUUID();
  const profileOffId = randomUUID();
  const otherId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${activeId}, ${org.orgId}, 'person', 'Active Member', true, '{}'::jsonb),
           (${deactivatedId}, ${org.orgId}, 'person', 'Deactivated Member', false, '{}'::jsonb),
           (${profileOffId}, ${org.orgId}, 'person', 'Profile Off Member', true, '{}'::jsonb),
           (${otherId}, ${org.orgId}, 'person', 'Other Schedule Member', true, '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into employee_payroll_profiles
      (org_id, employee_party_id, pay_schedule_id, country, province, pay_basis,
       federal_claim_code, provincial_claim_code, is_active, created_by, updated_by)
    values
      (${org.orgId}, ${activeId}, ${scheduleId}, 'CA', 'ON', 'salary', 1, 1, true, ${actorId}, ${actorId}),
      (${org.orgId}, ${deactivatedId}, ${scheduleId}, 'CA', 'ON', 'salary', 1, 1, true, ${actorId}, ${actorId}),
      (${org.orgId}, ${profileOffId}, ${scheduleId}, 'CA', 'ON', 'salary', 1, 1, false, ${actorId}, ${actorId}),
      (${org.orgId}, ${otherId}, ${otherScheduleId}, 'CA', 'ON', 'salary', 1, 1, true, ${actorId}, ${actorId})
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
    scheduleId,
    documentId: run.documentId,
    componentId: component.rows[0]!.id,
    activeId,
    deactivatedId,
    profileOffId,
    otherEmployeeId: otherId,
  };
}

// Oracle: the membership guard verbatim from
// engine/src/payroll/run-adjustments.ts at c640c73a3. The new path must agree
// with it on every row EXCEPT the two deliberately widened ones (excluding an
// inactive member), which the old code refused and the new code permits.
async function oldGuardAccepts(orgId: string, employeeId: string, scheduleId: string): Promise<boolean> {
  const membership = (await db.execute(sql`
    select 1
      from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
     where prof.org_id = ${orgId}
       and prof.employee_party_id = ${employeeId}
       and prof.pay_schedule_id = ${scheduleId}
       and prof.is_active and p.is_active
     limit 1
  `));
  return membership.rows.length > 0;
}

interface OracleRow {
  label: string;
  mutation: (fx: Fixture) => PayRunAdjustmentMutation;
  /** What the OLD guard did: true = refused. */
  oracleRefused: boolean;
  /** What the NEW path must do: true = refused. */
  expectRefused: boolean;
  /** Every refusal must name the employee (display name) or echo the id. */
  expectNamed?: RegExp;
}

test("pay-run scope guard: oracle table for the include/exclude asymmetry", { skip: !DB }, async () => {
  const fx = await scopeFixture();
  try {
    const strangerId = randomUUID();
    const rows: OracleRow[] = [
      {
        label: "active member included",
        mutation: (f) => ({ action: "include", employeePartyId: f.activeId }),
        oracleRefused: false,
        expectRefused: false,
      },
      {
        label: "active member excluded",
        mutation: (f) => ({ action: "exclude", employeePartyId: f.activeId }),
        oracleRefused: false,
        expectRefused: false,
      },
      {
        label: "deactivated member excluded (the newly permitted case)",
        mutation: (f) => ({ action: "exclude", employeePartyId: f.deactivatedId }),
        oracleRefused: true,
        expectRefused: false,
      },
      {
        label: "inactive-profile member excluded (the newly permitted case)",
        mutation: (f) => ({ action: "exclude", employeePartyId: f.profileOffId }),
        oracleRefused: true,
        expectRefused: false,
      },
      {
        label: "deactivated member included (must still refuse)",
        mutation: (f) => ({ action: "include", employeePartyId: f.deactivatedId }),
        oracleRefused: true,
        expectRefused: true,
        expectNamed: /employee "Deactivated Member" is not an active member.*deactivated/,
      },
      {
        label: "inactive-profile member included (must still refuse)",
        mutation: (f) => ({ action: "include", employeePartyId: f.profileOffId }),
        oracleRefused: true,
        expectRefused: true,
        expectNamed: /employee "Profile Off Member" is not an active member.*profile.*inactive/,
      },
      {
        label: "other-schedule member excluded (must still refuse)",
        mutation: (f) => ({ action: "exclude", employeePartyId: f.otherEmployeeId }),
        oracleRefused: true,
        expectRefused: true,
        expectNamed: /employee "Other Schedule Member" is not on this run's pay schedule/,
      },
      {
        label: "other-schedule member included (must still refuse)",
        mutation: (f) => ({ action: "include", employeePartyId: f.otherEmployeeId }),
        oracleRefused: true,
        expectRefused: true,
        expectNamed: /employee "Other Schedule Member" is not an active member.*no payroll profile/,
      },
      {
        label: "non-existent id excluded (must still refuse)",
        mutation: () => ({ action: "exclude", employeePartyId: strangerId }),
        oracleRefused: true,
        expectRefused: true,
        expectNamed: new RegExp(`employee "${strangerId}" is not on this run's pay schedule`),
      },
      {
        label: "non-existent id included (must still refuse)",
        mutation: () => ({ action: "include", employeePartyId: strangerId }),
        oracleRefused: true,
        expectRefused: true,
        expectNamed: new RegExp(`employee "${strangerId}" is not an active member.*no employee with that id`),
      },
      {
        label: "line adjustment for a deactivated member (must still refuse)",
        mutation: (f) => ({
          action: "add",
          employeePartyId: f.deactivatedId,
          componentId: f.componentId,
          amount: "10.00",
        }),
        oracleRefused: true,
        expectRefused: true,
        expectNamed: /employee "Deactivated Member" is not an active member/,
      },
      {
        label: "line adjustment for an active member",
        mutation: (f) => ({
          action: "add",
          employeePartyId: f.activeId,
          componentId: f.componentId,
          amount: "10.00",
        }),
        oracleRefused: false,
        expectRefused: false,
      },
    ];
    for (const row of rows) {
      const mutation = row.mutation(fx);
      const target = mutation.action === "delete" ? null : (mutation as { employeePartyId: string }).employeePartyId;
      // The oracle is validated, not decorative: if the live old predicate
      // disagrees with the transcribed column, the transcription is wrong.
      assert.equal(
        !(await oldGuardAccepts(fx.orgId, target!, fx.scheduleId)),
        row.oracleRefused,
        `${row.label}: oracle transcription mismatch`,
      );
      let error: unknown = null;
      try {
        await mutatePayRunAdjustment({
          orgId: fx.orgId,
          documentId: fx.documentId,
          actorId: fx.actorId,
          mutation,
        });
      } catch (caught) {
        error = caught;
      }
      assert.equal(error !== null, row.expectRefused, `${row.label}: expected refused=${row.expectRefused}`);
      if (error !== null) {
        assert.ok(error instanceof PayrollError, `${row.label}: refusal must be a PayrollError`);
        if (row.expectNamed) {
          assert.match(
            (error as Error).message,
            row.expectNamed,
            `${row.label}: refusal must name the employee and the cause`,
          );
        }
      }
    }
    // The newly permitted exclusions really land: both inactive members hold
    // exclusion rows, and repeating one is a no-op rather than a second row.
    const excluded = (await db.execute<{ employee_party_id: string }>(sql`
      select employee_party_id from pay_run_adjustments
       where org_id = ${fx.orgId} and pay_run_document_id = ${fx.documentId}
         and adjustment_type = 'exclude'
    `));
    assert.deepEqual(
      excluded.rows.map((r) => r.employee_party_id).sort(),
      [fx.activeId, fx.deactivatedId, fx.profileOffId].sort(),
    );
    const repeat = await mutatePayRunAdjustment({
      orgId: fx.orgId,
      documentId: fx.documentId,
      actorId: fx.actorId,
      mutation: { action: "exclude", employeePartyId: fx.deactivatedId },
    });
    assert.deepEqual(repeat, { changed: false });
  } finally {
    await dropScratchOrgReporting(fx.orgId);
  }
});
