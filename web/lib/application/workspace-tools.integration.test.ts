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
const { getFolder } = await import("../file-cabinet");
const { listSavedReportShortcuts } = await import("../saved-report-write");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

function ctxFor(orgId: string, userId: string, permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId,
        email: `${userId}@test`,
        name: "Workspace test",
        orgId,
        roles: [{ key: "workspace-role", name: "Workspace role" }],
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

async function setQueryConsole(orgId: string, enabled: boolean) {
  await withBypassContext(() =>
    db.execute(sql`
    update orgs set settings = jsonb_set(
      settings,
      '{features}',
      coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ queryConsole: enabled })}::jsonb,
      true
    ) where id = ${orgId}
  `),
  );
}

test(
  "workspace commands create folders idempotently and preserve org isolation",
  { skip: !DB },
  async () => {
    const first = await withBypassContext(() => createScratchOrg());
    const second = await withBypassContext(() => createScratchOrg());
    try {
      const actorA = await withBypassContext(() => seedFlowActors(first.orgId));
      const actorB = await withBypassContext(() => seedFlowActors(second.orgId));
      const ctxA = ctxFor(first.orgId, actorA.adminId, ["*"]);
      const ctxB = ctxFor(second.orgId, actorB.adminId, ["*"]);
      const run = (ctx: ApplicationContext, name: string, input: Record<string, unknown>) =>
        withOrgContext(ctx.authz.user.orgId, () =>
          executeApplicationTool(applicationTool(name)!, ctx, input),
        );

      const input = { name: "External agent folder", idempotencyKey: "workspace-folder-0001" };
      const created = (await run(ctxA, "create_folder", input)) as {
        id: string;
        replayed: boolean;
      };
      const replay = (await run(ctxA, "create_folder", input)) as { id: string; replayed: boolean };
      assert.equal(created.replayed, false);
      assert.equal(replay.replayed, true);
      assert.equal(replay.id, created.id);
      assert.ok(await withOrgContext(first.orgId, () => getFolder(first.orgId, created.id)));

      await assert.rejects(
        run(ctxB, "delete_folder", {
          folderId: created.id,
          idempotencyKey: "workspace-cross-org-1",
        }),
        /forbidden/,
      );
      assert.ok(await withOrgContext(first.orgId, () => getFolder(first.orgId, created.id)));
    } finally {
      await dropScratchOrg(first.orgId);
      await dropScratchOrg(second.orgId);
    }
  },
);

test("workspace query console enforces permission and feature gates", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    const ctx = ctxFor(org.orgId, actors.adminId, ["sql.execute"]);
    const run = (context: ApplicationContext, name = "query_console") =>
      withOrgContext(org.orgId, () =>
        executeApplicationTool(
          applicationTool(name)!,
          context,
          name === "query_console" ? { sql: "select 1 as result" } : {},
        ),
      );
    await setQueryConsole(org.orgId, false);
    await assert.rejects(run(ctx), /query console is disabled/i);
    await assert.rejects(run(ctxFor(org.orgId, actors.adminId, [])), /forbidden/);
    await setQueryConsole(org.orgId, true);
    const schema = (await run(ctx, "list_query_schema")) as { tables: unknown[] };
    assert.ok(Array.isArray(schema.tables));
    const result = (await run(ctx)) as { rows?: Array<{ result: number }> };
    assert.equal(result.rows?.[0]?.result, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "saved report shortcuts replay without duplication and delete through the native read path",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      const ctx = ctxFor(org.orgId, actors.adminId, ["reports.create", "reports.read"]);
      const run = (name: string, input: Record<string, unknown>) =>
        withOrgContext(org.orgId, () => executeApplicationTool(applicationTool(name)!, ctx, input));
      const input = {
        name: "Quarterly P&L",
        path: "/reports/pnl",
        params: { period: "quarter" },
        idempotencyKey: "workspace-report-shortcut-01",
      };
      const created = (await run("create_saved_report_shortcut", input)) as {
        savedReportId: string;
        replayed: boolean;
      };
      const replay = (await run("create_saved_report_shortcut", input)) as {
        savedReportId: string;
        replayed: boolean;
      };
      assert.equal(created.replayed, false);
      assert.equal(replay.replayed, true);
      assert.equal(replay.savedReportId, created.savedReportId);
      assert.equal(
        (await withOrgContext(org.orgId, () => listSavedReportShortcuts(org.orgId))).filter(
          (shortcut) => shortcut.id === created.savedReportId,
        ).length,
        1,
      );
      await run("delete_saved_report_shortcut", {
        savedReportId: created.savedReportId,
        idempotencyKey: "workspace-report-shortcut-delete-01",
      });
      assert.equal(
        (await withOrgContext(org.orgId, () => listSavedReportShortcuts(org.orgId))).some(
          (shortcut) => shortcut.id === created.savedReportId,
        ),
        false,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "insight cards and dashboards support idempotent authoring and revisioned edits",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      const ctx = ctxFor(org.orgId, actors.adminId, [
        "insights.create",
        "insights.read",
        "insights.publish",
        "gl.read",
      ]);
      const run = (name: string, input: Record<string, unknown>) =>
        withOrgContext(org.orgId, () => executeApplicationTool(applicationTool(name)!, ctx, input));

      const cardInput = {
        name: "Quarterly Ledger Insight",
        idempotencyKey: "workspace-insight-card-create-01",
      };
      const cardCreated = (await run("create_insight_card", cardInput)) as {
        cardId: string;
        replayed: boolean;
      };
      const cardReplay = (await run("create_insight_card", cardInput)) as {
        cardId: string;
        replayed: boolean;
      };
      assert.equal(cardCreated.replayed, false);
      assert.equal(cardReplay.replayed, true);
      assert.equal(cardReplay.cardId, cardCreated.cardId);
      const cardRead = (await run("get_insight_card", { cardId: cardCreated.cardId })) as {
        card: { name: string; updated_at: string };
      };
      const cardUpdated = (await run("update_insight_card", {
        cardId: cardCreated.cardId,
        expectedUpdatedAt: cardRead.card.updated_at,
        name: "Quarterly Ledger Insight Updated",
        idempotencyKey: "workspace-insight-card-update-01",
      })) as { card: { name: string } };
      assert.equal(cardUpdated.card.name, "Quarterly Ledger Insight Updated");

      const dashboardInput = {
        name: "Quarterly Finance Dashboard",
        layout: [],
        idempotencyKey: "workspace-insight-dashboard-create-01",
      };
      const dashboardCreated = (await run("create_insight_dashboard", dashboardInput)) as {
        dashboardId: string;
        replayed: boolean;
      };
      const dashboardReplay = (await run("create_insight_dashboard", dashboardInput)) as {
        dashboardId: string;
        replayed: boolean;
      };
      assert.equal(dashboardCreated.replayed, false);
      assert.equal(dashboardReplay.replayed, true);
      assert.equal(dashboardReplay.dashboardId, dashboardCreated.dashboardId);
      const dashboardRead = (await run("get_insight_dashboard", {
        dashboardId: dashboardCreated.dashboardId,
      })) as { dashboard: { updated_at: string } };
      const dashboardUpdated = (await run("update_insight_dashboard", {
        dashboardId: dashboardCreated.dashboardId,
        expectedUpdatedAt: dashboardRead.dashboard.updated_at,
        name: "Quarterly Finance Dashboard Updated",
        idempotencyKey: "workspace-insight-dashboard-update-01",
      })) as { dashboard: { name: string } };
      assert.equal(dashboardUpdated.dashboard.name, "Quarterly Finance Dashboard Updated");

      await run("delete_insight_card", {
        cardId: cardCreated.cardId,
        idempotencyKey: "workspace-insight-card-delete-01",
      });
      await run("delete_insight_dashboard", {
        dashboardId: dashboardCreated.dashboardId,
        idempotencyKey: "workspace-insight-dashboard-delete-01",
      });
      const remaining = (await run("list_insight_dashboards", {})) as {
        dashboards: Array<{ id: string }>;
      };
      assert.equal(
        remaining.dashboards.some((row) => row.id === dashboardCreated.dashboardId),
        false,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
