import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createPayRun } from "../payroll/run-lifecycle.ts";
import { seedPayrollComponents } from "../payroll/run-setup.ts";
import { createScratchOrg, seedFlowActors } from "./fixtures.ts";

export interface PayrollInputMember {
  name: string;
  active?: boolean;
  profileActive?: boolean;
  otherSchedule?: boolean;
  shortCode?: string;
  claimCodes?: null;
}

/** Salary-profile input admission without calculated earnings or employment history. */
export async function seedPayrollInputsFixture(label: string, members: readonly PayrollInputMember[] = [{ name: `${label} Employee` }]) {
  if (members.length === 0) throw new Error("A payroll input fixture requires at least one declared member");
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      features: { payroll: true },
    })}::jsonb where id = ${org.orgId}`);
  await seedPayrollComponents(org.orgId, actorId, "CA");
  const scheduleId = randomUUID();
  const otherScheduleId = members.some(member => member.otherSchedule) ? randomUUID() : null;
  await db.execute(sql`
    insert into pay_schedules
      (id, org_id, name, frequency, periods_per_year, anchor_period_end,
       pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, ${`${label} Schedule`}, 'biweekly', 26,
      '2026-07-18', 3, true, ${actorId}, ${actorId})
  `);
  if (otherScheduleId !== null) await db.execute(sql`
    insert into pay_schedules
      (id, org_id, name, frequency, periods_per_year, anchor_period_end,
       pay_date_offset_days, is_active, created_by, updated_by)
    values (${otherScheduleId}, ${org.orgId}, 'Other Schedule', 'monthly', 12,
      '2026-07-31', 3, true, ${actorId}, ${actorId})
  `);
  const memberIds: string[] = [];
  for (const member of members) {
    const employeeId = randomUUID();
    memberIds.push(employeeId);
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, short_code, is_active, custom)
      values (${employeeId}, ${org.orgId}, 'person', ${member.name}, ${member.shortCode ?? null},
        ${member.active ?? true}, '{}'::jsonb)
    `);
    await db.execute(sql`
      insert into employee_payroll_profiles
        (org_id, employee_party_id, pay_schedule_id, country, province, pay_basis,
         federal_claim_code, provincial_claim_code, is_active, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, ${member.otherSchedule ? otherScheduleId : scheduleId},
        'CA', 'ON', 'salary', ${member.claimCodes === null ? null : 1},
        ${member.claimCodes === null ? null : 1}, ${member.profileActive ?? true}, ${actorId}, ${actorId})
    `);
  }
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
    employeeId: memberIds[0]!,
    memberIds,
    subsidiaryId: org.subsidiaryId,
    scheduleId,
    documentId: run.documentId,
    componentId: component.rows[0]!.id,
  };
}
