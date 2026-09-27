import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { withSimClock } from "../platform/clock.ts";
import { businessToday } from "../platform/business-date.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { receiveInventory } from "../inventory/movements.ts";
import { getOnHand } from "../inventory/position.ts";
import { ManufacturingError } from "./errors.ts";
import { activateRouting, createRouting, createRoutingOperation } from "./routings.ts";
import { createWorkCenter } from "./work-centers.ts";
import { createWorkOrder, holdWorkOrder, releaseWorkOrder, cancelWorkOrder } from "./work-orders.ts";
import { issueMaterials } from "./materials.ts";
import { completeWorkOrder, markWorkOrderDone, reverseMaterialIssue, waiveMaterial } from "./completion.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
type Fixture = { org: ScratchOrg; actorId: string; wipId: string; usageId: string; postingDate: string };
type Case = { name: string; run: (f: Fixture) => Promise<void> };
function run<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> { return withBypassContext(() => db.transaction(work)); }
async function setup(): Promise<Fixture> {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Shop lead", "admin"));
    const wipId = randomUUID(), usageId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`insert into accounts (id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children)
        values (${wipId},${org.orgId},'1210','Manufacturing WIP','asset_current_other',false,true,false,false,'[]'::jsonb,'{}'::jsonb,true) returning id`);
      await db.execute(sql`insert into accounts (id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children)
        values (${usageId},${org.orgId},'5400','Material Usage Variance','cogs',false,true,false,false,'[]'::jsonb,'{}'::jsonb,true) returning id`);
      await db.execute(sql`update orgs set settings=jsonb_set(jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"manufacturing":true,"inventory":true,"warehousing":true}'::jsonb),'{controlAccounts}',
        coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('mfgWip',${wipId}::text,'mfgMaterialUsageVariance',${usageId}::text),true) where id=${org.orgId} returning id`);
      const open = await db.execute<{ id: string }>(sql`select id from accounting_periods where org_id=${org.orgId}
        and current_date between starts_on and ends_on and not is_adjustment limit 1`);
      if (open.rows.length === 0) {
        const period = await db.execute<{ id: string }>(sql`insert into accounting_periods
          (id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
          select ${randomUUID()},${org.orgId},extract(year from current_date)::int,extract(month from current_date)::int,
            to_char(current_date,'YYYY-MM'),date_trunc('month',current_date)::date,
            (date_trunc('month',current_date)+interval '1 month - 1 day')::date,false,fiscal_calendar_id
            from accounting_periods where id=${org.periodId} returning id`);
        assert.equal(period.rows.length, 1, "current accounting period must be created for posting tests");
      }
    });
    const postingDate = await withBypassContext(() => businessToday(org.orgId));
    return { org, actorId, wipId, usageId, postingDate };
  } catch (error) { await withBypassContext(() => dropScratchOrg(org.orgId)); throw error; }
}
async function route(f: Fixture, itemId: string, qualityGate: "none" | "measure" = "none") {
  const center = await run((tx) => createWorkCenter(tx, f.org.orgId, f.actorId, {
    code: "WC-" + randomUUID(), name: "Assembly center", kind: "machine", capacityHoursPerDay: "8", efficiencyPct: "100", absorbsOverhead: false,
  }));
  const routing = await run((tx) => createRouting(tx, f.org.orgId, f.actorId, {
    producedItemId: itemId, code: "RT-" + randomUUID(), name: "Assembly route", effectiveFrom: "2026-01-01",
    defaultIssueLocationId: f.org.stockLocationId, defaultReceiptLocationId: f.org.stockLocationId2, overheadBasis: "units",
  }));
  await run((tx) => createRoutingOperation(tx, f.org.orgId, f.actorId, String(routing.id), {
    sequence: 10, name: "Assemble", workCenterId: String(center.id), setupMinutes: "0", runMinutesPerUnit: "1", qualityGate,
  }));
  await run((tx) => activateRouting(tx, f.org.orgId, f.actorId, String(routing.id)));
}
async function prepare(f: Fixture, opts: { produced?: string; quantity?: string; qualityGate?: "none" | "measure"; secondComponent?: string } = {}) {
  const produced = opts.produced ?? f.org.items.assembly;
  if (produced === f.org.items.assembly) {
    await run((tx) => tx.execute(sql`update bom_components set quantity_per='2',operation_seq=null,is_byproduct=false
      where org_id=${f.org.orgId} and assembly_item_id=${produced} and component_item_id=${f.org.items.component} returning id`));
  } else {
    await withBypassContext(async () => {
      await db.execute(sql`insert into bom_components (org_id,assembly_item_id,component_item_id,quantity_per,sort_order,is_byproduct)
        values (${f.org.orgId},${produced},${f.org.items.component},'1',0,false) returning id`);
      if (opts.secondComponent) await db.execute(sql`insert into bom_components (org_id,assembly_item_id,component_item_id,quantity_per,sort_order,is_byproduct)
        values (${f.org.orgId},${produced},${opts.secondComponent},'1',1,false) returning id`);
    });
  }
  await route(f, produced, opts.qualityGate);
  const order = await run((tx) => createWorkOrder(tx, f.org.orgId, f.actorId, {
    producedItemId: produced, quantityOrdered: opts.quantity ?? "1", subsidiaryId: f.org.subsidiaryId,
    issueLocationId: f.org.stockLocationId, receiptLocationId: f.org.stockLocationId2, plannedStart: f.org.date,
  }));
  await run((tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, order.id));
  const materials = await withBypassContext(async () => (await db.execute<{ id: string; component_item_id: string }>(sql`
    select id,component_item_id from mfg_wo_materials where org_id=${f.org.orgId} and work_order_id=${order.id} order by component_item_id`)).rows);
  return { id: order.id, number: order.number, materials };
}
async function stock(f: Fixture, itemId: string, quantity: string, unitCost: string) {
  await withBypassContext(() => receiveInventory(f.org.orgId, f.actorId, {
    itemId, stockLocationId: f.org.stockLocationId, quantity, unitCost, subsidiaryId: f.org.subsidiaryId,
    offsetAccountId: f.org.accounts.clearing, date: f.org.date,
  }));
}
async function issue(f: Fixture, id: string, lines: Array<{ materialId: string; quantity: string }>) {
  return run((tx) => issueMaterials(tx, f.org.orgId, f.actorId, id, lines));
}
async function refuse(work: Promise<unknown>, code: string, text: string, remedy?: string) {
  await assert.rejects(work, (error: unknown) => error instanceof ManufacturingError && error.code === code
    && error.message.includes(text) && Boolean(error.remedy?.trim()) && (remedy === undefined || error.remedy?.includes(remedy) === true), code + " must name a remedy");
}
async function withVancouverDate(f: Fixture, work: () => Promise<void>) {
  const result = await withBypassContext(() => db.execute<{ zone_count: number; period_count: number }>(sql`
    with zone as (update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{timeZone}','"America/Vancouver"'::jsonb,true) where id=${f.org.orgId} returning id),
    added as (insert into accounting_periods (id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
      select ${randomUUID()},${f.org.orgId},2026,10,'2026-10','2026-10-01','2026-10-31',false,source.fiscal_calendar_id
      from accounting_periods source cross join zone where source.id=${f.org.periodId} and not exists
        (select 1 from accounting_periods where org_id=${f.org.orgId} and date '2026-10-31' between starts_on and ends_on and not is_adjustment) returning id)
    select (select count(*)::int from zone) as zone_count,
      (select count(*)::int from added)+(select count(*)::int from accounting_periods where org_id=${f.org.orgId}
        and date '2026-10-31' between starts_on and ends_on and not is_adjustment) as period_count`));
  assert.deepEqual(result.rows, [{ zone_count: 1, period_count: 1 }]);
  await withSimClock("2026-10-31T23:30:00-07:00", work);
}
async function wip(f: Fixture, number: string) {
  return withBypassContext(async () => (await db.execute<{ value: string }>(sql`select coalesce(sum(line.amount),0)::text value
    from journal_lines line join journal_entries entry on entry.org_id=line.org_id and entry.id=line.entry_id
    where line.org_id=${f.org.orgId} and line.account_id=${f.wipId} and entry.origin='manufacturing'
      and entry.custom->>'work_order_number'=${number} and entry.status in ('posted','reversed')`)).rows[0]!.value);
}
async function counts(f: Fixture) {
  return withBypassContext(async () => ({
    entries: (await db.execute<{ n: number }>(sql`select count(*)::int n from journal_entries where org_id=${f.org.orgId}`)).rows[0]!.n,
    movements: (await db.execute<{ n: number }>(sql`select count(*)::int n from inventory_movements where org_id=${f.org.orgId}`)).rows[0]!.n,
    layers: (await db.execute<{ n: number }>(sql`select count(*)::int n from cost_layers where org_id=${f.org.orgId}`)).rows[0]!.n,
  }));
}
const cases: Case[] = [
  { name: "completion uses the organization's business date", run: async (f) => {
    const wo = await prepare(f); await stock(f, f.org.items.component, "4", "3");
    await issue(f, wo.id, [{ materialId: wo.materials[0]!.id, quantity: "2" }]);
    await withVancouverDate(f, async () => {
      const result = await run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity: "1" }));
      const date = await withBypassContext(async () => (await db.execute<{ date: string }>(sql`select posting_date::text date from journal_entries where org_id=${f.org.orgId} and id=${result.entryId}`)).rows[0]?.date);
      assert.equal(date, "2026-10-31");
    });
  } },
  { name: "actual partial then final completion clears WIP and ties finished layers", run: async (f) => {
    const wo = await prepare(f, { quantity: "2" }); await stock(f, f.org.items.component, "8", "3");
    await issue(f, wo.id, [{ materialId: wo.materials[0]!.id, quantity: "4" }]);
    assert.equal((await run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity: "1" }))).relievedWip, "6.0000");
    await run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity: "1" }));
    await run((tx) => markWorkOrderDone(tx, f.org.orgId, f.actorId, wo.id));
    assert.equal(await wip(f, wo.number), "0.0000");
    const layerValue = await withBypassContext(async () => (await db.execute<{ value: string }>(sql`select sum(layer.original_quantity*layer.unit_cost)::numeric(19,4)::text value
      from cost_layers layer join inventory_movements movement on movement.org_id=layer.org_id and movement.id=layer.source_movement_id
      join journal_entries entry on entry.org_id=movement.org_id and entry.id=movement.journal_entry_id
      where layer.org_id=${f.org.orgId} and movement.item_id=${f.org.items.assembly} and movement.kind='assembly_build'
        and entry.custom->>'work_order_number'=${wo.number} and entry.status in ('posted','reversed')`)).rows[0]!.value);
    const assetAccount = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`select asset_account_id id from item_inventory_profiles
      where org_id=${f.org.orgId} and item_id=${f.org.items.assembly}`)).rows[0]!.id);
    const finishedGoods = await withBypassContext(async () => (await db.execute<{ value: string }>(sql`select coalesce(sum(line.amount),0)::text value
      from journal_lines line where line.org_id=${f.org.orgId} and line.account_id=${assetAccount}
        and line.entry_id in (select movement.journal_entry_id from inventory_movements movement
          where movement.org_id=${f.org.orgId} and movement.item_id=${f.org.items.assembly} and movement.kind='assembly_build')`)).rows[0]!.value);
    assert.equal(finishedGoods, layerValue, "finished-goods GL and completed cost layers must agree");
  } },
  { name: "standard output books favorable and adverse usage and remaining variance", run: async (f) => {
    const wo = await prepare(f, { produced: f.org.items.standard, secondComponent: f.org.items.fifo });
    await stock(f, f.org.items.component, "5", "3"); await stock(f, f.org.items.fifo, "5", "2");
    await issue(f, wo.id, [{ materialId: wo.materials.find((m) => m.component_item_id === f.org.items.component)!.id, quantity: "2" },
      { materialId: wo.materials.find((m) => m.component_item_id === f.org.items.fifo)!.id, quantity: "0.5" }]);
    const result = await run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity: "1" }));
    const amounts = await withBypassContext(async () => (await db.execute<{ usage: string; variance: string }>(sql`select
      coalesce(sum(amount) filter(where account_id=${f.usageId}),0)::text usage,
      coalesce(sum(amount) filter(where account_id=${f.org.accounts.adjustment}),0)::text variance
      from journal_lines where org_id=${f.org.orgId} and entry_id=${result.entryId}`)).rows[0]!);
    assert.equal(amounts.usage, "2.0000"); assert.equal(amounts.variance, "3.0000");
    const componentVariances = await withBypassContext(async () => (await db.execute<{ amount: string }>(sql`select amount::text from journal_lines
      where org_id=${f.org.orgId} and entry_id=${result.entryId} and account_id=${f.usageId} order by amount`)).rows.map((row) => row.amount));
    assert.deepEqual(componentVariances, ["-1.0000", "3.0000"], "favorable usage credits and adverse usage debits remain visible by component");
  } },
  { name: "by-products use item NRV and reasoned manual NRV", run: async (f) => {
    await withBypassContext(async () => {
      await db.execute(sql`update items set default_rate='1.5' where org_id=${f.org.orgId} and id=${f.org.items.standard} returning id`);
      await db.execute(sql`insert into bom_components (org_id,assembly_item_id,component_item_id,quantity_per,sort_order,is_byproduct)
        values (${f.org.orgId},${f.org.items.assembly},${f.org.items.standard},'1',10,true),
               (${f.org.orgId},${f.org.items.assembly},${f.org.items.fifo},'1',11,true) returning id`);
    });
    const wo = await prepare(f);
    await withBypassContext(() => db.execute(sql`update bom_components set quantity_per='8'
      where org_id=${f.org.orgId} and assembly_item_id=${f.org.items.assembly} and is_byproduct returning id`));
    await stock(f, f.org.items.component, "4", "3"); await issue(f, wo.id, [{ materialId: wo.materials[0]!.id, quantity: "2" }]);
    const result = await run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity: "1",
      byproductValues: [{ itemId: f.org.items.fifo, nrvUnit: "2", reason: "Observed resale value" }] }));
    const value = await withBypassContext(async () => (await db.execute<{ total: string }>(sql`select sum(total_value)::text total from inventory_movements
      where org_id=${f.org.orgId} and journal_entry_id=${result.entryId} and item_id in (${f.org.items.standard},${f.org.items.fifo})`)).rows[0]!.total);
    assert.equal(value, "3.5000");
  } },
  { name: "tracked finished good refuses without its lot", run: async (f) => {
    const wo = await prepare(f); await withBypassContext(() => db.execute(sql`update item_inventory_profiles set tracking='lot' where org_id=${f.org.orgId} and item_id=${f.org.items.assembly} returning item_id`));
    await stock(f, f.org.items.component, "4", "3"); await issue(f, wo.id, [{ materialId: wo.materials[0]!.id, quantity: "2" }]);
    await assert.rejects(run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity: "1" })), /lot-tracked finished good/);
  } },
  { name: "over-tolerance completion names order quantity remedy", run: async (f) => {
    const wo = await prepare(f); await stock(f, f.org.items.component, "4", "3"); await issue(f, wo.id, [{ materialId: wo.materials[0]!.id, quantity: "2" }]);
    await refuse(run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity: "1.02" })), "completion_tolerance_exceeded", "1% completion tolerance", "Revise the order quantity");
  } },
  { name: "unmapped nonzero usage variance leaves no accounting or inventory rows", run: async (f) => {
    const wo = await prepare(f, { produced: f.org.items.standard }); await stock(f, f.org.items.component, "4", "3");
    await issue(f, wo.id, [{ materialId: wo.materials[0]!.id, quantity: "2" }]);
    await withBypassContext(() => db.execute(sql`update orgs set settings=settings#-'{controlAccounts,mfgMaterialUsageVariance}' where id=${f.org.orgId} returning id`));
    const before = await counts(f);
    await assert.rejects(run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity: "1" })),
      (error: unknown) => error instanceof ManufacturingError && error.message.includes("mfgMaterialUsageVariance")
        && error.remedy?.includes("under Setup → Company & Accounting → Control accounts."));
    assert.deepEqual(await counts(f), before);
  } },
  { name: "done requires waiver for under-issued explicit material", run: async (f) => {
    const wo = await prepare(f); await stock(f, f.org.items.component, "4", "3"); await issue(f, wo.id, [{ materialId: wo.materials[0]!.id, quantity: "1" }]);
    await run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity: "1" }));
    await refuse(run((tx) => markWorkOrderDone(tx, f.org.orgId, f.actorId, wo.id)), "explicit_material_underissued", "Component");
    await run((tx) => waiveMaterial(tx, f.org.orgId, f.actorId, wo.id, wo.materials[0]!.id, "Approved material substitution"));
    assert.equal((await run((tx) => markWorkOrderDone(tx, f.org.orgId, f.actorId, wo.id))).status, "done");
  } },
  { name: "done refuses unmeasured measure operation", run: async (f) => {
    const wo = await prepare(f, { qualityGate: "measure" }); await stock(f, f.org.items.component, "4", "3");
    await issue(f, wo.id, [{ materialId: wo.materials[0]!.id, quantity: "2" }]); await run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity: "1" }));
    await refuse(run((tx) => markWorkOrderDone(tx, f.org.orgId, f.actorId, wo.id)), "measure_quantity_missing", "measure operation");
  } },
  { name: "done refuses an open child work order", run: async (f) => {
    const wo = await prepare(f); await stock(f, f.org.items.component, "4", "3"); await issue(f, wo.id, [{ materialId: wo.materials[0]!.id, quantity: "2" }]);
    await run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity: "1" }));
    const child = await withBypassContext(() => db.execute(sql`insert into mfg_work_orders (org_id,number,produced_item_id,quantity_ordered,unit,status,source,source_ref_id,parent_wo_id,subsidiary_id,created_by,updated_by)
      values (${f.org.orgId},${"WO-CHILD-" + randomUUID()},${f.org.items.assembly},'1','ea','released','parent',${wo.id},${wo.id},${f.org.subsidiaryId},${f.actorId},${f.actorId}) returning id`));
    assert.equal(child.rows.length, 1);
    await refuse(run((tx) => markWorkOrderDone(tx, f.org.orgId, f.actorId, wo.id)), "child_work_order_open", "child work orders not done");
  } },
  { name: "short close needs a reason and clears residual WIP", run: async (f) => {
    const wo = await prepare(f); await stock(f, f.org.items.component, "4", "3"); await issue(f, wo.id, [{ materialId: wo.materials[0]!.id, quantity: "2" }]);
    await run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity: "0.995" }));
    await refuse(run((tx) => markWorkOrderDone(tx, f.org.orgId, f.actorId, wo.id)), "short_close_reason_required", "below its ordered quantity", "short-close reason");
    await withVancouverDate(f, async () => {
      await run((tx) => markWorkOrderDone(tx, f.org.orgId, f.actorId, wo.id, { shortCloseReason: "Customer order reduced" }));
      const date = await withBypassContext(async () => (await db.execute<{ date: string }>(sql`select posting_date::text date from journal_entries
        where org_id=${f.org.orgId} and entry_number like 'MFG-SHORT-2026-10-31-%'
          and custom->>'work_order_number'=${wo.number}`)).rows[0]?.date);
      assert.equal(date, "2026-10-31");
    });
    assert.equal(await wip(f, wo.number), "0.0000");
  } },
  { name: "issue reversal restores layers, counters, and WIP before cancel", run: async (f) => {
    const wo = await prepare(f); await stock(f, f.org.items.component, "5", "3"); const issued = await issue(f, wo.id, [{ materialId: wo.materials[0]!.id, quantity: "2" }]);
    const movementId = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`select id from inventory_movements where org_id=${f.org.orgId} and journal_entry_id=${issued.entryId} and kind='assembly_consume'`)).rows[0]!.id);
    await run((tx) => holdWorkOrder(tx, f.org.orgId, f.actorId, wo.id, "Stop the production run"));
    await run(() => reverseMaterialIssue(f.org.orgId, f.actorId, { movementId, reversalDate: f.postingDate, reason: "Correct the issue quantity" }));
    assert.equal((await getOnHand(f.org.orgId, f.org.items.component, f.org.stockLocationId)).quantity, "5.0000");
    const restoredLayerQuantity = await withBypassContext(async () => (await db.execute<{ quantity: string }>(sql`select coalesce(sum(remaining_quantity),0)::text quantity
      from cost_layers where org_id=${f.org.orgId} and item_id=${f.org.items.component} and stock_location_id=${f.org.stockLocationId}`)).rows[0]!.quantity);
    assert.equal(restoredLayerQuantity, "5.0000");
    assert.equal(await wip(f, wo.number), "0.0000");
    const qty = await withBypassContext(async () => (await db.execute<{ issued_qty: string }>(sql`select issued_qty::text from mfg_wo_materials where org_id=${f.org.orgId} and id=${wo.materials[0]!.id}`)).rows[0]!.issued_qty);
    assert.equal(qty, "0.0000");
    assert.equal((await run((tx) => cancelWorkOrder(tx, f.org.orgId, f.actorId, wo.id, "Cancel the stopped order"))).status, "cancelled");
  } },
  { name: "issue reversal refuses after the order is done", run: async (f) => {
    const wo = await prepare(f); await stock(f, f.org.items.component, "4", "3"); const issued = await issue(f, wo.id, [{ materialId: wo.materials[0]!.id, quantity: "2" }]);
    const movementId = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`select id from inventory_movements where org_id=${f.org.orgId} and journal_entry_id=${issued.entryId} and kind='assembly_consume'`)).rows[0]!.id);
    await run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity: "1" })); await run((tx) => markWorkOrderDone(tx, f.org.orgId, f.actorId, wo.id));
    await refuse(run(() => reverseMaterialIssue(f.org.orgId, f.actorId, { movementId, reversalDate: f.postingDate, reason: "Correct the issue quantity" })), "issue_reversal_after_completion", "cannot be reversed after it is done");
  } },
];
test("manufacturing completion and reversal case table", { skip: !DB }, async () => {
  for (const scenario of cases) {
    const f = await setup();
    try { await scenario.run(f); }
    catch (error) { throw new Error(scenario.name + ": " + (error instanceof Error ? error.message : String(error)), { cause: error }); }
    finally { await withBypassContext(() => dropScratchOrg(f.org.orgId)); }
  }
});
