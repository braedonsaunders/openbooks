import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Regular-cycle scheduling anchors on the REGULAR schedule: an off-cycle
 * final-pay run ending mid-span must not drag max(period_end) forward, or the
 * next regular run silently skips the period the off-cycle run interrupted.
 */
test("an off-cycle final-pay run does not move the next regular period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      features: { payroll: true },
    })}::jsonb where id = ${org.orgId}`);
  await seedPayrollComponents(org.orgId, actorId, "CA");
  const employeeId = randomUUID();
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${org.orgId}, 'person', 'Lifecycle Employee', true, '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into pay_schedules
      (id, org_id, name, frequency, periods_per_year, anchor_period_end,
       pay_date_offset_days, is_active, created_by, updated_by)
    values
      (${scheduleId}, ${org.orgId}, 'Lifecycle Schedule', 'biweekly', 26, '2026-07-11',
       3, true, ${actorId}, ${actorId})
  `);
  await db.execute(sql`
    insert into employee_payroll_profiles
      (org_id, employee_party_id, pay_schedule_id, country, province, pay_basis,
       federal_claim_code, provincial_claim_code, is_active, created_by, updated_by)
    values
      (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', 'ON', 'salary', 1, 1, true,
       ${actorId}, ${actorId})
  `);

  // The last regular payday ended 2026-07-11; the next span is 07-12–07-25.
  await createPayRun({
    orgId: org.orgId,
    actorId,
    payScheduleId: scheduleId,
    periodStart: "2026-06-28",
    periodEnd: "2026-07-11",
  });
  // An off-cycle final pay spans past the next regular payday: it ends
  // 2026-07-30, beyond the 2026-07-25 regular period end. (A mid-span end
  // alone is already absorbed by nextPeriodAfter's floor step; only an end
  // past the next schedule date can drag max(period_end) forward.)
  await createPayRun({
    orgId: org.orgId,
    actorId,
    payScheduleId: scheduleId,
    periodStart: "2026-07-12",
    periodEnd: "2026-07-30",
    runType: "termination",
    employeePartyIds: [employeeId],
  });

  // The next regular run must still open 07-12–07-25 — not jump to 07-26–08-08.
  const next = await createPayRun({ orgId: org.orgId, actorId, payScheduleId: scheduleId });
  const stored = (await db.execute<{ period_start: string; period_end: string }>(sql`
    select period_start::text as period_start, period_end::text as period_end
      from pay_runs where org_id = ${org.orgId} and document_id = ${next.documentId}
  `)).rows[0]!;
  assert.equal(stored.period_start, "2026-07-12");
  assert.equal(stored.period_end, "2026-07-25");

  await dropScratchOrg(org.orgId);
});
