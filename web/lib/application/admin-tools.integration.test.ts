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
const { listAutomations } = await import("@openbooks/engine/automations/services");
const { readWebhookEndpointActivity } = await import("@openbooks/engine/webhooks");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
const { ADMIN_APPLICATION_TOOLS } = await import("./admin-tools.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

function ctxFor(orgId: string, userId: string, permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId,
        email: `${userId}@test`,
        name: "Test",
        orgId,
        roles: [{ key: "admin-test", name: "Admin test" }],
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

async function setFeatures(orgId: string, features: Record<string, boolean>): Promise<void> {
  await withBypassContext(async () => {
    const updated = await db.execute<{ id: string }>(
      sql`
        update orgs
           set settings = jsonb_set(
             coalesce(settings, '{}'::jsonb),
             '{features}',
             coalesce(settings -> 'features', '{}'::jsonb) || ${JSON.stringify(features)}::jsonb,
             true
           )
         where id = ${orgId}
         returning id
      `,
      "objects",
    );
    assert.equal(updated.length, 1, "feature settings must update exactly one organization");
  });
}

function runAs(
  orgId: string,
  context: ApplicationContext,
  name: string,
  input: Record<string, unknown>,
) {
  return withOrgContext(orgId, () =>
    executeApplicationTool(applicationTool(name)!, context, input),
  );
}

test("admin commands are hidden from actors without permissions", () => {
  const context = ctxFor("00000000-0000-4000-8000-000000000002", "permissionless", []);
  for (const tool of ADMIN_APPLICATION_TOOLS) {
    assert.equal(
      tool.visibleTo(context.authz),
      false,
      `${tool.name} must not be visible to an actor without permissions`,
    );
  }
});

test(
  "admin commands create and enable an automation with replay protection",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      await setFeatures(org.orgId, { flows: true, automations: true, automationSimulator: true });
      const context = ctxFor(org.orgId, actors.adminId, ["automations.manage", "automations.read"]);
      const input = {
        name: "Admin command integration",
        trigger: { kind: "manual" },
        actions: [{ kind: "send_notification", to: "initiator", body: "Integration run." }],
        idempotencyKey: "admin-automation-create-01",
      };

      const first = (await runAs(org.orgId, context, "create_automation", input)) as {
        replayed: boolean;
        automationId: string;
      };
      assert.equal(first.replayed, false);
      const replay = (await runAs(org.orgId, context, "create_automation", input)) as {
        replayed: boolean;
        automationId: string;
      };
      assert.equal(replay.replayed, true);
      assert.equal(replay.automationId, first.automationId);

      const stored = await withOrgContext(org.orgId, () =>
        listAutomations(org.orgId, actors.adminId),
      );
      assert.equal(stored.filter((automation) => automation.id === first.automationId).length, 1);
      assert.equal(
        stored.find((automation) => automation.id === first.automationId)?.status,
        "draft",
      );

      await runAs(org.orgId, context, "set_automation_status", {
        automationId: first.automationId,
        status: "enabled",
        idempotencyKey: "admin-automation-enable-01",
      });
      const enabled = await withOrgContext(org.orgId, () =>
        listAutomations(org.orgId, actors.adminId),
      );
      assert.equal(
        enabled.find((automation) => automation.id === first.automationId)?.status,
        "enabled",
      );

      const simulation = (await runAs(org.orgId, context, "simulate_automation", {
        automationId: first.automationId,
      })) as { simulations: unknown[] };
      assert.ok(Array.isArray(simulation.simulations));
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "user administration commands preserve the native self-role-assignment refusal",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      const roles = await withOrgContext(org.orgId, () =>
        db.execute<{ id: string }>(
          sql`select id from app_roles where org_id = ${org.orgId} and key = 'approver' limit 1`,
          "objects",
        ),
      );
      assert.ok(roles[0], "the native fixture must create an assignable organization role");
      const context = ctxFor(org.orgId, actors.adminId, ["admin.users.manage"]);
      await assert.rejects(
        runAs(org.orgId, context, "assign_user_role", {
          userId: actors.adminId,
          roleId: roles[0]!.id,
          idempotencyKey: "admin-user-self-role-refusal-01",
        }),
        (error: unknown) =>
          error instanceof Error &&
          "status" in error &&
          error.status === 403 &&
          error.message.includes("you cannot grant a role to yourself"),
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "admin webhook commands isolate organizations and refuse missing permission or disabled feature",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const otherOrg = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      const otherActors = await withBypassContext(() => seedFlowActors(otherOrg.orgId));
      await setFeatures(org.orgId, { apiAccess: true, outboundWebhooks: true });
      await setFeatures(otherOrg.orgId, { apiAccess: true, outboundWebhooks: true });
      const context = ctxFor(org.orgId, actors.adminId, ["webhooks.manage", "webhooks.read"]);
      const createInput = {
        key: "admin-integration-endpoint",
        url: "http://127.0.0.1:3939/hooks/openbooks",
        events: ["item.updated"],
        idempotencyKey: "admin-webhook-create-01",
      };
      const created = (await runAs(org.orgId, context, "create_webhook_endpoint", createInput)) as {
        replayed: boolean;
        endpointId: string;
        secret: string;
      };
      assert.equal(created.replayed, false);
      assert.ok(created.secret.length > 20);

      const replayed = (await runAs(
        org.orgId,
        context,
        "create_webhook_endpoint",
        createInput,
      )) as {
        replayed: boolean;
        endpointId: string;
      };
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.endpointId, created.endpointId);

      const activity = await withOrgContext(org.orgId, () =>
        readWebhookEndpointActivity(org.orgId, created.endpointId),
      );
      assert.equal(activity.endpoint?.key, createInput.key);
      assert.deepEqual(activity.endpoint?.events, ["item.updated"]);

      await assert.rejects(
        runAs(org.orgId, ctxFor(org.orgId, actors.adminId, []), "get_webhook_endpoint_activity", {
          endpointId: created.endpointId,
        }),
        (error: unknown) =>
          error instanceof Error && /forbidden|webhooks\.read/.test(error.message),
      );

      await assert.rejects(
        runAs(
          otherOrg.orgId,
          ctxFor(otherOrg.orgId, otherActors.adminId, ["webhooks.read"]),
          "get_webhook_endpoint_activity",
          { endpointId: created.endpointId },
        ),
        (error: unknown) => error instanceof Error && "status" in error && error.status === 404,
      );

      await setFeatures(otherOrg.orgId, { outboundWebhooks: false });
      await assert.rejects(
        runAs(
          otherOrg.orgId,
          ctxFor(otherOrg.orgId, otherActors.adminId, ["webhooks.manage"]),
          "create_webhook_endpoint",
          { ...createInput, key: "feature-off-endpoint", idempotencyKey: "admin-webhook-off-01" },
        ),
        /needs the outboundWebhooks feature/,
      );
      const otherEndpoints = await withOrgContext(otherOrg.orgId, () =>
        db.execute<{ id: string }>(
          sql`select id from webhook_endpoints where org_id = ${otherOrg.orgId} and key = 'feature-off-endpoint'`,
          "objects",
        ),
      );
      assert.equal(otherEndpoints.length, 0);

      await setFeatures(otherOrg.orgId, {
        flows: true,
        apiAccess: true,
        outboundWebhooks: true,
        automations: true,
        automationSimulator: false,
      });
      const automationContext = ctxFor(otherOrg.orgId, otherActors.adminId, [
        "automations.manage",
        "automations.read",
      ]);
      const createdAutomation = (await runAs(
        otherOrg.orgId,
        automationContext,
        "create_automation",
        {
          name: "Simulator feature gate",
          trigger: { kind: "manual" },
          actions: [{ kind: "send_notification", to: "initiator", body: "Feature gate test." }],
          idempotencyKey: "admin-automation-feature-01",
        },
      )) as { automationId: string };
      await assert.rejects(
        runAs(otherOrg.orgId, automationContext, "simulate_automation", {
          automationId: createdAutomation.automationId,
        }),
        (error: unknown) => error instanceof Error && "status" in error && error.status === 404,
      );
    } finally {
      await dropScratchOrg(otherOrg.orgId);
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "transaction form commands create, edit, and set defaults through the native layout path",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const otherOrg = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      const otherActors = await withBypassContext(() => seedFlowActors(otherOrg.orgId));
      const context = ctxFor(org.orgId, actors.adminId, ["admin.customization.manage"]);
      const createInput = {
        recordType: "vendor_bill",
        name: "Agent command vendor bill",
        isDefault: false,
        idempotencyKey: "admin-form-layout-create-01",
      };

      const created = (await runAs(org.orgId, context, "create_transaction_form", createInput)) as {
        replayed: boolean;
        id: string;
      };
      assert.equal(created.replayed, false);
      const replay = (await runAs(org.orgId, context, "create_transaction_form", createInput)) as {
        replayed: boolean;
        id: string;
      };
      assert.equal(replay.replayed, true);
      assert.equal(replay.id, created.id);

      await runAs(org.orgId, context, "update_transaction_form", {
        id: created.id,
        name: "Agent command default vendor bill",
        isDefault: true,
        idempotencyKey: "admin-form-layout-update-01",
      });
      const stored = await withOrgContext(org.orgId, () =>
        db.execute<{ id: string; name: string; isDefault: boolean; recordType: string }>(
          sql`
            select id, name, is_default as "isDefault", record_type as "recordType"
              from form_layouts
             where org_id = ${org.orgId} and id = ${created.id}
          `,
          "objects",
        ),
      );
      assert.equal(stored.length, 1);
      assert.equal(stored[0]!.name, "Agent command default vendor bill");
      assert.equal(stored[0]!.isDefault, true);
      assert.equal(stored[0]!.recordType, "vendor_bill");

      await assert.rejects(
        runAs(
          otherOrg.orgId,
          ctxFor(otherOrg.orgId, otherActors.adminId, []),
          "get_transaction_form",
          {
            id: created.id,
          },
        ),
        (error: unknown) => error instanceof Error && error.message === "forbidden",
      );
      await assert.rejects(
        runAs(
          otherOrg.orgId,
          ctxFor(otherOrg.orgId, otherActors.adminId, ["admin.customization.manage"]),
          "get_transaction_form",
          { id: created.id },
        ),
        (error: unknown) => error instanceof Error && "status" in error && error.status === 404,
      );
    } finally {
      await dropScratchOrg(otherOrg.orgId);
      await dropScratchOrg(org.orgId);
    }
  },
);
