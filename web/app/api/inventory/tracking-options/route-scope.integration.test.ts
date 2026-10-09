import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";
import { createInventoryOperator } from "@openbooks/engine/src/testing/inventory-counts.ts";
import { inventoryTrackingOptions, type InventoryTrackingOptions } from "@openbooks/engine/inventory";
import { ensureLot, ensureSerial } from "@openbooks/engine/src/inventory/tracking.ts";
import { receiveInventory } from "@openbooks/engine/src/inventory/movements.ts";
import { moveConsignment } from "@openbooks/engine/src/inventory/consignment.ts";
import { setStockHold } from "@openbooks/engine/src/inventory/stock-holds.ts";
import { ScopeNotFoundError } from "@openbooks/engine/src/organization/subsidiary-scope.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const session = { orgId: "", actorId: "" };
Object.assign(globalThis, { __trackingOptionsSession: session });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@/lib/feature-gates") return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(`
        export async function guardFeaturePermission() {
          const s = globalThis.__trackingOptionsSession;
          return {user:{orgId:s.orgId,id:s.actorId},permissions:new Set(['*']),allowedSubsidiaryIds:null};
        }`),
    };
    return next(specifier, context);
  },
});
const { GET } = await import("./route.ts");
const run = <T>(work: () => Promise<T>) => withBypassContext(work);
const call = (itemId: string, filters: { q?: string; lotId?: string } = {}) =>
  withOrgContext(session.orgId, () => GET(new Request(
    `http://inventory.test/api/inventory/tracking-options?${new URLSearchParams({ itemId, ...filters })}`,
  )));
async function options(itemId: string, filters: { q?: string; lotId?: string } = {}) {
  const response = await call(itemId, filters);
  assert.equal(response.status, 200);
  return await response.json() as InventoryTrackingOptions;
}

