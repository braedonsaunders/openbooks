import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import pg from "pg";
import { db, env, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "../testing/fixtures.ts";
import { issueInventory, receiveInventory } from "./movements.ts";
import { resolvePutawayLocation, putAwayStagedStock } from "./putaway.ts";
import { getOnHandWith } from "./position.ts";
import { activateWarehouse, createWarehouse, retireWarehouse, suspendWarehouse, WarehouseRefusal } from "./warehouses.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function withWarehouse(
  run: (ctx: { org: ScratchOrg; actorId: string; warehouseId: string; bin: (code: string, kind?: string, parentId?: string) => Promise<string> }) => Promise<void>,
) {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(async () => {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"warehousing":true}'::jsonb)
         where id = ${org.orgId}`);
      const warehouse = await createWarehouse(org.orgId, actorId, {
        code: "WH-01", name: "North distribution centre", locationId: org.locationId, city: "Toronto", country: "ca",
      });
      const bin = async (code: string, kind = "bin", parentId = warehouse.id) => {
        const id = randomUUID();
        await db.execute(sql`
          insert into stock_locations (id, org_id, location_id, parent_id, code, kind, is_active)
          values (${id}, ${org.orgId}, ${org.locationId}, ${parentId}, ${code}, ${kind}, true)`);
        return id;
      };
      await run({ org, actorId, warehouseId: warehouse.id, bin });
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

const receipt = (org: ScratchOrg, stockLocationId: string, itemId = org.items.fifo, quantity = "5") => ({
  itemId, stockLocationId, quantity, unitCost: "2.00", subsidiaryId: org.subsidiaryId,
  offsetAccountId: org.accounts.clearing, date: org.date,
});

async function refusal(run: () => Promise<unknown>): Promise<WarehouseRefusal> {
  try {
    await run();
  } catch (error) {
    if (error instanceof WarehouseRefusal) return error;
    throw error;
  }
  assert.fail("expected a warehouse refusal");
}

test("the lifecycle is enforced on real movements and every transition is audited", { skip: !DB }, async () => {
  await withWarehouse(async ({ org, actorId, warehouseId, bin }) => {
    const binId = await bin("A-01");
    const draft = await refusal(() => receiveInventory(org.orgId, actorId, receipt(org, binId)));
    assert.equal(draft.code, "warehouse_not_admitting");
    assert.match(draft.message, /warehouse WH-01 is draft and refuses inbound movements; activate WH-01 in Warehouse → Warehouses/);
    assert.match(
      (await refusal(() => retireWarehouse(org.orgId, actorId, { warehouseId, reason: "closing" }))).message,
      /^cannot retire WH-01 from draft; activate it first$/,
    );

    await activateWarehouse(org.orgId, actorId, { warehouseId });
    await receiveInventory(org.orgId, actorId, receipt(org, binId));
    await suspendWarehouse(org.orgId, actorId, { warehouseId, reason: "roof repair" });
    const suspended = await refusal(() => receiveInventory(org.orgId, actorId, receipt(org, binId)));
    assert.match(suspended.message, /WH-01 is suspended and refuses inbound movements; reactivate WH-01/);
    assert.equal(suspended.remedy, "reactivate WH-01 in Warehouse → Warehouses");
    await issueInventory(org.orgId, actorId, { itemId: org.items.fifo, stockLocationId: binId, quantity: "2", subsidiaryId: org.subsidiaryId, date: org.date });

    const audit = (await db.execute<{ action: string; changes: { event: string; reason?: string; before?: { status: string }; after: { status: string } } }>(sql`
      select action, changes from audit_log where org_id = ${org.orgId} and table_name = 'warehouses' and row_id = ${warehouseId} order by at, id`)).rows;
    assert.deepEqual(
      audit.map((row) => [row.action, row.changes.before?.status ?? null, row.changes.after.status, row.changes.reason ?? null]),
      [["insert", null, "draft", null], ["update", "draft", "active", null], ["update", "active", "suspended", "roof repair"]],
    );
    const stored = (await db.execute<{ country: string; status_changed_by: string }>(sql`
      select country, status_changed_by from warehouses where org_id = ${org.orgId} and stock_location_id = ${warehouseId}`)).rows[0]!;
    assert.deepEqual(stored, { country: "CA", status_changed_by: actorId });
  });
});

test("retiring a warehouse that holds stock names every item and quantity", { skip: !DB }, async () => {
  await withWarehouse(async ({ org, actorId, warehouseId, bin }) => {
    await activateWarehouse(org.orgId, actorId, { warehouseId });
    const a = await bin("A-01");
    const b = await bin("B-01");
    await receiveInventory(org.orgId, actorId, receipt(org, a, org.items.fifo, "3"));
    await receiveInventory(org.orgId, actorId, receipt(org, b, org.items.fifo, "4"));
    await receiveInventory(org.orgId, actorId, receipt(org, b, org.items.component, "2.5"));
    const refused = await refusal(() => retireWarehouse(org.orgId, actorId, { warehouseId, reason: "lease ended" }));
    assert.equal(refused.code, "warehouse_not_empty");
    assert.match(refused.message, /^cannot retire WH-01: it still holds 2\.5000 of Component, 7\.0000 of FIFO Widget; /);
    assert.equal((await db.execute(sql`select status from warehouses where stock_location_id = ${warehouseId}`)).rows[0]!.status, "active");
  });
});

test("putaway follows rule order, repeats for the same state, and names every rule it tried", { skip: !DB }, async () => {
  await withWarehouse(async ({ org, actorId, warehouseId, bin }) => {
    await activateWarehouse(org.orgId, actorId, { warehouseId });
    const fixed = await bin("F-01");
    const zone = await bin("Z-EMPTY", "zone");
    const busy = await bin("E-01", "bin", zone);
    const free = await bin("E-02", "bin", zone);
    const staging = await bin("STAGE-IN", "staging");
    const rule = (sequence: number, strategy: string, target: string, capacity: string | null) => db.execute(sql`
      insert into putaway_rules (org_id, warehouse_id, sequence, item_id, strategy, target_location_id, capacity_quantity)
      values (${org.orgId}, ${warehouseId}, ${sequence}, ${org.items.fifo}, ${strategy}, ${target}, ${capacity})`);
    await rule(10, "fixed-bin", fixed, "6");
    await rule(20, "empty-bin", zone, null);
    await receiveInventory(org.orgId, actorId, receipt(org, fixed, org.items.fifo, "4"));
    await receiveInventory(org.orgId, actorId, receipt(org, busy, org.items.component, "1"));
    const input = { itemId: org.items.fifo, quantity: "2", warehouseId, subsidiaryId: org.subsidiaryId };

    assert.equal((await resolvePutawayLocation(db, org.orgId, input)).code, "F-01");
    const overflow = { ...input, quantity: "3" };
    const first = await resolvePutawayLocation(db, org.orgId, overflow);
    assert.deepEqual([first.code, first.sequence], ["E-02", 20]);
    assert.deepEqual(await resolvePutawayLocation(db, org.orgId, overflow), first);

    await receiveInventory(org.orgId, actorId, receipt(org, staging, org.items.fifo, "3"));
    const moved = await db.transaction((tx) => putAwayStagedStock(tx, org.orgId, actorId, {
      warehouseId, stagingLocationId: staging, itemId: org.items.fifo, subsidiaryId: org.subsidiaryId, quantity: "3", date: org.date,
    }));
    assert.equal(moved.stockLocationId, free);

    const refused = await refusal(() => resolvePutawayLocation(db, org.orgId, { ...input, quantity: "5" }));
    assert.equal(refused.code, "putaway_unresolved");
    assert.equal(
      refused.message,
      "no putaway rule in WH-01 admits 5.0000 of FIFO Widget; tried rule 10 (fixed-bin F-01): 4.0000 on hand plus 5.0000 exceeds capacity 6; rule 20 (empty-bin Z-EMPTY): no active bin under Z-EMPTY is empty",
    );
    assert.equal(refused.remedy, "add or widen a rule in Warehouse → Putaway rules");
  });
});

test("concurrent putaways never fill a bin past its capacity", { skip: !DB }, async () => {
  await withWarehouse(async ({ org, actorId, warehouseId, bin }) => {
    await activateWarehouse(org.orgId, actorId, { warehouseId });
    const fixed = await bin("F-01");
    const overflow = await bin("G-01");
    const staging = await bin("STAGE-IN", "staging");
    await db.execute(sql`
      insert into putaway_rules (org_id, warehouse_id, sequence, item_id, strategy, target_location_id, capacity_quantity)
      values (${org.orgId}, ${warehouseId}, 10, ${org.items.fifo}, 'fixed-bin', ${fixed}, 5),
             (${org.orgId}, ${warehouseId}, 20, ${org.items.fifo}, 'fixed-bin', ${overflow}, null)`);
    await receiveInventory(org.orgId, actorId, receipt(org, staging, org.items.fifo, "6"));
    // Hold the staging position so both putaways are parked before either
    // commits: without the target fence both resolve F-01 against the same
    // empty bin; with it the second resolves only after the first commits.
    const blocker = new pg.Client({ connectionString: process.env.OPENBOOKS_TEST_ADMIN_DB_URL ?? env.OPENBOOKS_DB_URL });
    await blocker.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`inventory:${org.items.fifo}:${staging}`]);
      const putAway = () => db.transaction((tx) => putAwayStagedStock(tx, org.orgId, actorId, {
        warehouseId, stagingLocationId: staging, itemId: org.items.fifo, subsidiaryId: org.subsidiaryId, quantity: "3", date: org.date,
      }));
      const both = Promise.allSettled([putAway(), putAway()]);
      for (const deadline = Date.now() + 10_000; ;) {
        const parked = (await blocker.query<{ n: number }>(`select count(*)::int as n from pg_locks
          where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`)).rows[0]!.n;
        if (parked >= 2) break;
        assert.ok(Date.now() < deadline, `only ${parked} of 2 putaways parked on the staging or target lock within 10s`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await blocker.query("commit");
      const results = await both;
      const codes = results.map((r) => (r.status === "fulfilled" ? r.value.code : String(r.reason))).sort();
      assert.deepEqual(codes, ["F-01", "G-01"]);
      assert.equal((await getOnHandWith(db, org.orgId, org.items.fifo, fixed)).quantity, "3.0000");
    } finally {
      await blocker.query("rollback").catch(() => {});
      await blocker.end();
    }
  });
});

test("storage refuses a warehouse row on a non-warehouse location and a nested warehouse", { skip: !DB }, async () => {
  await withWarehouse(async ({ org, warehouseId, bin }) => {
    const refusedBy = (pattern: RegExp) => (error: unknown) =>
      pattern.test(String((error as { cause?: Error }).cause?.message ?? error));
    const binId = await bin("A-01");
    await assert.rejects(
      db.execute(sql`insert into warehouses (stock_location_id, org_id, name, status) values (${binId}, ${org.orgId}, 'Bin', 'active')`),
      refusedBy(/^stock location A-01 is a bin, not a warehouse/),
    );
    await assert.rejects(bin("WH-INNER", "warehouse", warehouseId), refusedBy(/^warehouse WH-INNER cannot sit inside warehouse WH-01/));
    await assert.rejects(
      db.execute(sql`update stock_locations set kind = 'zone' where id = ${warehouseId}`),
      refusedBy(/^stock location WH-01 is a warehouse and cannot change kind/),
    );
  });
});
