import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { mutatePayRunAdjustment, type PayRunAdjustmentMutation } from "./run-adjustments.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import { seedPayrollInputsFixture } from "../testing/payroll-inputs-fixture.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type Fixture = Awaited<ReturnType<typeof seedPayrollInputsFixture>> & {
  activeId: string; deactivatedId: string; profileOffId: string; otherEmployeeId: string;
};

async function scopeFixture(): Promise<Fixture> {
  const f = await seedPayrollInputsFixture("Scope", [
    { name: "Active Member" },
    { name: "Deactivated Member", active: false },
    { name: "Profile Off Member", profileActive: false },
    { name: "Other Schedule Member", otherSchedule: true },
  ]);
  const [activeId, deactivatedId, profileOffId, otherEmployeeId] = f.memberIds;
  return { ...f, activeId: activeId!, deactivatedId: deactivatedId!, profileOffId: profileOffId!, otherEmployeeId: otherEmployeeId! };
}

interface MembershipScenario {
  label: string;
  mutation: (fx: Fixture) => PayRunAdjustmentMutation;
  /** The native command must reject invalid subject membership. */
  expectRefused: boolean;
  /** Every refusal must name the employee (display name) or echo the id. */
  expectNamed?: RegExp;
}

function scopeCase(label: string, mutation: MembershipScenario["mutation"], expectNamed?: RegExp): MembershipScenario {
  return { label, mutation, expectRefused: expectNamed !== undefined, expectNamed };
}

test("pay-run scope guard: native membership rules for include and exclude", { skip: !DB }, async () => {
  const fx = await scopeFixture();
  try {
    const strangerId = randomUUID();
    const rows: MembershipScenario[] = [
      scopeCase("active member included", f => ({ action: "include", employeePartyId: f.activeId })),
      scopeCase("active member excluded", f => ({ action: "exclude", employeePartyId: f.activeId })),
      scopeCase("deactivated member excluded (the newly permitted case)", f => ({ action: "exclude", employeePartyId: f.deactivatedId })),
      scopeCase("inactive-profile member excluded (the newly permitted case)", f => ({ action: "exclude", employeePartyId: f.profileOffId })),
      scopeCase("deactivated member included (must still refuse)", f => ({ action: "include", employeePartyId: f.deactivatedId }),
        /employee "Deactivated Member" is not an active member.*deactivated/),
      scopeCase("inactive-profile member included (must still refuse)", f => ({ action: "include", employeePartyId: f.profileOffId }),
        /employee "Profile Off Member" has an inactive payroll profile.*reactivate/),
      scopeCase("other-schedule member excluded (must still refuse)", f => ({ action: "exclude", employeePartyId: f.otherEmployeeId }),
        /employee "Other Schedule Member" is not on this run's pay schedule/),
      scopeCase("other-schedule member included (must still refuse)", f => ({ action: "include", employeePartyId: f.otherEmployeeId }),
        /employee "Other Schedule Member" has no payroll profile on this run's pay schedule.*link them/),
      scopeCase("non-existent id excluded (must still refuse)", () => ({ action: "exclude", employeePartyId: strangerId }),
        new RegExp(`employee "${strangerId}" is not on this run's pay schedule`)),
      scopeCase("non-existent id included (must still refuse)", () => ({ action: "include", employeePartyId: strangerId }),
        new RegExp(`employee "${strangerId}" is not an active member.*no employee with that id`)),
      scopeCase("line adjustment for a deactivated member (must still refuse)", f => ({
        action: "add", employeePartyId: f.deactivatedId, componentId: f.componentId, amount: "10.00",
      }), /employee "Deactivated Member" is not an active member/),
      scopeCase("line adjustment for an active member", f => ({
        action: "add", employeePartyId: f.activeId, componentId: f.componentId, amount: "10.00",
      })),
    ];
    for (const row of rows) {
      const mutation = row.mutation(fx);
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
    // Repeating an exclusion without an idempotency key is a plain no-op,
    // not a replay: nothing changes and nothing was replayed.
    assert.deepEqual(repeat, { changed: false, replayed: false });
  } finally {
    await dropScratchOrgReporting(fx.orgId);
  }
});
test('historical adjustments retain a former employee’s inactive status and require a period covered by recorded termination', { skip: !DB }, async () => {
  const f = await scopeFixture();
  try {
    await db.execute(sql`insert into employee_roles(org_id,party_id,terminated_on,is_active)
      values(${f.orgId},${f.deactivatedId},'2026-07-12',false)`);
    const input = { orgId: f.orgId, actorId: f.actorId, documentId: f.documentId,
      mutation: { action: 'add' as const, employeePartyId: f.deactivatedId, componentId: f.componentId,
        amount: '100', note: 'Original historical payroll source' } };
    assert.equal((await mutatePayRunAdjustment(input)).changed, true);
    assert.equal((await db.execute<{ is_active: boolean }>(sql`select is_active from parties where org_id=${f.orgId} and id=${f.deactivatedId}`)).rows[0]!.is_active, false);
    await db.execute(sql`update employee_roles set terminated_on='2026-07-04' where org_id=${f.orgId} and party_id=${f.deactivatedId}`);
    await assert.rejects(mutatePayRunAdjustment(input), /Deactivated Member.*ended 2026-07-04.*review/i);
    assert.equal((await db.execute<{ count: string }>(sql`select count(*)::text from pay_run_adjustments
      where org_id=${f.orgId} and pay_run_document_id=${f.documentId} and adjustment_type='line'`)).rows[0]!.count, '1');
  } finally { await dropScratchOrgReporting(f.orgId); }
});
