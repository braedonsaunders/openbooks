import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/testing/fixtures.ts";
import { receiveInventory } from "@openbooks/engine/src/inventory/movements.ts";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { withSimClock } from "@openbooks/engine/src/platform/clock.ts";

type InventorySessionUser = {
  id: string;
  orgId: string;
  name: string;
  email: string;
  roles: string[];
  isSuperAdmin: false;
  envKind: "production";
  productionOrgId: string;
  homeOrgId: string;
  homeUserId: string;
};
const state: { user: InventorySessionUser | null } = { user: null };
Object.assign(globalThis, { __inventoryApiAudit: state });
const realAuthz = new URL('./authz.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
        "export async function currentUser(){return globalThis.__inventoryApiAudit.user}",
      ) };
    }
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("/api/inventory/")) {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
        `export * from ${JSON.stringify(realAuthz)}; export async function guardPermission(){return {user:globalThis.__inventoryApiAudit.user,allowedSubsidiaryIds:null}}`,
      ) };
    }
    return next(specifier, context);
  },
});

for (const scenario of ["receive date", "receive subsidiary", "transfer subsidiary", "voucher subsidiary", "adjust cost", "landed basis", "receipt lot"] as const) {
  test(`inventory API refuses malformed ${scenario} without substituting financial instructions`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      state.user = inventorySession(org.orgId, actor);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true}'::jsonb) where id=${org.orgId}`);
      await receiveInventory(org.orgId, actor, { itemId: org.items.fifo, stockLocationId: org.stockLocationId,
        quantity: "5", unitCost: "10", subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date });
      const basic: Record<string, unknown> = { action: "receive", idempotencyKey: randomUUID(), itemId: org.items.fifo,
        stockLocationId: org.stockLocationId, subsidiaryId: org.subsidiaryId, date: org.date, quantity: "1", unitCost: "10", offsetAccountId: org.accounts.clearing };
      let advanced = false;
      let body = basic;
      if (scenario === "receive date") body.date = "not-a-date";
      if (scenario === "receive subsidiary") body.subsidiaryId = "not-an-entity";
      if (scenario === "adjust cost") { body.action = "adjust"; body.unitCost = "not-a-cost"; }
      if (scenario === "landed basis") { body.action = "landed"; body.basis = "not-an-allocation-policy"; }
      if (scenario === "receipt lot") body.lotId = "not-a-lot";
      if (scenario === "transfer subsidiary") {
        advanced = true;
        body = { action: "createTransfer", idempotencyKey: randomUUID(), subsidiaryId: "not-an-entity", orderedOn: org.date,
          fromStockLocationId: org.stockLocationId, toStockLocationId: org.stockLocationId2, lines: [{ itemId: org.items.fifo, quantity: "1" }] };
      }
      if (scenario === "voucher subsidiary") {
        advanced = true;
        body = { action: "postLandedVoucher", idempotencyKey: randomUUID(), subsidiaryId: "not-an-entity", voucherDate: org.date,
          amount: "1", basis: "value", freightAccountId: org.accounts.clearing, targets: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }] };
      }
      const { POST } = advanced ? await import("../app/api/inventory/advanced/route") : await import("../app/api/inventory/actions/route");
      const before = (await db.execute<{ n: number }>(sql`select count(*)::int as n from inventory_movements where org_id=${org.orgId}`)).rows[0]!.n;
      const response = await withSimClock(org.date, () => POST(new Request("http://audit.local/api/inventory", { method: "POST", body: JSON.stringify(body) })));
      assert.equal(response.status, 422, JSON.stringify(await response.json()));
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from inventory_movements where org_id=${org.orgId}`)).rows[0]!.n, before);
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from transfer_orders where org_id=${org.orgId}`)).rows[0]!.n, 0);
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from landed_cost_vouchers where org_id=${org.orgId}`)).rows[0]!.n, 0);
    } finally { state.user = null; await dropScratchOrg(org.orgId); }
  });
}

test("valid inventory requests retain omission defaults and exact idempotent replay", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    state.user = inventorySession(org.orgId, actor);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true}'::jsonb) where id=${org.orgId}`);
    // The transfer defaults to the deterministic transit warehouse among
    // active transit locations admitting its subsidiary. The scratch org
    // ships none, so seed one org-wide location (null subsidiary restriction
    // admits every entity) before the replay run below.
    await withBypassContext(() => db.execute(sql`insert into stock_locations (id, org_id, location_id, code, kind, is_active)
      values (${randomUUID()}, ${org.orgId}, ${org.locationId}, 'TRANSIT', 'transit', true)`));
    const { POST: basic } = await import("../app/api/inventory/actions/route");
    const { POST: advanced } = await import("../app/api/inventory/advanced/route");
    const requests = [
      { route: basic, status: 200, body: { action: "receive", idempotencyKey: randomUUID(), itemId: org.items.fifo,
        stockLocationId: org.stockLocationId, quantity: "5", unitCost: "10.1234", offsetAccountId: org.accounts.clearing } },
      { route: advanced, status: 201, body: { action: "createTransfer", idempotencyKey: randomUUID(),
        fromStockLocationId: org.stockLocationId, toStockLocationId: org.stockLocationId2, lines: [{ itemId: org.items.fifo, quantity: "1" }] } },
      { route: advanced, status: 201, body: { action: "postLandedVoucher", idempotencyKey: randomUUID(),
        amount: "2.5001", freightAccountId: org.accounts.clearing, targets: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }] } },
    ];
    for (const input of requests) {
      const request = () => new Request("http://audit.local/api/inventory", { method: "POST", body: JSON.stringify(input.body) });
      const first = await withSimClock(org.date, () => input.route(request()));
      const result = await first.json();
      assert.equal(first.status, input.status, JSON.stringify(result));
      assert.equal(result.replayed, false);
      const retry = await withSimClock(org.date, () => input.route(request()));
      const replay = await retry.json();
      assert.equal(retry.status, input.status, JSON.stringify(replay));
      assert.deepEqual(replay, { ...result, replayed: true });
    }
    const movements = (await db.execute<{ moved_on: string; subsidiary_id: string }>(sql`
      select moved_at::date::text as moved_on,subsidiary_id from inventory_movements where org_id=${org.orgId}`)).rows;
    assert.equal(movements.length, 1);
    assert.equal(movements[0]!.moved_on, await withSimClock(org.date, () => businessToday(org.orgId)));
    assert.equal(movements[0]!.subsidiary_id, org.subsidiaryId);
    assert.equal((await db.execute(sql`select entry_id from journal_lines where org_id=${org.orgId} group by entry_id having sum(amount)<>0`)).rows.length, 0);
  } finally { state.user = null; await dropScratchOrg(org.orgId); }
});

