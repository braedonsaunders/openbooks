import { installEngineSeams } from "@openbooks/engine/composition/install";
installEngineSeams();
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
const { sql } = await import("drizzle-orm");
const { db, env, withBypassContext, withOrgContext } =
  await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } =
  await import("@openbooks/engine/testing/fixtures");
const { seedEmployment } = await import("@openbooks/engine/testing/hrm-harness");
const { createLeavePolicy, fileLeaveRequest, submitLeaveRequest } =
  await import("@openbooks/engine/hrm/leave");
const { loadPlanVsActual } = await import("./tie-out.ts");

test(
  "plan-vs-actual ties planned hours to approved time with forecast capacity evidence",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const ids = Object.fromEntries(
      [
        "actor",
        "anna",
        "ben",
        "visible",
        "hidden",
        "hiddenSub",
        "assignment",
        "approved",
        "submitted",
        "employment",
        "leaveType",
        "request",
        "absence",
      ].map((key) => [key, randomUUID()]),
    ) as Record<string, string>;
    const week = "2026-10-04";
    try {
      await withBypassContext(async () => {
        ids.actor = await createScratchUser(org.orgId, "Tie-out operator", "admin");
        await db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"resourcing":true,"hrm":true}'::jsonb,true) where id=${org.orgId}`,
        );
        await db.execute(
          sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${ids.hiddenSub},${org.orgId},${org.subsidiaryId},'Hidden subsidiary','USD','US')`,
        );
        for (const [id, name] of [
          [ids.anna, "Anna Plan"],
          [ids.ben, "Ben Plan"],
        ]) {
          await db.execute(
            sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom) values(${id},${org.orgId},'person',${name},${org.subsidiaryId},true,'{}'::jsonb)`,
          );
          await db.execute(
            sql`insert into employee_roles(org_id,party_id,job_title,hired_on,is_active) values(${org.orgId},${id},'Consultant','2026-01-01',true)`,
          );
          const scheduleId = randomUUID();
          await db.execute(sql`insert into work_schedules(id,org_id,name,employee_party_id,pattern,cycle_days,cycle_anchor,effective_from,is_active,created_by,updated_by)
          values (${scheduleId},${org.orgId},'Full time',${id},'cycle',7,'2026-01-04','2026-01-01',true,${ids.actor},${ids.actor})`);
          for (const dayIndex of [1, 2, 3, 4, 5]) {
            await db.execute(
              sql`insert into work_schedule_days(org_id,schedule_id,day_index,hours,created_by,updated_by) values (${org.orgId},${scheduleId},${dayIndex},'8',${ids.actor},${ids.actor})`,
            );
          }
        }
        await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom) values
        (${ids.visible},${org.orgId},${org.subsidiaryId},'TIE-V','Tie-out engagement',${org.customerId},'active',true,'{}'::jsonb),
        (${ids.hidden},${org.orgId},${ids.hiddenSub},'TIE-H','Hidden engagement',${org.customerId},'active',true,'{}'::jsonb)`);
        await db.execute(sql`insert into res_assignments(id,org_id,project_id,employee_party_id,week_start,planned_hours,is_billable,bill_item_id,booking,state,created_by,updated_by) values
        (${ids.assignment},${org.orgId},${ids.visible},${ids.anna},${week},'8.0000',true,${org.items.service},'hard','active',${ids.actor},${ids.actor}),
        (${randomUUID()},${org.orgId},${ids.hidden},${ids.anna},${week},'8.0000',true,${org.items.service},'hard','active',${ids.actor},${ids.actor}),
        (${randomUUID()},${org.orgId},${ids.visible},${ids.ben},${week},'8.0000',true,${org.items.service},'hard','active',${ids.actor},${ids.actor})`);
        await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,status,is_billable,billing_status,costing_basis,created_by,updated_by) values
        (${ids.approved},${org.orgId},${ids.anna},'2026-10-06','6.0000',${ids.visible},'approved',true,'unbilled','actual',${ids.actor},${ids.actor}),
        (${ids.submitted},${org.orgId},${ids.anna},'2026-10-07','4.0000',${ids.visible},'submitted',true,'unbilled','actual',${ids.actor},${ids.actor})`);
        const employment = await seedEmployment(org.orgId, org.subsidiaryId, {
          workerPartyId: ids.ben,
        });
        ids.employment = employment.employmentId;
        await db.execute(
          sql`insert into hrm_leave_types(id,org_id,code,name) values (${ids.leaveType},${org.orgId},'VAC','Vacation')`,
        );
      });
      await withOrgContext(org.orgId, async () => {
        await createLeavePolicy({
          orgId: org.orgId,
          actorId: ids.actor!,
          leaveTypeId: ids.leaveType!,
          accrualRule: { kind: "unlimited" },
          effectiveFrom: "2020-01-01",
        });
        const draft = await fileLeaveRequest({
          orgId: org.orgId,
          actorId: ids.actor!,
          employmentId: ids.employment!,
          leaveTypeId: ids.leaveType!,
          startsOn: "2026-10-06",
          endsOn: "2026-10-06",
          hours: "8",
          onBehalf: true,
          reason: "Scheduled vacation",
        });
        const approved = await submitLeaveRequest({
          orgId: org.orgId,
          actorId: ids.actor!,
          requestId: draft.id,
        });
        assert.equal(approved.status, "approved");
        ids.request = approved.id;
        const absence = await db.execute<{ id: string }>(
          sql`select id from hrm_absences
        where org_id=${org.orgId} and leave_request_id=${approved.id}`,
          "objects",
        );
        assert.equal(absence.length, 1);
        ids.absence = absence[0]!.id;
      });

      const scope = new Set([org.subsidiaryId]);
      const rows = await withOrgContext(org.orgId, () =>
        loadPlanVsActual(org.orgId, scope, { firstSunday: week, lastSunday: week }),
      );
      // The hidden-subsidiary project is outside the scope, so only two rows tie out.
      assert.equal(rows.length, 2);
      const anna = rows.find((row) => row.employeePartyId === ids.anna)!;
      assert.equal(anna.plannedHours, "8.0000");
      assert.equal(anna.approvedHours, "6.0000");
      assert.equal(anna.varianceHours, "-2.0000");
      assert.deepEqual(anna.assignmentIds, [ids.assignment]);
      assert.deepEqual(anna.timeEntryIds, [ids.approved]);
      assert.deepEqual(anna.absences, []);
      assert.equal(anna.netCapacity, "40.0000");
      assert.notEqual(anna.capacityTier, "unknown");
      assert.equal(anna.scheduleIds.length, 1);
      const ben = rows.find((row) => row.employeePartyId === ids.ben)!;
      assert.equal(ben.plannedHours, "8.0000");
      assert.equal(ben.approvedHours, "0.0000");
      assert.equal(ben.varianceHours, "-8.0000");
      assert.deepEqual(ben.absences, [{ absenceId: ids.absence, leaveRequestId: ids.request }]);
      assert.equal(ben.netCapacity, "32.0000");

      const filtered = await withOrgContext(org.orgId, () =>
        loadPlanVsActual(org.orgId, scope, {
          firstSunday: week,
          lastSunday: week,
          projectId: ids.visible,
        }),
      );
      assert.ok(filtered.length > 0 && filtered.every((row) => row.projectId === ids.visible));
      const hidden = await withOrgContext(org.orgId, () =>
        loadPlanVsActual(org.orgId, scope, {
          firstSunday: week,
          lastSunday: week,
          projectId: ids.hidden,
        }),
      );
      assert.deepEqual(hidden, []);
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(org.orgId));
    }
  },
);
