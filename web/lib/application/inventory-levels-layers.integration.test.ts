import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// Levels value must come from open cost layers — the same source as the
// native on-hand list and the GL tie-out. NRV writedowns and landed-cost
// adjustments rewrite layers plus GL and write no movement rows, so a
// movement sum overstates value after either.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { receiveInventory } = await import("@openbooks/engine/src/inventory/movements.ts");
const { writeDownInventoryToNrv } = await import("@openbooks/engine/src/inventory/nrv.ts");
const { postLandedCostVoucher } = await import("@openbooks/engine/src/inventory/landed-cost.ts");
const { listApplicationInventoryLevels } = await import("./inventory-read.ts");
const { ApplicationError } = await import("./errors.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

function ctxFor(orgId: string): ApplicationContext {
  return {
    authz: {
      user: {
        id: randomUUID(), email: "levels@test", name: "Levels", orgId,
        roles: [], envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
        homeUserId: "u", homeOrgId: orgId,
      },
      permissions: new Set(["items.read"]),
      allowedSubsidiaryIds: null,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
  };
}

test("levels value follows layers through a writedown and a landed-cost adjustment", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await db.execute(sql`
      update orgs set settings = settings || '{"features":{"inventory":true}}'::jsonb where id = ${org.orgId}`);
    const position = {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId,
      subsidiaryId: org.subsidiaryId, date: org.date,
    };
    await receiveInventory(org.orgId, null, {
      ...position, quantity: "10", unitCost: "5", offsetAccountId: org.accounts.clearing,
    });
    const context = ctxFor(org.orgId);
    assert.equal((await listApplicationInventoryLevels(context, {})).levels[0]?.value, "50.0000");
    // Value-only remeasurement: layers 50 -> 40, movements still sum 50.
    await writeDownInventoryToNrv(org.orgId, null, { ...position, nrvPerUnit: "4" });
    // Capitalized freight: layers 40 -> 46, still no movement row.
    await postLandedCostVoucher(org.orgId, null, {
      amount: "6", basis: "value", freightAccountId: org.accounts.freight,
      subsidiaryId: org.subsidiaryId, voucherDate: org.date,
      targets: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId, manualAmount: null }],
    });
    const layers = (await db.execute<{ quantity: string; value: string }>(sql`
      select sum(remaining_quantity)::text as quantity,
             sum(round(remaining_quantity * unit_cost, 4))::text as value
        from cost_layers
       where org_id = ${org.orgId} and item_id = ${org.items.fifo}
         and stock_location_id = ${org.stockLocationId}`)).rows[0]!;
    const gl = (await db.execute<{ balance: string }>(sql`
      select coalesce(sum(amount), 0)::text as balance from journal_lines
       where org_id = ${org.orgId} and account_id = ${org.accounts.invAsset}`)).rows[0]!;
    const reported = await listApplicationInventoryLevels(context, {});
    assert.equal(reported.levels.length, 1);
    assert.equal(reported.levels[0]?.quantity, "10.0000");
    // A movement sum would still read 50.0000 here.
    assert.equal(reported.levels[0]?.value, "46.0000");
    assert.equal(reported.sumValue, "46.0000");
    assert.equal(layers.value, "46.0000");
    assert.equal(gl.balance, "46.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("inventory levels refuse while the inventory feature is off with the Features-page remedy", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await db.execute(sql`
      update orgs set settings = settings || '{"features":{"inventory":false}}'::jsonb where id = ${org.orgId}`);
    await assert.rejects(
      listApplicationInventoryLevels(ctxFor(org.orgId), {}),
      (error: unknown) => error instanceof ApplicationError
        && error.code === "not_found"
        && error.status === 404
        && error.message === "inventory is off; enable it from GET /api/v1/settings/features",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