function inventorySession(orgId: string, id: string): InventorySessionUser {
  return {
    id,
    orgId,
    name: "Inventory controller",
    email: "inventory@scratch.test",
    roles: [],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: id,
  };
}


const inventoryFeatureCases = [
  { label: "inventory costing feature race", register: async () => {
        const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
        const test = (await import("node:test")).default;
        const { sql } = await import("drizzle-orm");
        const { withBypassContext, db, pool } = await import("@openbooks/engine/src/platform/db.ts");
        const { documentRevisionSql } = await import("@openbooks/engine/src/records/revision.ts");
        const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const { PUT } = await import("../app/api/items/[id]/costing/route");

        for (const field of ["cogsAccountId", "adjustmentAccountId", "varianceAccountId", "receivedNotBilledAccountId"] as const) {
          test(`costing profile refuses ${field} aliasing its asset account`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
            const org = await withBypassContext(() => (createScratchOrg()));
            try {
              const actorId = (await withBypassContext(() => (seedFlowActors(org.orgId)))).adminId;
              state.user = inventorySession(org.orgId, actorId);
              await withBypassContext(() => db.execute(sql`
                update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true}'::jsonb)
                 where id=${org.orgId}`));
              await withBypassContext(() => db.execute(sql`
                update app_roles set permissions='["items.manage"]'::jsonb, subsidiary_restriction='{"mode":"all"}'::jsonb
                 where org_id=${org.orgId} and key='admin'`));
              const revision = (await db.execute<{ revision: string }>(sql`select ${documentRevisionSql(sql`updated_at`)} as revision
                from item_inventory_profiles where org_id=${org.orgId} and item_id=${org.items.fifo}`)).rows[0]!.revision;
              const evidence = async () => (await db.execute(sql`select to_jsonb(p) as profile,
                (select count(*)::int from audit_log where org_id=${org.orgId} and table_name='item_inventory_profiles') as audits
                from item_inventory_profiles p where org_id=${org.orgId} and item_id=${org.items.fifo}`)).rows;
              const before = await evidence();
              const body = { costingMethod: "fifo", tracking: "none", expectedUpdatedAt: revision,
                assetAccountId: org.accounts.invAsset, cogsAccountId: org.accounts.cogs,
                baseUnit: "ea",
                adjustmentAccountId: org.accounts.adjustment, varianceAccountId: org.accounts.adjustment,
                receivedNotBilledAccountId: org.accounts.clearing };
              const request = (value: object) => PUT(new Request("http://localhost/api/items/" + org.items.fifo + "/costing", {
                method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
              }), { params: Promise.resolve({ id: org.items.fifo }) });
              const denied = await request({ ...body, [field]: org.accounts.invAsset.toUpperCase() });
              assert.equal(denied.status, 422);
              assert.match((await denied.json()).error, /account must be distinct/);
              assert.deepEqual(await evidence(), before);
              const allowed = await request(body);
              assert.equal(allowed.status, 200, JSON.stringify(await allowed.json()));
            } finally { state.user = null; await dropScratchOrg(org.orgId); }
          });
        }

        test("costing profile write rechecks Inventory after a concurrent disable", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => (createScratchOrg()));
          const writer = await pool.connect();
          let pending: Promise<Awaited<ReturnType<typeof PUT>>> | undefined;
          try {
            const actorId = (await withBypassContext(() => (seedFlowActors(org.orgId)))).adminId;
            state.user = inventorySession(org.orgId, actorId);
            await withBypassContext(() => db.execute(sql`
              update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true}'::jsonb)
               where id=${org.orgId}`));
            await withBypassContext(() => db.execute(sql`
              update app_roles set permissions='["items.manage"]'::jsonb, subsidiary_restriction='{"mode":"all"}'::jsonb
               where org_id=${org.orgId} and key='admin'`));
            const revision = (await db.execute<{ revision: string }>(sql`select ${documentRevisionSql(sql`updated_at`)} as revision
              from item_inventory_profiles where org_id=${org.orgId} and item_id=${org.items.fifo}`)).rows[0]!.revision;
            const evidence = async () => (await db.execute(sql`select to_jsonb(p) as profile,
              (select count(*)::int from audit_log where org_id=${org.orgId} and table_name='item_inventory_profiles') as audits
              from item_inventory_profiles p where org_id=${org.orgId} and item_id=${org.items.fifo}`)).rows;
            const before = await evidence();
            const request = () => PUT(new Request("http://localhost/api/items/" + org.items.fifo + "/costing", {
                method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
                  costingMethod: "fifo", tracking: "none", expectedUpdatedAt: revision,
                  assetAccountId: org.accounts.invAsset, cogsAccountId: org.accounts.cogs,
                baseUnit: "ea", adjustmentAccountId: org.accounts.adjustment, reorderPoint: "3",
              }),
            }), { params: Promise.resolve({ id: org.items.fifo }) });
            await writer.query("begin");
            await writer.query("select set_config('app.bypass_rls','on',true)");
            await withBypassContext(() => (writer.query("update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{\"inventory\":false}'::jsonb) where id=$1", [org.orgId])));
            await writer.query("select id from items where org_id=$1 and id=$2 for update", [org.orgId, org.items.fifo]);
            const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
            pending = request();
            let blocked = false;
            for (let attempt = 0; attempt < 400; attempt++) {
              const row = (await pool.query<{ blocked: boolean }>("select exists(select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))) as blocked", [pid])).rows[0]!;
              if (row.blocked) { blocked = true; break; }
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.ok(blocked, "profile write must wait for the in-flight policy change");
            await writer.query("commit");
            const response = await pending;
            assert.equal(response.status, 422, JSON.stringify(await response.json()));
            assert.deepEqual(await evidence(), before);
            await withBypassContext(() => (db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,inventory}','true'::jsonb) where id=${org.orgId}`)));
            const allowed = await request();
            assert.equal(allowed.status, 200, JSON.stringify(await allowed.json()));
          } finally {
            await writer.query("rollback"); writer.release(); await pending;
            state.user = null; await dropScratchOrg(org.orgId);
          }
        });
  } },
] as const;

