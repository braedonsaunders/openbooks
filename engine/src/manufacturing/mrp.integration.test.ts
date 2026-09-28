import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { receiveInventory } from "../inventory/movements.ts";
import { ManufacturingError } from "./errors.ts";
import { runMrp, getMrpRun, confirmPlannedOrder, dismissPlannedOrder, convertPlannedOrder } from "./mrp.ts";
import { createWorkCenter } from "./work-centers.ts";
import { createRouting, createRoutingOperation, activateRouting } from "./routings.ts";
import { upsertItemPolicy } from "./item-policies.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
type Fixture = { org: ScratchOrg; actorId: string };
type Case = { name: string; run: (f: Fixture) => Promise<void> };
const tx = <T>(work: (runner: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) => withBypassContext(() => db.transaction(work));
const future = (day: string, offset: number) => { const d = new Date(`${day}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };

async function setup(): Promise<Fixture> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() => createScratchUser(org.orgId, "MRP planner", "admin"));
  await withBypassContext(async () => {
    const enabled = await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"manufacturing":true,"inventory":true,"warehousing":true,"manufacturingMrp":true}'::jsonb) where id=${org.orgId} returning id`);
    assert.equal(enabled.rows.length, 1);
  });
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  await withBypassContext(async () => {
    for (const [id, code] of [[org.items.assembly, `MRP-${suffix}-FG`], [org.items.component, `MRP-${suffix}-SUB`], [org.items.standard, `MRP-${suffix}-RAW`]]) {
      const result = await db.execute(sql`update items set code=${code} where org_id=${org.orgId} and id=${id} returning id`);
      assert.equal(result.rows.length, 1);
    }
  });
  return { org, actorId };
}
async function policy(f: Fixture, itemId: string, supplyMethod: "make" | "buy" | "transfer", leadTimeDays: number | null, minimumQty = "0", orderMultipleQty = "0") {
  return tx((runner) => upsertItemPolicy(runner, f.org.orgId, f.actorId, itemId, { supplyMethod, leadTimeDays, safetyStockQty: "0", minimumQty, orderMultipleQty, scrapPctPlanned: "0" }));
}
async function orderLine(f: Fixture, kind: "sales_order" | "purchase_order", itemId: string, quantity: string, dueDate: string, subsidiaryId = f.org.subsidiaryId) {
  const id = randomUUID(); const number = `${kind === "sales_order" ? "SO" : "PO"}-${id.slice(0, 8)}`;
  let lineId = "";
  await withBypassContext(async () => {
    const document = await db.execute(sql`insert into documents (id,org_id,kind,document_number,party_id,subsidiary_id,document_date,due_date,currency,status,subtotal,tax_total,total,created_by,updated_by)
      values (${id},${f.org.orgId},${kind},${number},${kind === "sales_order" ? f.org.customerId : f.org.vendorId},${subsidiaryId},${f.org.date},${dueDate},'CAD','draft',${quantity},'0',${quantity},${f.actorId},${f.actorId}) returning id`);
    assert.equal(document.rows.length, 1);
    const inserted = await db.execute<{ id: string }>(sql`insert into document_lines (org_id,document_id,line_number,account_id,item_id,quantity,unit_price,amount,tax_input_amount,tax_amount,created_by,updated_by)
      values (${f.org.orgId},${id},1,${kind === "sales_order" ? f.org.accounts.revenue : f.org.accounts.invAsset},${itemId},${quantity},'1',${quantity},${quantity},'0',${f.actorId},${f.actorId}) returning id`);
    lineId = inserted.rows[0]?.id ?? "";
    assert.ok(lineId);
    const approved = await db.execute(sql`update documents set status='approved',updated_by=${f.actorId},updated_at=now() where org_id=${f.org.orgId} and id=${id} and status='draft' returning id`);
    assert.equal(approved.rows.length, 1);
  });
  return { id, number, lineId };
}
async function run(f: Fixture, subsidiaryId = f.org.subsidiaryId, capacityCheck = false) {
  return tx((runner) => runMrp(runner, f.org.orgId, f.actorId, { subsidiaryId, horizonDays: 60, capacityCheck }));
}
async function suggestions(f: Fixture, runId: string) { return (await getMrpRun(db, f.org.orgId, runId)).suggestions; }
async function refuse(work: Promise<unknown>, code: string, text: string) {
  await assert.rejects(work, (error: unknown) => error instanceof ManufacturingError && error.code === code && error.message.includes(text) && Boolean(error.remedy?.trim()));
}
async function routing(f: Fixture, itemId: string, capacity = "8", runMinutes = "1") {
  const code = `WC-${randomUUID().slice(0, 8)}`;
  const center = await tx((runner) => createWorkCenter(runner, f.org.orgId, f.actorId, { code, name: code, subsidiaryId: f.org.subsidiaryId, kind: "machine", capacityHoursPerDay: capacity, efficiencyPct: "100", absorbsOverhead: false }));
  const route = await tx((runner) => createRouting(runner, f.org.orgId, f.actorId, { producedItemId: itemId, code: `RT-${randomUUID().slice(0, 8)}`, name: "MRP route", effectiveFrom: "2026-01-01", defaultIssueLocationId: f.org.stockLocationId, defaultReceiptLocationId: f.org.stockLocationId2, overheadBasis: "units" }));
  await tx((runner) => createRoutingOperation(runner, f.org.orgId, f.actorId, String(route.id), { sequence: 1, name: "Build", workCenterId: String(center.id), setupMinutes: "0", runMinutesPerUnit: runMinutes }));
  await tx((runner) => activateRouting(runner, f.org.orgId, f.actorId, String(route.id)));
  return String(center.id);
}
async function transitLocation(f: Fixture) {
  const locationId = randomUUID();
  await withBypassContext(async () => {
    const location = await db.execute(sql`insert into locations (id,org_id,name,is_active,custom,subsidiary_include_children) values (${locationId},${f.org.orgId},'Transit',true,'{}'::jsonb,true) returning id`);
    assert.equal(location.rows.length, 1);
    const stockLocation = await db.execute(sql`insert into stock_locations (org_id,location_id,code,kind,is_active) values (${f.org.orgId},${locationId},${`TR-${locationId.slice(0, 6)}`},'transit',true) returning id`);
    assert.equal(stockLocation.rows.length, 1);
  });
}

