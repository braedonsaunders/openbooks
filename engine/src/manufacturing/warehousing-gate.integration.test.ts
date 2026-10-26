import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction } from "../platform/db.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { approveFixtureRouting, createManufacturingOperator } from "../testing/manufacturing.ts";
import { receiveInventory } from "../inventory/movements.ts";
import {
  createTransferOrder,
  receiveTransferOrder,
  shipTransferOrder,
} from "../inventory/transfer-orders.ts";
import { getAvailableToPromise } from "../inventory/availability.ts";
import { WarehouseRefusal, activateWarehouse, createWarehouse } from "../inventory/warehouses.ts";
import { createWorkCenter } from "./work-centers.ts";
import { createRouting, createRoutingOperation } from "./routings.ts";
import { createWorkOrder, releaseWorkOrder } from "./work-orders.ts";
import { completeWorkOrder } from "./completion.ts";
import { issueMaterials } from "./materials.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function run<T>(orgId: string, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return withOrgTransaction(orgId, () => work(db));
}

async function setFeatures(orgId: string, patch: Record<string, boolean>): Promise<void> {
  await withBypassContext(() =>
    db.execute(
      sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb) where id = ${orgId}`,
    ),
  );
}

async function setupOrg(): Promise<{ org: ScratchOrg; actorId: string; departmentId: string }> {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() =>
      createManufacturingOperator(org.orgId, "Shop lead"),
    );
    const wipId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`insert into accounts
        (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${wipId}, ${org.orgId}, '1210', 'Manufacturing WIP', 'asset_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
      await db.execute(sql`update orgs set settings = jsonb_set(jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"manufacturing": true, "inventory": true}'::jsonb), '{controlAccounts}',
        coalesce(settings->'controlAccounts', '{}'::jsonb) || jsonb_build_object('mfgWip', ${wipId}::text), true)
        where id = ${org.orgId}`);
      await db.execute(sql`update bom_components set quantity_per = '2', operation_seq = null, is_byproduct = false
        where org_id = ${org.orgId} and assembly_item_id = ${org.items.assembly} and component_item_id = ${org.items.component}`);
      const open = await db.execute<{ id: string }>(
        sql`select id from accounting_periods where org_id = ${org.orgId}
        and current_date between starts_on and ends_on and not is_adjustment limit 1`,
        "objects",
      );
      if (open.length === 0) {
        await db.execute(sql`insert into accounting_periods
          (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
          select ${randomUUID()}, ${org.orgId}, extract(year from current_date)::int, extract(month from current_date)::int,
            to_char(current_date, 'YYYY-MM'), date_trunc('month', current_date)::date,
            (date_trunc('month', current_date) + interval '1 month - 1 day')::date, false, fiscal_calendar_id
            from accounting_periods where id = ${org.periodId}`);
      }
    });
    const departmentId = String(
      (
        await withBypassContext(() =>
          db.execute(
            sql`insert into departments (org_id, name) values (${org.orgId}, 'Assembly') returning id`,
            "objects",
          ),
        )
      )[0]!.id,
    );
    await withBypassContext(() =>
      db.execute(sql`insert into labor_cost_rates
      (org_id, department_id, currency, rate, basis, annual_hours, effective_from, is_active, created_by, updated_by)
      values (${org.orgId}, ${departmentId}, 'CAD', '0', 'hour', '2080', '2026-01-01', true, ${actorId}, ${actorId})`),
    );
    return { org, actorId, departmentId };
  } catch (error) {
    await withBypassContext(() => dropScratchOrg(org.orgId));
    throw error;
  }
}

function warehousingRefusal(error: unknown): boolean {
  assert.ok(error instanceof WarehouseRefusal, `expected a WarehouseRefusal, got ${String(error)}`);
  assert.equal(error.code, "warehousing_disabled");
  assert.equal(
    error.remedy,
    "ask an administrator to turn on Warehousing in Company Settings → Features",
  );
  assert.ok(
    !error.message.includes(error.remedy),
    "the message must not duplicate the remedy text",
  );
  return true;
}

