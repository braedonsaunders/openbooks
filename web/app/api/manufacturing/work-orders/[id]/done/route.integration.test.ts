import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

const gateKey = Symbol.for("openbooks.work-order-done-route-test");
const gateState: { authz: unknown } = { authz: null };
Object.assign(globalThis, { [gateKey]: gateState });
const realAuthz = new URL("../../../../../../lib/authz.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@/lib/feature-gates")
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function guardFeaturePermission(){return globalThis[Symbol.for("openbooks.work-order-done-route-test")].authz ?? new Response(null,{status:401})}`,
          ),
      };
    if (specifier === "@/lib/authz" && context.parentURL?.includes("/manufacturing/work-orders/"))
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`export { can, guardSubsidiaryScope } from '${realAuthz}'`),
      };
    return next(specifier, context);
  },
});

const { POST } = await import("./route.ts");
const { db, withBypassContext, withOrgTransaction } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/testing/fixtures");
const { createWorkOrder } = await import("@openbooks/engine/manufacturing/work-orders");
const { createWorkOperator } = await import("@openbooks/engine/testing/manufacturing");

test("work-order completion validates options before applying lifecycle rules", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const grants = ["items.post", "manufacturing.manage"];
    const actorId = await withBypassContext(() =>
      createWorkOperator(org.orgId, "Work-order operator", grants),
    );
    const feature = await withBypassContext(() =>
      db.execute(
        sql`
      update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"manufacturing":true,"inventory":true,"warehousing":true}'::jsonb)
      where id=${org.orgId} returning id`,
        "objects",
      ),
    );
    assert.equal(
      feature.length,
      1,
      "manufacturing feature setup must affect exactly one organization",
    );
    const order = await withOrgTransaction(org.orgId, () =>
      createWorkOrder(db, org.orgId, actorId, {
        producedItemId: org.items.assembly,
        quantityOrdered: "1",
        subsidiaryId: org.subsidiaryId,
      }),
    );
    gateState.authz = {
      user: { id: actorId, orgId: org.orgId, roles: [] },
      permissions: new Set(grants),
      allowedSubsidiaryIds: null,
    };
    const call = async (body: object) =>
      POST(
        new Request("http://openbooks.test/api/manufacturing/work-orders/" + order.id + "/done", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: order.id }) },
      );
    const malformed = await call({ shortCloseReason: "x" });
    assert.equal(malformed.status, 422);
    assert.match(
      ((await malformed.json()) as { error: string }).error,
      /shortCloseReason|5|too small/i,
    );
    const ordinary = await call({});
    assert.equal(ordinary.status, 409);
    assert.match(
      ((await ordinary.json()) as { error: string }).error,
      /cannot be marked done from draft/i,
    );
    const withReason = await call({ shortCloseReason: "Controlled short close" });
    assert.equal(withReason.status, 409);
    assert.match(
      ((await withReason.json()) as { error: string }).error,
      /cannot be marked done from draft/i,
    );
  } finally {
    gateState.authz = null;
    await dropScratchOrg(org.orgId);
    hooks.deregister();
  }
});