const cases: Case[] = [
  { name: "worked example time-phases receipts and rounds exactly", run: async (f) => {
    const today = await businessToday(f.org.orgId); const due = future(today, 20);
    await policy(f, f.org.items.assembly, "buy", 7, "0", "25");
    await receiveInventory(f.org.orgId, f.actorId, { itemId: f.org.items.assembly, stockLocationId: f.org.stockLocationId, quantity: "30", unitCost: "1", subsidiaryId: f.org.subsidiaryId, offsetAccountId: f.org.accounts.clearing, date: f.org.date });
    await orderLine(f, "purchase_order", f.org.items.assembly, "20", future(due, -5));
    const so = await orderLine(f, "sales_order", f.org.items.assembly, "100", due);
    const result = await run(f); const [plan] = await suggestions(f, result.id);
    assert.equal(plan?.quantity, "50.0000"); assert.equal(plan?.dueDate, due); assert.equal(plan?.plannedStart, future(due, -7)); assert.deepEqual(plan?.demandRef, { type: "sales_order_line", documentId: so.id, documentNumber: so.number, lineId: so.lineId, lineNumber: 1 });
  } },
  { name: "past-due lead offset clamps to today and flags expedite", run: async (f) => {
    const today = await businessToday(f.org.orgId); await policy(f, f.org.items.assembly, "buy", 7);
    await orderLine(f, "sales_order", f.org.items.assembly, "1", future(today, 2));
    const [plan] = await suggestions(f, (await run(f)).id); assert.equal(plan?.plannedStart, today); assert.equal(plan?.isExpedite, true);
  } },
  { name: "missing lead-time refusal lists every demanded item", run: async (f) => {
    const today = await businessToday(f.org.orgId); const due = future(today, 20);
    await policy(f, f.org.items.assembly, "buy", null); await policy(f, f.org.items.component, "make", null);
    await orderLine(f, "sales_order", f.org.items.assembly, "1", due); await orderLine(f, "sales_order", f.org.items.component, "1", due);
    const codes = (await withBypassContext(async () => db.execute<{ code: string }>(sql`select code from items where org_id=${f.org.orgId} and id in (${f.org.items.assembly},${f.org.items.component}) order by code`))).rows.map((row) => row.code);
    await assert.rejects(run(f), (error: unknown) => error instanceof ManufacturingError
      && error.code === "mrp_lead_time_required" && codes.every((code) => error.message.includes(code))
      && error.remedy === "set a lead time in the item's manufacturing policy");
    await withBypassContext(async () => assert.equal((await db.execute(sql`select count(*)::int as n from mfg_mrp_runs where org_id=${f.org.orgId}`)).rows[0]!.n, 0));
  } },
  { name: "demand in another subsidiary does not net into this run", run: async (f) => {
    const other = randomUUID(); const today = await businessToday(f.org.orgId);
    await withBypassContext(async () => {
      const inserted = await db.execute(sql`insert into subsidiaries (id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
        values (${other},${f.org.orgId},${f.org.subsidiaryId},'Other Co','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb) returning id`);
      assert.equal(inserted.rows.length, 1);
    });
    await policy(f, f.org.items.assembly, "buy", 7); await orderLine(f, "sales_order", f.org.items.assembly, "9", future(today, 20), other);
    assert.equal((await suggestions(f, (await run(f)).id)).length, 0);
  } },
  { name: "released work-order materials reduce available stock", run: async (f) => {
    const today = await businessToday(f.org.orgId); await policy(f, f.org.items.component, "buy", 2);
    await receiveInventory(f.org.orgId, f.actorId, { itemId: f.org.items.component, stockLocationId: f.org.stockLocationId, quantity: "30", unitCost: "1", subsidiaryId: f.org.subsidiaryId, offsetAccountId: f.org.accounts.clearing, date: f.org.date });
    await withBypassContext(async () => {
      const wo = randomUUID(), waivedWo = randomUUID();
      const order = await db.execute(sql`insert into mfg_work_orders (id,org_id,number,produced_item_id,quantity_ordered,unit,status,source,subsidiary_id,released_at,created_by,updated_by) values (${wo},${f.org.orgId},${`WO-${wo.slice(0, 8)}`},${f.org.items.assembly},'1','ea','released','manual',${f.org.subsidiaryId},now(),${f.actorId},${f.actorId}),(${waivedWo},${f.org.orgId},${`WO-${waivedWo.slice(0, 8)}`},${f.org.items.assembly},'1','ea','released','manual',${f.org.subsidiaryId},now(),${f.actorId},${f.actorId}) returning id`);
      assert.equal(order.rows.length, 2);
      const material = await db.execute(sql`insert into mfg_wo_materials (org_id,work_order_id,component_item_id,required_qty,issued_qty,waived_at,waived_by,waive_reason,lot_serial_policy,created_by,updated_by) values (${f.org.orgId},${wo},${f.org.items.component},'20','0',null,null,null,'none',${f.actorId},${f.actorId}),(${f.org.orgId},${waivedWo},${f.org.items.component},'15','0',now(),${f.actorId},'No longer required','none',${f.actorId},${f.actorId}) returning work_order_id`);
      assert.equal(material.rows.length, 2);
    });
    await orderLine(f, "sales_order", f.org.items.component, "20", future(today, 20));
    const [plan] = await suggestions(f, (await run(f)).id); assert.equal(plan?.quantity, "10.0000");
  } },
  { name: "two-level make BOM explodes to dependent raw-material demand", run: async (f) => {
    const today = await businessToday(f.org.orgId); await policy(f, f.org.items.assembly, "make", 7); await policy(f, f.org.items.component, "make", 3); await policy(f, f.org.items.standard, "buy", 1);
    await withBypassContext(async () => {
      const removed = await db.execute(sql`delete from bom_components where org_id=${f.org.orgId} and assembly_item_id in (${f.org.items.assembly},${f.org.items.component}) returning id`);
      assert.ok(removed.rows.length > 0);
      const inserted = await db.execute(sql`insert into bom_components (org_id,assembly_item_id,component_item_id,quantity_per,sort_order) values (${f.org.orgId},${f.org.items.assembly},${f.org.items.component},'2',0),(${f.org.orgId},${f.org.items.component},${f.org.items.standard},'3',0) returning id`);
      assert.equal(inserted.rows.length, 2);
    });
    await orderLine(f, "sales_order", f.org.items.assembly, "10", future(today, 30));
    const plans = await suggestions(f, (await run(f)).id); const raw = plans.find((entry) => entry.itemId === f.org.items.standard);
    assert.equal(plans.find((entry) => entry.itemId === f.org.items.assembly)?.action, "make");
    assert.equal(plans.find((entry) => entry.itemId === f.org.items.component)?.quantity, "20.0000");
    assert.equal(raw?.quantity, "60.0000"); assert.equal(raw?.demandRef.type, "work_order_material");
  } },
  { name: "BOM cycle refusal propagates through a make suggestion", run: async (f) => {
    const today = await businessToday(f.org.orgId); await policy(f, f.org.items.assembly, "make", 7); await policy(f, f.org.items.component, "make", 3);
    await withBypassContext(async () => {
      const removed = await db.execute(sql`delete from bom_components where org_id=${f.org.orgId} and assembly_item_id in (${f.org.items.assembly},${f.org.items.component}) returning id`);
      assert.ok(removed.rows.length > 0);
      const inserted = await db.execute(sql`insert into bom_components (org_id,assembly_item_id,component_item_id,quantity_per,sort_order)
        values (${f.org.orgId},${f.org.items.assembly},${f.org.items.component},'1',0),(${f.org.orgId},${f.org.items.component},${f.org.items.assembly},'1',0) returning id`);
      assert.equal(inserted.rows.length, 2);
    });
    await orderLine(f, "sales_order", f.org.items.assembly, "1", future(today, 30));
    await refuse(run(f), "bom_cycle", "bill of materials cycle");
  } },
  { name: "superseded run refuses a confirmed suggestion conversion", run: async (f) => {
    const today = await businessToday(f.org.orgId); await policy(f, f.org.items.assembly, "transfer", 2); await orderLine(f, "sales_order", f.org.items.assembly, "2", future(today, 20));
    const first = await run(f); const plan = (await suggestions(f, first.id))[0]!; await tx((runner) => confirmPlannedOrder(runner, f.org.orgId, f.actorId, plan.id)); await run(f);
    await refuse(tx((runner) => convertPlannedOrder(runner, f.org.orgId, f.actorId, plan.id, {})), "mrp_run_superseded", "re-run MRP");
  } },
  { name: "changed policy refusal names the item policy", run: async (f) => {
    const today = await businessToday(f.org.orgId); await policy(f, f.org.items.assembly, "transfer", 2);
    await orderLine(f, "sales_order", f.org.items.assembly, "2", future(today, 20));
    const plan = (await suggestions(f, (await run(f)).id))[0]!;
    await tx((runner) => confirmPlannedOrder(runner, f.org.orgId, f.actorId, plan.id));
    const code = (await withBypassContext(async () => db.execute<{ code: string }>(sql`select code from items where org_id=${f.org.orgId} and id=${f.org.items.assembly}`))).rows[0]!.code;
    await policy(f, f.org.items.assembly, "transfer", 3);
    await refuse(tx((runner) => convertPlannedOrder(runner, f.org.orgId, f.actorId, plan.id, {})), "mrp_policy_changed", code);
  } },
  { name: "make conversion creates one MRP-sourced draft", run: async (f) => {
    const today = await businessToday(f.org.orgId); await policy(f, f.org.items.assembly, "make", 2); await policy(f, f.org.items.component, "buy", 1); await routing(f, f.org.items.assembly);
    await orderLine(f, "sales_order", f.org.items.assembly, "2", future(today, 20));
    const plan = (await suggestions(f, (await run(f)).id)).find((entry) => entry.itemId === f.org.items.assembly)!; await tx((runner) => confirmPlannedOrder(runner, f.org.orgId, f.actorId, plan.id));
    const created = await tx((runner) => convertPlannedOrder(runner, f.org.orgId, f.actorId, plan.id, {}));
    const row = await withBypassContext(async () => (await db.execute(sql`select source,source_ref_id,status from mfg_work_orders where org_id=${f.org.orgId} and id=${created.id}`)).rows[0]);
    assert.deepEqual(row, { source: "mrp", source_ref_id: plan.id, status: "draft" });
  } },
  { name: "make conversion refuses without an active routing", run: async (f) => {
    const today = await businessToday(f.org.orgId); await policy(f, f.org.items.assembly, "make", 2); await policy(f, f.org.items.component, "buy", 1); await orderLine(f, "sales_order", f.org.items.assembly, "1", future(today, 20));
    const plan = (await suggestions(f, (await run(f)).id)).find((entry) => entry.itemId === f.org.items.assembly)!; await tx((runner) => confirmPlannedOrder(runner, f.org.orgId, f.actorId, plan.id));
    await refuse(tx((runner) => convertPlannedOrder(runner, f.org.orgId, f.actorId, plan.id, {})), "mrp_routing_required", "no active routing");
  } },
  { name: "transfer conversion creates one transfer order", run: async (f) => {
    const today = await businessToday(f.org.orgId); await policy(f, f.org.items.assembly, "transfer", 2); await transitLocation(f);
    await orderLine(f, "sales_order", f.org.items.assembly, "3", future(today, 20));
    const plan = (await suggestions(f, (await run(f)).id))[0]!; await tx((runner) => confirmPlannedOrder(runner, f.org.orgId, f.actorId, plan.id));
    const result = await tx((runner) => convertPlannedOrder(runner, f.org.orgId, f.actorId, plan.id, { fromLocationId: f.org.stockLocationId, toLocationId: f.org.stockLocationId2 }));
    const stored = await withBypassContext(async () => (await db.execute(sql`select t.id,t.memo,r.number,p.due_date::text,i.code from transfer_orders t join mfg_planned_orders p on p.org_id=t.org_id and p.converted_ref_id=t.id join mfg_mrp_runs r on r.org_id=p.org_id and r.id=p.run_id join items i on i.org_id=p.org_id and i.id=p.item_id where t.org_id=${f.org.orgId} and t.id=${result.id} and t.status='draft'`)).rows[0]); assert.equal(result.action, "transfer"); assert.equal(stored?.memo, `MRP run ${stored?.number}: ${stored?.code} due ${stored?.due_date}`);
  } },
  { name: "transfer conversion requires both locations", run: async (f) => {
    const today = await businessToday(f.org.orgId); await policy(f, f.org.items.assembly, "transfer", 2);
    await orderLine(f, "sales_order", f.org.items.assembly, "1", future(today, 20));
    const plan = (await suggestions(f, (await run(f)).id))[0]!; await tx((runner) => confirmPlannedOrder(runner, f.org.orgId, f.actorId, plan.id));
    await refuse(tx((runner) => convertPlannedOrder(runner, f.org.orgId, f.actorId, plan.id, {})), "mrp_transfer_locations_required", "needs both locations");
  } },
  { name: "transfer conversion refuses with fewer than two active locations", run: async (f) => {
    const today = await businessToday(f.org.orgId); await policy(f, f.org.items.assembly, "transfer", 2);
    await orderLine(f, "sales_order", f.org.items.assembly, "1", future(today, 20));
    const plan = (await suggestions(f, (await run(f)).id))[0]!; await tx((runner) => confirmPlannedOrder(runner, f.org.orgId, f.actorId, plan.id));
    await withBypassContext(async () => {
      const changed = await db.execute(sql`update stock_locations set is_active=false where org_id=${f.org.orgId} and id<>${f.org.stockLocationId} returning id`);
      assert.ok(changed.rows.length > 0);
    });
    await refuse(tx((runner) => convertPlannedOrder(runner, f.org.orgId, f.actorId, plan.id, { fromLocationId: f.org.stockLocationId, toLocationId: f.org.stockLocationId2 })), "mrp_transfer_locations_required", "at least two active stock locations");
  } },
  { name: "dismissal requires a reason and keeps evidence", run: async (f) => {
    const today = await businessToday(f.org.orgId); await policy(f, f.org.items.assembly, "buy", 2); await orderLine(f, "sales_order", f.org.items.assembly, "1", future(today, 20));
    const plan = (await suggestions(f, (await run(f)).id))[0]!; await refuse(tx((runner) => dismissPlannedOrder(runner, f.org.orgId, f.actorId, plan.id, " ")), "dismiss_reason_required", "reason is required");
    await tx((runner) => dismissPlannedOrder(runner, f.org.orgId, f.actorId, plan.id, "Demand was cancelled"));
    assert.equal((await withBypassContext(async () => db.execute(sql`select dismiss_reason from mfg_planned_orders where org_id=${f.org.orgId} and id=${plan.id} and status='dismissed'`))).rows[0]?.dismiss_reason, "Demand was cancelled");
  } },
  { name: "capacity facts identify an overloaded week at read time", run: async (f) => {
    const today = await businessToday(f.org.orgId); await policy(f, f.org.items.assembly, "make", 2); await policy(f, f.org.items.component, "buy", 1); const center = await routing(f, f.org.items.assembly, "1", "600");
    await withBypassContext(async () => {
      const calendar = (await db.execute<{ id: string }>(sql`select id from schedule_calendars where org_id=${f.org.orgId} and is_default and project_id is null order by id limit 1`)).rows[0];
      if (calendar) {
        const updated = await db.execute(sql`update schedule_calendars set working_days='{"0":false,"1":true,"2":true,"3":true,"4":true,"5":true,"6":false}'::jsonb,holidays='[]'::jsonb where org_id=${f.org.orgId} and id=${calendar.id} returning id`);
        assert.equal(updated.rows.length, 1);
      } else {
        const inserted = await db.execute(sql`insert into schedule_calendars (org_id,name,is_default,working_days,holidays) values (${f.org.orgId},'Default',true,'{"0":false,"1":true,"2":true,"3":true,"4":true,"5":true,"6":false}'::jsonb,'[]'::jsonb) returning id`);
        assert.equal(inserted.rows.length, 1);
      }
    });
    await orderLine(f, "sales_order", f.org.items.assembly, "2", future(today, 20));
    const result = await run(f, f.org.subsidiaryId, true); const load = (await getMrpRun(db, f.org.orgId, result.id)).capacity.find((week) => week.workCenterId === center && week.plannedHours !== "0.0000");
    assert.ok(load); assert.equal(load?.availableHours, "5.0000"); assert.equal(load?.overloaded, true); assert.equal(load?.loadPercent, "400.0000");
  } },
];

test("MRP case table", { skip: !DB }, async () => {
  for (const scenario of cases) {
    const fixture = await setup();
    try { await scenario.run(fixture); }
    catch (error) { throw new Error(`${scenario.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    finally { await dropScratchOrg(fixture.org.orgId); }
  }
});