test("identifier selection rechecks native authority and hides movement and custody entities behind a stale session", { skip: !DB }, async () => {
  const org = await run(() => createScratchOrg());
  let foreign: Awaited<ReturnType<typeof createScratchOrg>> | undefined;
  try {
    foreign = await run(() => createScratchOrg());
    const admin = await run(() => createInventoryOperator(org.orgId, "Inventory administrator"));
    const reader = await run(() => createScratchUser(org.orgId, "Scoped receiver", "tracking_reader"));
    const hidden = randomUUID(), custodyLocation = randomUUID();
    const changed = await run(() => db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
      coalesce(settings->'features','{}'::jsonb)||'{"inventory":true,"consignment":true}'::jsonb)
      where id=${org.orgId} returning id`));
    assert.equal(changed.rows.length, 1);
    assert.equal((await run(() => db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
      values(${hidden},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA') returning id`))).rows.length, 1);
    assert.equal((await run(() => db.execute(sql`insert into stock_locations
      (id,org_id,location_id,code,kind,is_active,inventory_ownership,owner_party_id)
      values(${custodyLocation},${org.orgId},${org.locationId},'VENDOR-CUSTODY','bin',true,'vendor',${org.vendorId}) returning id`))).rows.length, 1);
    assert.equal((await run(() => db.execute(sql`update item_inventory_profiles set tracking='lot_serial'
      where org_id=${org.orgId} and item_id=${org.items.fifo} returning id`))).rows.length, 1);
    async function restrict(ids: string[], permissions = ["items.read", "items.manage"]) {
      const role = await run(() => db.execute(sql`update app_roles set
        permissions=${JSON.stringify(permissions)}::jsonb,
        subsidiary_restriction=${JSON.stringify({ mode: "list", subsidiaryIds: ids })}::jsonb
        where org_id=${org.orgId} and key='tracking_reader' returning id`));
      assert.equal(role.rows.length, 1);
    }
    await restrict([org.subsidiaryId]);
    async function register(label: string, actorId = admin) {
      const lotId = await run(() => ensureLot(org.orgId, org.items.fifo, `${label}-LOT`, "2027-01-01", actorId));
      const serialId = await run(() => ensureSerial(org.orgId, org.items.fifo, `${label}-SERIAL`, null, actorId));
      return { lotId, serialId };
    }
    async function stock(label: string, subsidiaryId: string, custody: boolean) {
      const identifiers = await register(label);
      if (custody) await run(() => moveConsignment(org.orgId, admin, {
        action: "receive", itemId: org.items.fifo, stockLocationId: custodyLocation, subsidiaryId,
        quantity: "1", date: org.date, reason: "Receive vendor-owned inventory", ...identifiers,
      }));
      else await run(() => receiveInventory(org.orgId, admin, {
        itemId: org.items.fifo, stockLocationId: org.stockLocationId, subsidiaryId,
        quantity: "1", unitCost: "3", date: org.date, offsetAccountId: org.accounts.clearing, ...identifiers,
      }));
      return identifiers;
    }
    const visible = await stock("VISIBLE", org.subsidiaryId, false);
    const invisible = await stock("HIDDEN", hidden, false);
    const visibleCustody = await stock("VISIBLE-CUSTODY", org.subsidiaryId, true);
    const hiddenCustody = await stock("HIDDEN-CUSTODY", hidden, true);
    await run(() => setStockHold(org.orgId, admin, { kind: "lot", id: invisible.lotId, held: true, reason: "Hidden inspection reason" }));
    await run(() => setStockHold(org.orgId, admin, { kind: "serial", id: hiddenCustody.serialId, held: true, reason: "Hidden serial inspection" }));
    await run(() => setStockHold(org.orgId, admin, { kind: "lot", id: visible.lotId, held: true, reason: "Visible inspection reason" }));
    const ownUnused = await register("OWN-REGISTRATION", reader);
    await register("OTHER-REGISTRATION");
    session.orgId = org.orgId; session.actorId = reader;
    const projected = await options(org.items.fifo);
    assert.equal(projected.tracking, "lot_serial");
    assert.deepEqual(new Set(projected.lots.map(row => row.id)), new Set([visible.lotId, visibleCustody.lotId, ownUnused.lotId]));
    assert.deepEqual(new Set(projected.serials.map(row => row.id)), new Set([visible.serialId, visibleCustody.serialId, ownUnused.serialId]));
    assert.equal(projected.lots.find(row => row.id === visible.lotId)?.expiry, "2027-01-01");
    assert.equal(projected.lots.find(row => row.id === visible.lotId)?.hold_reason, "Visible inspection reason");
    assert.doesNotMatch(JSON.stringify(projected), /HIDDEN|Hidden inspection|Hidden serial|OTHER-REGISTRATION/);
    assert.deepEqual(await withOrgContext(org.orgId, () => inventoryTrackingOptions(org.orgId, reader, { itemId: org.items.fifo })), projected);
    assert.deepEqual((await options(org.items.fifo, { q: "HIDDEN" })).lots, []);
    assert.deepEqual((await options(org.items.fifo, { q: "HIDDEN" })).serials, []);
    assert.equal((await call(org.items.fifo, { lotId: invisible.lotId })).status, 404);
    const selection = await options(org.items.fifo, { lotId: visible.lotId });
    assert.ok(selection.serials.some(row => row.id === visible.serialId));
    assert.ok(selection.serials.every(row => row.lot_id === null || row.lot_id === visible.lotId));
    await run(() => receiveInventory(org.orgId, admin, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, subsidiaryId: hidden,
      quantity: "1", unitCost: "3", date: org.date, offsetAccountId: org.accounts.clearing, ...ownUnused,
    }));
    const assigned = await options(org.items.fifo);
    assert.ok(!assigned.lots.some(row => row.id === ownUnused.lotId), "first use replaces registration visibility with entity lineage");
    assert.ok(!assigned.serials.some(row => row.id === ownUnused.serialId));
    assert.equal((await call(foreign.items.fifo)).status, 404);
    const foreignLot = await run(() => ensureLot(foreign!.orgId, foreign!.items.fifo, "FOREIGN", null, null));
    assert.equal((await call(org.items.fifo, { lotId: foreignLot })).status, 404);
    session.actorId = admin;
    const unrestricted = await options(org.items.fifo);
    assert.ok(unrestricted.lots.some(row => row.id === invisible.lotId));
    assert.ok(unrestricted.serials.some(row => row.id === hiddenCustody.serialId));
    assert.ok(unrestricted.lots.some(row => row.label === "OTHER-REGISTRATION-LOT"));
    session.actorId = reader;
    await restrict([]);
    assert.deepEqual(await options(org.items.fifo), { tracking: "lot_serial", lots: [], serials: [] });
    await restrict([org.subsidiaryId], []);
    assert.equal((await call(org.items.fifo)).status, 404);
    await assert.rejects(withOrgContext(org.orgId, () => inventoryTrackingOptions(org.orgId, reader, { itemId: org.items.fifo })), ScopeNotFoundError);
    await restrict([org.subsidiaryId]);
    session.actorId = await run(() => createInventoryOperator(foreign!.orgId, "Foreign operator"));
    assert.equal((await call(org.items.fifo)).status, 404);
    session.actorId = randomUUID();
    assert.equal((await call(org.items.fifo)).status, 404);
    session.actorId = reader;
    assert.equal((await run(() => db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,inventory}','false'::jsonb)
      where id=${org.orgId} returning id`))).rows.length, 1);
    assert.equal((await call(org.items.fifo)).status, 404);
    await assert.rejects(withOrgContext(org.orgId, () => inventoryTrackingOptions(org.orgId, reader, { itemId: org.items.fifo })), ScopeNotFoundError);
  } finally {
    session.orgId = ""; session.actorId = "";
    if (foreign) await run(() => dropScratchOrg(foreign!.orgId));
    await run(() => dropScratchOrg(org.orgId));
  }
});
