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
const { FieldTicketError, loadFieldTicket } = await import("../field-tickets");
const { loadWorkBreakdownTasks } = await import("../project-work-breakdown");
const { listBudgetBaselines } = await import("@openbooks/engine/projects/budget-baselines");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

function contextFor(orgId: string, userId: string, permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId,
        email: `${userId}@test`,
        name: "Project test",
        orgId,
        roles: [{ key: "project-test", name: "Project test" }],
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

async function seedProject(org: { orgId: string; subsidiaryId: string; customerId: string }) {
  const projectId = randomUUID();
  await withBypassContext(() =>
    db.execute(sql`
    insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active)
    values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, ${`TOOL-${projectId.slice(0, 8)}`}, 'Application tool project', ${org.customerId}, 'active', true)
  `),
  );
  return projectId;
}

async function setFieldTicketFeatures(
  orgId: string,
  projects: boolean,
  fieldTickets: boolean,
): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
      update orgs
         set settings = jsonb_set(
           coalesce(settings, '{}'::jsonb),
           '{features}',
           coalesce(settings->'features', '{}'::jsonb) ||
             jsonb_build_object('projects', ${projects}, 'fieldTickets', ${fieldTickets}),
           true
         )
       where id = ${orgId}
    `),
  );
}

test(
  "project WBS and budget baseline commands use native reads and replay idempotently",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      const projectId = await seedProject(org);
      const context = contextFor(org.orgId, actors.adminId, ["projects.read", "projects.manage"]);
      const run = (name: string, input: Record<string, unknown>) =>
        withOrgContext(org.orgId, () =>
          executeApplicationTool(applicationTool(name)!, context, input),
        );

      const created = (await run("create_project_task", {
        projectId,
        code: "01",
        name: "Foundation",
        estimatedHours: "12.5000",
        estimatedCost: "1250.0000",
        estimatedPrice: "1800.0000",
        idempotencyKey: "project-task-create-001",
      })) as { replayed: boolean };
      assert.equal(created.replayed, false);
      const replay = (await run("create_project_task", {
        projectId,
        code: "01",
        name: "Foundation",
        estimatedHours: "12.5000",
        estimatedCost: "1250.0000",
        estimatedPrice: "1800.0000",
        idempotencyKey: "project-task-create-001",
      })) as { replayed: boolean };
      assert.equal(replay.replayed, true);

      const tasks = await withOrgContext(org.orgId, () =>
        loadWorkBreakdownTasks(org.orgId, projectId, null),
      );
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.name, "Foundation");

      await run("capture_project_budget_baseline", {
        projectId,
        reason: "Initial approved project budget",
        label: "Award baseline",
        idempotencyKey: "project-baseline-001",
      });
      const baselines = await withOrgContext(org.orgId, () =>
        listBudgetBaselines(org.orgId, projectId, null),
      );
      assert.equal(baselines.length, 1);
      assert.equal(baselines[0]?.totalCost, "1250.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("project tools enforce permissions and child feature gates", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    const projectId = await seedProject(org);
    const noPermission = contextFor(org.orgId, actors.adminId, []);
    await assert.rejects(
      withOrgContext(org.orgId, () =>
        executeApplicationTool(applicationTool("create_project_task")!, noPermission, {
          projectId,
          name: "Denied task",
          idempotencyKey: "project-task-denied-01",
        }),
      ),
      /forbidden/,
    );

    const reader = contextFor(org.orgId, actors.adminId, ["projects.read"]);
    await assert.rejects(
      withOrgContext(org.orgId, () =>
        executeApplicationTool(applicationTool("get_project_schedule")!, reader, { projectId }),
      ),
      /needs the projectScheduling feature/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("project reads keep another organization's project hidden", { skip: !DB }, async () => {
  const first = await withBypassContext(() => createScratchOrg());
  const second = await withBypassContext(() => createScratchOrg());
  try {
    const firstActors = await withBypassContext(() => seedFlowActors(first.orgId));
    const secondActors = await withBypassContext(() => seedFlowActors(second.orgId));
    const projectId = await seedProject(first);
    const foreignContext = contextFor(second.orgId, secondActors.adminId, ["projects.read"]);
    await assert.rejects(
      withOrgContext(second.orgId, () =>
        executeApplicationTool(applicationTool("list_project_work_breakdown")!, foreignContext, {
          projectId,
        }),
      ),
      /project not found/,
    );
    assert.ok(firstActors.adminId);
  } finally {
    await dropScratchOrg(first.orgId);
    await dropScratchOrg(second.orgId);
  }
});

test(
  "field ticket draft commands use native create and delete services with scope and feature gates",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      await setFieldTicketFeatures(org.orgId, true, true);
      const projectId = await seedProject(org);
      const baseContext = contextFor(org.orgId, actors.adminId, ["time.manage"]);
      const manager: ApplicationContext = {
        ...baseContext,
        authz: {
          ...baseContext.authz,
          allowedSubsidiaryIds: new Set([org.subsidiaryId]),
        },
      };
      const run = (
        name: string,
        input: Record<string, unknown>,
        context: ApplicationContext = manager,
      ) =>
        withOrgContext(org.orgId, () =>
          executeApplicationTool(applicationTool(name)!, context, input),
        );

      const requestId = randomUUID();
      const created = (await run("create_field_ticket", {
        projectId,
        idempotencyKey: requestId,
      })) as {
        id: string;
        documentNumber: string;
        status: string;
        revision: string;
        replayed: boolean;
      };
      assert.match(
        created.id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assert.equal(created.status, "draft");
      assert.equal(created.replayed, false);

      const replay = (await run("create_field_ticket", {
        projectId,
        idempotencyKey: requestId,
      })) as { id: string; replayed: boolean };
      assert.equal(replay.id, created.id);
      assert.equal(replay.replayed, true);

      const persisted = await withOrgContext(org.orgId, () =>
        loadFieldTicket(org.orgId, created.id, {
          allowedSubsidiaryIds: manager.authz.allowedSubsidiaryIds,
        }),
      );
      assert.equal(persisted.documentNumber, created.documentNumber);
      assert.equal(persisted.projectId, projectId);
      assert.equal(persisted.status, "draft");
      assert.equal(persisted.revision, created.revision);

      const noPermission = contextFor(org.orgId, actors.adminId, []);
      await assert.rejects(
        run("create_field_ticket", { projectId, idempotencyKey: randomUUID() }, noPermission),
        /forbidden/,
      );
      const noSubsidiaries: ApplicationContext = {
        ...manager,
        authz: { ...manager.authz, allowedSubsidiaryIds: new Set() },
      };
      await assert.rejects(
        run("create_field_ticket", { projectId, idempotencyKey: randomUUID() }, noSubsidiaries),
        /subsidiary\.restricted/,
      );

      const deleted = (await run("delete_draft_field_ticket", {
        ticketId: created.id,
        expectedRevision: created.revision,
        idempotencyKey: randomUUID(),
      })) as { id: string };
      assert.equal(deleted.id, created.id);
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          loadFieldTicket(org.orgId, created.id, {
            allowedSubsidiaryIds: manager.authz.allowedSubsidiaryIds,
          }),
        ),
        (error: unknown) =>
          error instanceof FieldTicketError && /Ticket not found/.test(error.message),
      );

      await setFieldTicketFeatures(org.orgId, true, false);
      await assert.rejects(
        run("create_field_ticket", { projectId, idempotencyKey: randomUUID() }),
        /field ticket not found/,
      );
      await setFieldTicketFeatures(org.orgId, false, true);
      await assert.rejects(
        run("create_field_ticket", { projectId, idempotencyKey: randomUUID() }),
        /field ticket not found/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
