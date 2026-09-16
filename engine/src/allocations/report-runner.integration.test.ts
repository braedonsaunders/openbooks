import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
} from "../test-fixtures.ts";
import { DriverNotAvailableError } from "./drivers.ts";
import { runDriverReport } from "./report-runner.ts";

async function seedReportsReader(orgId: string): Promise<string> {
  const actor = await createScratchUser(orgId, "Report driver tester", "admin");
  await db.execute(sql`
    update app_roles set permissions = '["reports.read"]'::jsonb
     where org_id = ${orgId} and key = 'admin'`);
  return actor;
}

async function seedTimesheetSource(orgId: string, subsidiaryId: string, workedOn: string): Promise<string> {
  const deptId = randomUUID();
  const projectId = randomUUID();
  const employeeId = randomUUID();
  await db.execute(sql`insert into departments (id, org_id, name) values (${deptId}, ${orgId}, 'Crew A')`);
  await db.execute(sql`
    insert into projects (id, org_id, subsidiary_id, code, name, status, is_active, custom)
    values (${projectId}, ${orgId}, ${subsidiaryId}, 'JOB-TS', 'Timesheet job', 'active', true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${employeeId}, ${orgId}, 'employee', 'Timesheet worker', ${subsidiaryId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into time_entries (id, org_id, employee_party_id, worked_on, hours, project_id, department_id,
                              status, costing_basis, is_billable, custom)
    values (${randomUUID()}, ${orgId}, ${employeeId}, ${workedOn}, '8.0000', ${projectId}, ${deptId},
            'approved', 'actual', false, '{}'::jsonb)`);
  const definitionId = randomUUID();
  await db.execute(sql`
    insert into report_definitions (id, org_id, kind, slug, name, report_type, query)
    values (${definitionId}, ${orgId}, 'custom', 'driver-timesheets-test', 'Driver timesheets test', 'query',
      ${JSON.stringify({
        entity: "timesheets",
        columns: ["department", "hours"],
      })}::jsonb)`);
  return definitionId;
}

test("report runner honors canonical feature defaults (timeTracking on unless disabled)", async () => {
  const org = await createScratchOrg();
  try {
    const actor = await seedReportsReader(org.orgId);
    // The scratch org never stores an explicit timeTracking flag: the
    // registry default (on) governs, exactly like the report routes.
    const definitionId = await seedTimesheetSource(org.orgId, org.subsidiaryId, org.date);
    const rows = await runDriverReport({
      orgId: org.orgId,
      reportDefinitionId: definitionId,
      dimensionColumn: "department",
      valueColumn: "hours",
      params: {},
      from: org.date,
      to: org.date,
      actorId: actor,
    });
    assert.deepEqual(rows, [{ dimension: "Crew A", value: "8.0000" }]);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("report runner honors the feature parent gate (projects off disables timeTracking)", async () => {
  const org = await createScratchOrg();
  try {
    const actor = await seedReportsReader(org.orgId);
    const definitionId = await seedTimesheetSource(org.orgId, org.subsidiaryId, org.date);
    // A stale stored true must not override the disabled parent: the report
    // routes refuse this entity, so the driver runner must too.
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(settings, '{features}',
               coalesce(settings->'features', '{}'::jsonb) || '{"timeTracking": true, "projects": false}'::jsonb)
       where id = ${org.orgId}`);
    await assert.rejects(
      runDriverReport({
        orgId: org.orgId,
        reportDefinitionId: definitionId,
        dimensionColumn: "department",
        valueColumn: "hours",
        params: {},
        from: org.date,
        to: org.date,
        actorId: actor,
      }),
      (error: unknown) => error instanceof DriverNotAvailableError && /feature is disabled/.test(error.message),
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