test(
  "single-warehouse production releases and completes with Warehousing off",
  { skip: !DB },
  async () => {
    const f = await setupOrg();
    try {
      await setFeatures(f.org.orgId, { warehousing: true });
      const house = await withBypassContext(() =>
        createWarehouse(f.org.orgId, f.actorId, {
          code: "TACOMA-WH",
          name: "Tacoma warehouse",
          locationId: f.org.locationId,
        }),
      );
      await withBypassContext(() =>
        activateWarehouse(f.org.orgId, f.actorId, { warehouseId: house.id }),
      );
      await withBypassContext(() =>
        db.execute(sql`
      update stock_locations set is_active = false
       where org_id = ${f.org.orgId} and id in (${f.org.stockLocationId}, ${f.org.stockLocationId2})`),
      );
      await withBypassContext(() =>
        receiveInventory(f.org.orgId, f.actorId, {
          itemId: f.org.items.component,
          stockLocationId: house.id,
          quantity: "10",
          unitCost: "3",
          subsidiaryId: f.org.subsidiaryId,
          offsetAccountId: f.org.accounts.clearing,
          date: f.org.date,
        }),
      );
      await setFeatures(f.org.orgId, { warehousing: false });

      const center = await run(f.org.orgId, (tx) =>
        createWorkCenter(tx, f.org.orgId, f.actorId, {
          code: `WC-${randomUUID()}`,
          name: "Assembly center",
          kind: "machine",
          capacityHoursPerDay: "8",
          efficiencyPct: "100",
          departmentId: f.departmentId,
          absorbsOverhead: false,
        }),
      );
      const routing = await run(f.org.orgId, (tx) =>
        createRouting(tx, f.org.orgId, f.actorId, {
          producedItemId: f.org.items.assembly,
          code: `RT-${randomUUID()}`,
          name: "Assembly route",
          effectiveFrom: "2026-01-01",
          defaultIssueLocationId: house.id,
          defaultReceiptLocationId: house.id,
          overheadBasis: "units",
        }),
      );
      await run(f.org.orgId, (tx) =>
        createRoutingOperation(tx, f.org.orgId, f.actorId, String(routing.id), {
          sequence: 10,
          name: "Assemble",
          workCenterId: String(center.id),
          setupMinutes: "0",
          runMinutesPerUnit: "1",
        }),
      );
      await approveFixtureRouting(f.org.orgId, f.actorId, String(routing.id));
      const draft = await run(f.org.orgId, (tx) =>
        createWorkOrder(tx, f.org.orgId, f.actorId, {
          producedItemId: f.org.items.assembly,
          quantityOrdered: "1",
          subsidiaryId: f.org.subsidiaryId,
          issueLocationId: house.id,
          receiptLocationId: house.id,
          plannedStart: f.org.date,
        }),
      );
      const released = await run(f.org.orgId, (tx) =>
        releaseWorkOrder(tx, f.org.orgId, f.actorId, draft.id),
      );
      assert.equal(released.status, "released");
      const material = (
        await withBypassContext(
          async () =>
            await db.execute<{ id: string }>(
              sql`
      select id from mfg_wo_materials where org_id = ${f.org.orgId} and work_order_id = ${draft.id}`,
              "objects",
            ),
        )
      )[0]!.id;
      await run(f.org.orgId, (tx) =>
        issueMaterials(tx, f.org.orgId, f.actorId, draft.id, [
          { materialId: material, quantity: "2" },
        ]),
      );
      const completed = await run(f.org.orgId, (tx) =>
        completeWorkOrder(tx, f.org.orgId, f.actorId, draft.id, { quantity: "1" }),
      );
      assert.equal(completed.quantityCompleted, "1.0000");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);

test("single-location measurement works with Warehousing off", { skip: !DB }, async () => {
  const f = await setupOrg();
  try {
    await withBypassContext(() =>
      db.execute(sql`
      update stock_locations set is_active = false where org_id = ${f.org.orgId} and id = ${f.org.stockLocationId2}`),
    );
    const terms = await withBypassContext(() =>
      getAvailableToPromise(db, f.org.orgId, {
        subsidiaryId: f.org.subsidiaryId,
        itemId: f.org.items.component,
      }),
    );
    assert.equal(terms.available, "0.0000");
  } finally {
    await withBypassContext(() => dropScratchOrg(f.org.orgId));
  }
});

test(
  "multi-location operations refuse consistently with Warehousing off",
  { skip: !DB },
  async () => {
    const f = await setupOrg();
    try {
      await setFeatures(f.org.orgId, { warehousing: true });
      const first = await withBypassContext(() =>
        createWarehouse(f.org.orgId, f.actorId, {
          code: "WH-A",
          name: "Warehouse A",
          locationId: f.org.locationId,
        }),
      );
      const second = await withBypassContext(() =>
        createWarehouse(f.org.orgId, f.actorId, {
          code: "WH-B",
          name: "Warehouse B",
          locationId: f.org.locationId,
        }),
      );
      await withBypassContext(() =>
        activateWarehouse(f.org.orgId, f.actorId, { warehouseId: first.id }),
      );
      await withBypassContext(() =>
        activateWarehouse(f.org.orgId, f.actorId, { warehouseId: second.id }),
      );
      const center = await run(f.org.orgId, (tx) =>
        createWorkCenter(tx, f.org.orgId, f.actorId, {
          code: `WC-${randomUUID()}`,
          name: "Assembly center",
          kind: "machine",
          capacityHoursPerDay: "8",
          efficiencyPct: "100",
          departmentId: f.departmentId,
          absorbsOverhead: false,
        }),
      );
      const routing = await run(f.org.orgId, (tx) =>
        createRouting(tx, f.org.orgId, f.actorId, {
          producedItemId: f.org.items.assembly,
          code: `RT-${randomUUID()}`,
          name: "Assembly route",
          effectiveFrom: "2026-01-01",
          defaultIssueLocationId: first.id,
          defaultReceiptLocationId: first.id,
          overheadBasis: "units",
        }),
      );
      await run(f.org.orgId, (tx) =>
        createRoutingOperation(tx, f.org.orgId, f.actorId, String(routing.id), {
          sequence: 10,
          name: "Assemble",
          workCenterId: String(center.id),
          setupMinutes: "0",
          runMinutesPerUnit: "1",
        }),
      );
      await approveFixtureRouting(f.org.orgId, f.actorId, String(routing.id));
      const draft = await run(f.org.orgId, (tx) =>
        createWorkOrder(tx, f.org.orgId, f.actorId, {
          producedItemId: f.org.items.assembly,
          quantityOrdered: "1",
          subsidiaryId: f.org.subsidiaryId,
          issueLocationId: first.id,
          receiptLocationId: first.id,
          plannedStart: f.org.date,
        }),
      );
      const transitId = randomUUID();
      await withBypassContext(() =>
        db.execute(sql`
      insert into stock_locations (id, org_id, location_id, code, kind, is_active)
      values (${transitId}, ${f.org.orgId}, ${f.org.locationId}, 'GATE-TRANSIT', 'transit', true)`),
      );
      const transferOrder = (from: string, to: string) =>
        withBypassContext(() =>
          createTransferOrder(f.org.orgId, f.actorId, {
            fromStockLocationId: from,
            toStockLocationId: to,
            subsidiaryId: f.org.subsidiaryId,
            orderedOn: f.org.date,
            transitStockLocationId: transitId,
            lines: [{ itemId: f.org.items.fifo, quantity: "1" }],
          }),
        );
      const shippable = await transferOrder(first.id, second.id);
      await withBypassContext(() =>
        receiveInventory(f.org.orgId, f.actorId, {
          itemId: f.org.items.fifo,
          stockLocationId: first.id,
          quantity: "10",
          unitCost: "2",
          subsidiaryId: f.org.subsidiaryId,
          offsetAccountId: f.org.accounts.clearing,
          date: f.org.date,
        }),
      );
      await withBypassContext(() =>
        shipTransferOrder(f.org.orgId, f.actorId, shippable.id, f.org.date),
      );
      const receivable = shippable;
      const backhaul = await transferOrder(second.id, first.id);
      await setFeatures(f.org.orgId, { warehousing: false });

      await assert.rejects(
        withBypassContext(() => shipTransferOrder(f.org.orgId, f.actorId, backhaul.id, f.org.date)),
        warehousingRefusal,
        "shipping a transfer order refuses while Warehousing is off",
      );
      await assert.rejects(
        withBypassContext(() =>
          receiveTransferOrder(f.org.orgId, f.actorId, receivable.id, f.org.date),
        ),
        warehousingRefusal,
        "receiving a transfer order refuses while Warehousing is off",
      );
      await assert.rejects(
        withBypassContext(() =>
          getAvailableToPromise(db, f.org.orgId, {
            subsidiaryId: f.org.subsidiaryId,
            itemId: f.org.items.component,
            warehouseId: first.id,
          }),
        ),
        warehousingRefusal,
        "warehouse-scoped availability refuses while Warehousing is off",
      );
      await assert.rejects(
        run(f.org.orgId, (tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, draft.id)),
        warehousingRefusal,
        "manufacturing release refuses while Warehousing is off for a multi-warehouse org",
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(f.org.orgId));
    }
  },
);
