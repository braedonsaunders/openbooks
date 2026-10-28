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
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/testing/fixtures");
const { createWorkOperator } = await import("@openbooks/engine/testing/manufacturing");
const { getWorkOrder } = await import("@openbooks/engine/manufacturing/work-orders");
const { getWorkCenter } = await import("@openbooks/engine/manufacturing/work-centers");
const { getRouting } = await import("@openbooks/engine/manufacturing/routings");
const { getMrpRun } = await import("@openbooks/engine/manufacturing/mrp");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;
const GRANTS = [
  "manufacturing.manage",
  "manufacturing.read",
  "manufacturingMrp.read",
  "items.read",
  "items.post",
  "admin.setup.manage",
  "ap.read",
  "ap.create",
  "purchase_orders.create",
  "purchase_orders.read",
];

function contextFor(
  orgId: string,
  userId: string,
  permissions: string[] = GRANTS,
): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId,
        email: `${userId}@test`,
        name: "Manufacturing operator",
        orgId,
        roles: [{ key: "manufacturing-role", name: "Manufacturing role" }],
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

async function setManufacturingFeatures(orgId: string, manufacturing: boolean) {
  const rows = await withBypassContext(() =>
    db.execute(
      sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||${JSON.stringify(
        {
          inventory: true,
          manufacturing,
          manufacturingMrp: manufacturing,
          manufacturingSubcontract: manufacturing,
          warehousing: true,
        },
      )}::jsonb,true) where id=${orgId} returning id`,
      "objects",
    ),
  );
  assert.equal(rows.length, 1, "feature setup must affect exactly one organization");
}

async function operator(orgId: string) {
  return withBypassContext(() =>
    createWorkOperator(orgId, "Manufacturing application operator", GRANTS),
  );
}

async function run<T extends Record<string, unknown>>(
  orgId: string,
  context: ApplicationContext,
  name: string,
  input: T,
) {
  return withOrgContext(orgId, () =>
    executeApplicationTool(applicationTool(name)!, context, input),
  );
}

test(
  "manufacturing commands create and read work centers, routings and work orders with idempotent replay",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await setManufacturingFeatures(org.orgId, true);
      const actorId = await operator(org.orgId);
      const context = contextFor(org.orgId, actorId);
      const centerId = `center-${randomUUID()}`;
      const centerResult = (await run(org.orgId, context, "create_work_center", {
        code: `EXT-${centerId.slice(-8)}`,
        name: "External production center",
        subsidiaryId: org.subsidiaryId,
        kind: "machine",
        capacityHoursPerDay: "8",
        efficiencyPct: "100",
        departmentId: null,
        absorbsOverhead: false,
        calendarId: null,
        idempotencyKey: centerId,
      })) as { replayed: boolean; id: string };
      assert.equal(centerResult.replayed, false);
      const center = await withOrgContext(org.orgId, () =>
        getWorkCenter(db, org.orgId, centerResult.id),
      );
      assert.equal(center?.id, centerResult.id);

      const routingKey = `routing-${randomUUID()}`;
      const routingResult = (await run(org.orgId, context, "create_manufacturing_routing", {
        producedItemId: org.items.assembly,
        code: `EXT-${routingKey.slice(0, 8)}`,
        name: "External assembly routing",
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
        overheadBasis: "units",
        idempotencyKey: routingKey,
      })) as { replayed: boolean; id: string };
      assert.equal(routingResult.replayed, false);
      const routing = await withOrgContext(org.orgId, () =>
        getRouting(db, org.orgId, routingResult.id),
      );
      assert.equal(routing?.id, routingResult.id);

      const workOrderKey = `work-order-${randomUUID()}`;
      const workOrderInput = {
        producedItemId: org.items.assembly,
        quantityOrdered: "2",
        subsidiaryId: org.subsidiaryId,
        idempotencyKey: workOrderKey,
      };
      const first = (await run(org.orgId, context, "create_work_order", workOrderInput)) as {
        replayed: boolean;
        id: string;
        status: string;
      };
      const replay = (await run(org.orgId, context, "create_work_order", workOrderInput)) as {
        replayed: boolean;
        id: string;
      };
      assert.equal(first.replayed, false);
      assert.equal(replay.replayed, true);
      assert.equal(replay.id, first.id);
      const workOrder = await withOrgContext(org.orgId, () =>
        getWorkOrder(db, org.orgId, first.id),
      );
      assert.equal(workOrder?.status, "draft");
      assert.equal(workOrder?.quantityOrdered, "2.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "MRP commands run and read a saved plan through native projections",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await setManufacturingFeatures(org.orgId, true);
      const actorId = await operator(org.orgId);
      const context = contextFor(org.orgId, actorId);
      const started = (await run(org.orgId, context, "run_manufacturing_mrp", {
        subsidiaryId: org.subsidiaryId,
        horizonDays: 30,
        capacityCheck: false,
        idempotencyKey: `mrp-${randomUUID()}`,
      })) as { replayed: boolean; id: string };
      assert.equal(started.replayed, false);
      const native = await withOrgContext(org.orgId, () =>
        getMrpRun(db, org.orgId, started.id, null),
      );
      assert.equal(native.run.id, started.id);
      assert.ok(Array.isArray(native.suggestions));
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "manufacturing commands refuse missing permission and disabled feature and hide another organization's order",
  { skip: !DB },
  async () => {
    const first = await withBypassContext(() => createScratchOrg());
    const second = await withBypassContext(() => createScratchOrg());
    try {
      await setManufacturingFeatures(first.orgId, true);
      await setManufacturingFeatures(second.orgId, true);
      const firstActor = await operator(first.orgId);
      const secondActor = await operator(second.orgId);
      const firstContext = contextFor(first.orgId, firstActor);
      const deniedContext = contextFor(first.orgId, firstActor, []);
      await assert.rejects(
        run(first.orgId, deniedContext, "create_work_order", {
          producedItemId: first.items.assembly,
          quantityOrdered: "1",
          subsidiaryId: first.subsidiaryId,
          idempotencyKey: randomUUID(),
        }),
        /forbidden/,
      );

      const order = (await run(first.orgId, firstContext, "create_work_order", {
        producedItemId: first.items.assembly,
        quantityOrdered: "1",
        subsidiaryId: first.subsidiaryId,
        idempotencyKey: randomUUID(),
      })) as { id: string };
      const secondContext = contextFor(second.orgId, secondActor);
      await assert.rejects(
        withOrgContext(second.orgId, () =>
          executeApplicationTool(applicationTool("get_manufacturing_record")!, secondContext, {
            view: "work-orders",
            id: order.id,
          }),
        ),
        /not_found/,
      );

      await setManufacturingFeatures(first.orgId, false);
      await assert.rejects(
        run(first.orgId, firstContext, "create_work_order", {
          producedItemId: first.items.assembly,
          quantityOrdered: "1",
          subsidiaryId: first.subsidiaryId,
          idempotencyKey: randomUUID(),
        }),
        /needs the manufacturing feature/,
      );
    } finally {
      await dropScratchOrg(first.orgId);
      await dropScratchOrg(second.orgId);
    }
  },
);
