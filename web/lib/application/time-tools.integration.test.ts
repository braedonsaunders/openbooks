import { before as initializeNativeComposition } from "node:test";

initializeNativeComposition(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg, seedFlowActors } =
  await import("@openbooks/engine/testing/fixtures");
const { loadWeek } = await import("../../app/api/timesheets/_lib");
const { loadWorkSchedules } = await import("@openbooks/engine/payroll/work-schedules/operations");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
const { RESOURCING_TOOLS } = await import("../assistant/tools-resourcing.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

function ctxFor(orgId: string, userId: string, permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId,
        email: `${userId}@test`,
        name: "Time tools test",
        orgId,
        roles: [{ key: "time-test", name: "Time test" }],
        envKind: "sandbox",
        productionOrgId: orgId,
        isSuperAdmin: false,
        homeUserId: userId,
        homeOrgId: orgId,
      },
      permissions: new Set(permissions),
      allowedSubsidiaryIds: null,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
  };
}

async function prepareOrg(orgId: string, features: Record<string, boolean>) {
  await withBypassContext(async () => {
    await db.execute(
      sql`update app_roles set permissions='["*"]'::jsonb where org_id=${orgId} and key='admin'`,
    );
    await db.execute(sql`
      update orgs set settings=settings || ${JSON.stringify({
        features,
        laborCosting: { mode: "post", hoursPerDay: "8", annualHours: "2080", components: [] },
      })}::jsonb where id=${orgId}`);
  });
}

test(
  "timesheet grid save creates, replays and removes only editable time through its native read",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      await prepareOrg(org.orgId, { projects: true, timeTracking: true });
      const employeeId = randomUUID();
      const projectId = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`
          insert into parties (id,org_id,kind,display_name,subsidiary_id,is_active,custom)
          values (${employeeId},${org.orgId},'employee','Time tools worker',${org.subsidiaryId},true,'{}'::jsonb)`);
        await db.execute(sql`
          insert into employee_roles (id,org_id,party_id,is_active)
          values (${randomUUID()},${org.orgId},${employeeId},true)`);
        await db.execute(sql`
          insert into projects (id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
          values (${projectId},${org.orgId},${org.subsidiaryId},'TIME-TOOLS','Time tools project',${org.customerId},'active',true,'{}'::jsonb)`);
      });

      const ctx = ctxFor(org.orgId, actors.adminId, ["time.manage", "projects.read"]);
      const run = (input: Record<string, unknown>) =>
        withOrgContext(org.orgId, () =>
          executeApplicationTool(applicationTool("save_timesheet_week")!, ctx, input),
        );
      const week = "2026-07-12";
      const before = await withOrgContext(org.orgId, () => loadWeek(org.orgId, employeeId, week));
      const input = {
        employee: employeeId,
        week,
        rows: [
          {
            projectId,
            itemId: org.items.service,
            isBillable: true,
            hours: ["", "", "", "4.25", "", "", ""],
          },
        ],
        expectedRevision: before.revision,
        expectedWorkFamily: "project",
        idempotencyKey: "time-grid-save-0001",
      };
      const saved = await run(input);
      assert.equal(saved.replayed, false);
      const savedWeek = await withOrgContext(org.orgId, () =>
        loadWeek(org.orgId, employeeId, week),
      );
      assert.equal(savedWeek.pendingEntries?.length, 1);
      assert.equal(savedWeek.pendingEntries?.[0]?.hours, "4.2500");

      const replay = await run(input);
      assert.equal(replay.replayed, true);
      const replayWeek = await withOrgContext(org.orgId, () =>
        loadWeek(org.orgId, employeeId, week),
      );
      assert.equal(replayWeek.pendingEntries?.length, 1);

      const deleted = await run({
        ...input,
        rows: [],
        expectedRevision: replayWeek.revision,
        idempotencyKey: "time-grid-delete-0001",
      });
      assert.equal(deleted.replayed, false);
      const emptyWeek = await withOrgContext(org.orgId, () =>
        loadWeek(org.orgId, employeeId, week),
      );
      assert.equal(emptyWeek.pendingEntries?.length, 0);

      const denied = ctxFor(org.orgId, actors.outsiderId, []);
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          executeApplicationTool(applicationTool("save_timesheet_week")!, denied, input),
        ),
        /forbidden/,
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "work schedules save atomically, refuse when payroll is off, and stay isolated by organization",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const other = await withBypassContext(() => createScratchOrg());
    try {
      const [actors, otherActors] = await withBypassContext(async () =>
        Promise.all([seedFlowActors(org.orgId), seedFlowActors(other.orgId)]),
      );
      await prepareOrg(org.orgId, { payroll: true });
      await prepareOrg(other.orgId, { payroll: true });
      const manager = ctxFor(org.orgId, actors.adminId, ["admin.setup.manage"]);
      const scheduleInput = {
        action: "save",
        jobTitle: "Field technician",
        effectiveFrom: "2026-01-05",
        effectiveTo: null,
        pattern: "cycle",
        cycleDays: 7,
        cycleAnchor: "2026-01-05",
        days: [0, 1, 2, 3, 4].map((dayIndex) => ({ dayIndex, hours: "8.00" })),
        idempotencyKey: "time-schedule-save-001",
      };
      const run = (name: string, context: ApplicationContext, input: Record<string, unknown>) =>
        withOrgContext(context.authz.user.orgId, () =>
          executeApplicationTool(applicationTool(name)!, context, input),
        );
      const saved = await run("save_work_schedule", manager, scheduleInput);
      assert.equal(saved.replayed, false);
      const scheduleId = saved.scheduleId as string;
      const schedules = await withOrgContext(org.orgId, () =>
        loadWorkSchedules(db, org.orgId, null),
      );
      assert.equal(schedules.length, 1);
      assert.equal(schedules[0]?.id, scheduleId);
      assert.equal(schedules[0]?.days.length, 5);

      const replay = await run("save_work_schedule", manager, scheduleInput);
      assert.equal(replay.replayed, true);
      assert.equal(
        (await withOrgContext(org.orgId, () => loadWorkSchedules(db, org.orgId, null))).length,
        1,
      );

      const otherManager = ctxFor(other.orgId, otherActors.adminId, ["admin.setup.manage"]);
      await assert.rejects(
        run("save_work_schedule", otherManager, {
          ...scheduleInput,
          id: scheduleId,
          idempotencyKey: "time-schedule-cross-org-001",
        }),
        (error: unknown) =>
          typeof error === "object" && error !== null && "status" in error && error.status === 422,
      );
      assert.equal(
        (await withOrgContext(other.orgId, () => loadWorkSchedules(db, other.orgId, null))).length,
        0,
      );
      assert.equal(
        (await withOrgContext(org.orgId, () => loadWorkSchedules(db, org.orgId, null))).length,
        1,
      );

      await prepareOrg(other.orgId, { payroll: false });
      await assert.rejects(
        run("save_work_schedule", otherManager, {
          ...scheduleInput,
          idempotencyKey: "time-schedule-feature-off-001",
        }),
        (error: unknown) =>
          typeof error === "object" && error !== null && "status" in error && error.status === 404,
      );
    } finally {
      await withBypassContext(async () => {
        await dropScratchOrg(org.orgId);
        await dropScratchOrg(other.orgId);
      });
    }
  },
);

