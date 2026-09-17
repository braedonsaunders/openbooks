import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    return next(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { activeStockLocations, profiledItemIds, resolveLineStockLocation } = await import("./stock-locations.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

// F-t07-003 pickers: one resolution rule for the order and document writers.
// A scratch org ships two active warehouses (MAIN + STAGE) and profiled
// moving-average/fifo items plus an unprofiled service item.
test("explicit warehouses validate against the org's active locations", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const scope = {
      active: await withBypassContext(() => activeStockLocations(org.orgId)),
      profiled: await withBypassContext(() => profiledItemIds(org.orgId, [org.items.movingAvg])),
    };
    assert.equal(scope.active.length, 2);
    assert.deepEqual(resolveLineStockLocation(1, org.items.movingAvg, org.stockLocationId, scope), {
      locationId: org.stockLocationId,
    });
    const malformed = resolveLineStockLocation(2, org.items.movingAvg, "not-a-uuid", scope);
    assert.ok("error" in malformed);
    assert.match(malformed.error, /invalid stock location/);
    const foreign = resolveLineStockLocation(3, org.items.movingAvg, randomUUID(), scope);
    assert.ok("error" in foreign);
    assert.match(foreign.error, /not an active warehouse/);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("an inactive warehouse cannot be chosen explicitly", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(() => db.execute(sql`
      update stock_locations set is_active = false where id = ${org.stockLocationId2} and org_id = ${org.orgId}`));
    const scope = {
      active: await withBypassContext(() => activeStockLocations(org.orgId)),
      profiled: await withBypassContext(() => profiledItemIds(org.orgId, [org.items.movingAvg])),
    };
    assert.equal(scope.active.length, 1);
    const inactive = resolveLineStockLocation(1, org.items.movingAvg, org.stockLocationId2, scope);
    assert.ok("error" in inactive);
    assert.match(inactive.error, /not an active warehouse/);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a blank stocked line defaults silently only with exactly one location", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const two = {
      active: await withBypassContext(() => activeStockLocations(org.orgId)),
      profiled: await withBypassContext(() => profiledItemIds(org.orgId, [org.items.movingAvg, org.items.service])),
    };
    // Two warehouses: the answer is ambiguous, so the line stays blank for
    // the picker.
    assert.deepEqual(
      resolveLineStockLocation(1, org.items.movingAvg, null, two),
      { locationId: null },
    );
    await withBypassContext(() => db.execute(sql`
      update stock_locations set is_active = false where id = ${org.stockLocationId2} and org_id = ${org.orgId}`));
    const one = {
      active: await withBypassContext(() => activeStockLocations(org.orgId)),
      profiled: two.profiled,
    };
    // One warehouse: never make the user answer a question with one
    // possible answer.
    assert.deepEqual(
      resolveLineStockLocation(1, org.items.movingAvg, null, one),
      { locationId: org.stockLocationId },
    );
    // A non-stocked item has no picker and takes no default.
    assert.deepEqual(
      resolveLineStockLocation(2, org.items.service, null, one),
      { locationId: null },
    );
    assert.deepEqual(
      resolveLineStockLocation(3, null, null, one),
      { locationId: null },
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