for (const row of inventoryFeatureCases) await row.register();


const inventoryMovementCases = [
  { label: "shipments", register: async () => {
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const { randomUUID } = await import('node:crypto');
        const test = (await import('node:test')).default;
        const { sql } = await import('drizzle-orm');
        const { db, withBypassContext, withOrg } = await import('@openbooks/engine/src/platform/db.ts');
        const { receiveInventory } = await import('@openbooks/engine/src/inventory/movements.ts');
        const { activePickReservations } = await import('@openbooks/engine/src/inventory/pick-reservations.ts');
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
        const { createWarehouseOperator,confirmFixturePick,packFixtureShipment } = await import('@openbooks/engine/src/testing/warehouse-execution.ts');
        const { FulfillmentRefusal, createPickList, createShipment, releasePickList, setShipmentCarrier } = await import('@openbooks/engine/src/sales/fulfillment.ts');
        const { completeShipment, saveFulfillmentCustom } = await import('./shipments');
        const DB = Boolean(process.env.OPENBOOKS_DB_URL)

        test('completing a shipment issues from the picked bins through the fulfilment path, once', { skip: !DB }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            const userId = await withBypassContext(() => createWarehouseOperator(org.orgId, 'Shipper'))
            const [binA, binB, orderId, lineId, carrierId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()]
            await withBypassContext(async () => {
              await db.execute(sql`
                update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
                       || '{"warehousing": true, "fulfillment": true}'::jsonb) where id = ${org.orgId}`)
              await db.execute(sql`
                insert into stock_locations (id, org_id, location_id, parent_id, code, kind, is_active)
                values (${binA}, ${org.orgId}, ${org.locationId}, ${org.stockLocationId}, 'A1', 'bin', true),
                       (${binB}, ${org.orgId}, ${org.locationId}, ${org.stockLocationId}, 'A2', 'bin', true)`)
              for (const stockLocationId of [binA, binB]) {
                await receiveInventory(org.orgId, userId, {
                  itemId: org.items.fifo, stockLocationId, quantity: '5', unitCost: '2',
                  subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
                })
              }
              await db.execute(sql`
                insert into documents (id, org_id, kind, document_number, party_id, document_date, currency, status,
                                       subsidiary_id, subtotal, tax_total, total, created_by)
                values (${orderId}, ${org.orgId}, 'sales_order', 'SO-9101', ${org.customerId}, ${org.date}, 'CAD', 'draft',
                        ${org.subsidiaryId}, '0', '0', '0', ${userId})`)
              await db.execute(sql`
                insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, description,
                                            quantity, unit, unit_price, amount, tax_amount, stock_location_id)
                values (${lineId}, ${org.orgId}, ${orderId}, 1, ${org.items.fifo}, ${org.accounts.revenue}, 'Widget',
                        '8', 'ea', '10', '80', '0', ${org.stockLocationId})`)
              await db.execute(sql`
                update documents set status = 'approved', subtotal = '80', total = '80'
                 where id = ${orderId} and org_id = ${org.orgId}`)
              await db.execute(sql`
                insert into carriers (id, org_id, code, name, services, tracking_url_template)
                values (${carrierId}, ${org.orgId}, 'PARCEL', 'Parcel Co', array['Ground', 'Express'],
                        'https://track.example/{tracking}')`)
            })

            const scoped = { allowedSubsidiaryIds: null }
            const inTx = <T>(run: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) =>
              withOrg(org.orgId, () => db.transaction(run))
            const pickList = await inTx((tx) => createPickList(tx, org.orgId, userId, {
              salesOrderId: orderId,
              lines: [
                { salesOrderLineId: lineId, binId: binA, quantity: '5' },
                { salesOrderLineId: lineId, binId: binB, quantity: '3' },
              ],
              ...scoped,
            }))
            await releasePickList(org.orgId, userId, { pickListId: pickList.id, ...scoped })
            await confirmFixturePick(org.orgId,userId,pickList.id)
            const shipment = await inTx((tx) => createShipment(tx, org.orgId, userId, { pickListId: pickList.id, documentDate: org.date, ...scoped }))
            // A custom field defined on shipments saves through the customization
            // validation (unknown keys dropped) and is final once the shipment is.
            await withBypassContext(() => db.execute(sql`
              insert into custom_field_defs (org_id, target_table, target_kind, key, label, field_type)
              values (${org.orgId}, 'documents', 'shipment', 'dock_door', 'Dock door', 'text')`))
            const saveCustom = () => inTx((tx) => saveFulfillmentCustom(tx, org.orgId, userId, {
              documentId: shipment.id, kind: 'shipment', custom: { dock_door: 'D-4', stray: 'dropped' },
            }))
            assert.deepEqual(await saveCustom(), { dock_door: 'D-4' })
            const packingLines=await inTx(tx=>tx.execute<{id:string;stock_location_id:string}>(sql`select id,stock_location_id from document_lines
              where org_id=${org.orgId} and document_id=${shipment.id} order by line_number`))
            for(const packingLine of packingLines.rows)await packFixtureShipment(org.orgId,userId,shipment.id,packingLine.stock_location_id,[packingLine.id])
            const complete = () => withOrg(org.orgId, () => completeShipment(org.orgId, userId, { shipmentId: shipment.id, ...scoped }))

            await assert.rejects(complete(), (error: unknown) =>
              error instanceof FulfillmentRefusal && error.code === 'carrier_required'
                && error.message === `Add a carrier and service to ${shipment.documentNumber} before completing it`
                && /Warehouse → Carriers/.test(error.remedy ?? ''))

            await inTx((tx) => setShipmentCarrier(tx, org.orgId, userId, {
              shipmentId: shipment.id, carrierId, service: 'Ground', trackingNumber: '1Z 999', ...scoped,
            }))
            const completed = await complete()
            assert.equal(completed.replayed, false)

            const evidence = await withBypassContext(async () => (await db.execute<{ state: unknown }>(sql`
              select jsonb_build_object(
                'issued', (select jsonb_agg(jsonb_build_array(sl.code, trim_scale(dl.quantity)::text) order by sl.code)
                             from document_lines dl join stock_locations sl on sl.id = dl.stock_location_id
                            where dl.document_id = ${completed.fulfillmentId}),
                'movements', (select jsonb_agg(jsonb_build_array(sl.code, trim_scale(-m.quantity)::text) order by sl.code)
                                from inventory_movements m join stock_locations sl on sl.id = m.stock_location_id
                                join document_lines dl on dl.id = m.document_line_id
                               where dl.document_id = ${completed.fulfillmentId} and m.kind = 'issue'),
                'fulfilled', (select trim_scale(quantity_fulfilled)::text from document_lines where id = ${lineId}),
                'linked', (select count(*)::int from document_links
                            where from_document_id = ${orderId} and to_document_id = ${completed.fulfillmentId} and link_type = 'fulfills'),
                'custom', (select custom from documents where id = ${shipment.id}),
                'stages', (select jsonb_object_agg(d.kind, jsonb_build_array(fd.stage, d.status, fd.sales_fulfillment_id = ${completed.fulfillmentId}))
                             from fulfillment_documents fd join documents d on d.id = fd.document_id
                            where fd.document_id in (${pickList.id}, ${shipment.id}))
              ) as state`)).rows[0]!.state)
            assert.deepEqual(evidence, {
              issued: [['A1', '5'], ['A2', '3']],
              movements: [['A1', '5'], ['A2', '3']],
              fulfilled: '8',
              linked: 1,
              custom: { dock_door: 'D-4' },
              stages: { pick_list: ['done', 'approved', null], shipment: ['done', 'approved', true] },
            })
            assert.deepEqual(await withOrg(org.orgId, () => activePickReservations(db, org.orgId, { salesOrderLineIds: [lineId] })), [],
              'completion ends the reservation')

            const replay = await complete()
            assert.deepEqual(
              { ...replay, replayed: undefined },
              { ...completed, replayed: undefined },
              'a retry answers with the fulfilment already recorded',
            )
            assert.equal(replay.replayed, true)
            await assert.rejects(saveCustom(), { code: 'wrong_stage' })
          } finally {
            await dropScratchOrg(org.orgId)
          }
        })
  } },
  { label: "stock locations", register: async () => {
        const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const { activeStockLocations, profiledItemIds, resolveLineStockLocation } = await import("./stock-locations.ts");

        const DB = !!process.env.OPENBOOKS_DB_URL;

        // Pickers: one resolution rule for the order and document writers.
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
  } },
] as const;

for (const row of inventoryMovementCases) await row.register();