test(
  "resourcing and schedule board writes are visible through their native read models",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      await prepareOrg(org.orgId, {
        projects: true,
        resourcing: true,
        hrm: true,
        hrmShiftPlanning: true,
        hrmAttendance: true,
      });
      const ctx = ctxFor(org.orgId, actors.adminId, [
        "resourcing.manage",
        "resourcing.read",
        "hrm.shifts.manage",
        "hrm.shifts.read",
      ]);
      const projectId = randomUUID();
      const employeeId = randomUUID();
      const boardId = randomUUID();
      const entryId = randomUUID();
      await withBypassContext(async () => {
        const project = await db.execute(
          sql`
          insert into projects (id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
          values (${projectId},${org.orgId},${org.subsidiaryId},'TIME-OPS','Time ops project',${org.customerId},'active',true,'{}'::jsonb) returning id`,
          "objects",
        );
        assert.equal(project.length, 1);
        const employee = await db.execute(
          sql`
          insert into parties (id,org_id,kind,display_name,subsidiary_id,is_active,custom)
          values (${employeeId},${org.orgId},'person','Time ops employee',${org.subsidiaryId},true,'{}'::jsonb) returning id`,
          "objects",
        );
        assert.equal(employee.length, 1);
        const role = await db.execute(
          sql`
          insert into employee_roles (id,org_id,party_id,job_title,hired_on,is_active)
          values (${randomUUID()},${org.orgId},${employeeId},'Time operations','2026-01-01',true) returning id`,
          "objects",
        );
        assert.equal(role.length, 1);
        const board = await db.execute(
          sql`
          insert into schedule_boards (id,org_id,code,name,row_kind,views,default_view,time_zone,publish_policy,subsidiary_id)
          values (${boardId},${org.orgId},'TIME-OPS','Time operations','people','{grid}','grid','America/Toronto','live',${org.subsidiaryId}) returning id`,
          "objects",
        );
        assert.equal(board.length, 1);
      });

      const run = (name: string, input: Record<string, unknown>) =>
        withOrgContext(org.orgId, () => executeApplicationTool(applicationTool(name)!, ctx, input));
      const assignmentInput = {
        projectId,
        jobTitle: "Time operations",
        weekStart: "2026-10-04",
        plannedHours: "12.50",
        idempotencyKey: "time-resourcing-assignment-01",
      };
      const assigned = await run("assign_resourcing_capacity", assignmentInput);
      assert.equal(assigned.replayed, false);
      const assignmentRead = RESOURCING_TOOLS.find(
        (tool) => tool.name === "list_resourcing_assignments",
      );
      assert.ok(assignmentRead);
      const visibleAssignments = await assignmentRead.execute(
        { projectId, weekFrom: "2026-10-04", weekTo: "2026-10-04" },
        ctx.authz,
      );
      assert.equal(visibleAssignments.ok, true);
      assert.ok(
        (
          visibleAssignments as { data: { assignments: Array<{ id: string }> } }
        ).data.assignments.some((assignment) => assignment.id === assigned.assignmentId),
      );

      const changeInput = {
        boardId,
        changes: [
          {
            op: "create",
            id: entryId,
            workerPartyId: employeeId,
            onDate: "2026-10-05",
            target: null,
            span: { mode: "day" },
          },
        ],
        idempotencyKey: "time-schedule-entry-0001",
      };
      const changed = await run("change_schedule_board_entries", changeInput);
      assert.equal(changed.replayed, false);
      const window = await run("get_schedule_board_window", {
        boardId,
        from: "2026-10-05",
        through: "2026-10-05",
      });
      assert.equal((window.entries as Array<{ id: string; revision: number }>).length, 1);
      assert.equal((window.entries as Array<{ id: string; revision: number }>)[0]?.id, entryId);
      assert.equal((window.entries as Array<{ id: string; revision: number }>)[0]?.revision, 2);

      const replay = await run("change_schedule_board_entries", changeInput);
      assert.equal(replay.replayed, true);
      const afterReplay = await run("get_schedule_board_window", {
        boardId,
        from: "2026-10-05",
        through: "2026-10-05",
      });
      assert.equal((afterReplay.entries as unknown[]).length, 1);
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
