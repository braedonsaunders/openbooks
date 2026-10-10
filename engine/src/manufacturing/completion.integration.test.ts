import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { withSimClock } from "../platform/clock.ts";
import { businessToday } from "../platform/business-date.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { receiveInventory } from "../inventory/movements.ts";
import { getOnHand } from "../inventory/position.ts";
import { recordNormalScrap } from "./scrap.ts";
import { executeManufacturingReceipt, executeManufacturingIssue } from "./execution.ts";
import { readManufacturingRecord, listManufacturingRecords, searchManufacturingChoices, manufacturingOptions, manufacturingTracking } from "./workspace.ts";
import { ManufacturingError } from "./errors.ts";
import { upsertItemPolicy, assertManufacturingItemExists } from "./item-policies.ts";
import { runMrp } from "./mrp.ts";
import { activateRouting, createRouting, createRoutingOperation, createNextRoutingVersion, updateRoutingOperation, getRouting } from "./routings.ts";
import { addWorkCenterRate, createWorkCenter, updateWorkCenter } from "./work-centers.ts";
import { createWorkOrder, holdWorkOrder, releaseWorkOrder, cancelWorkOrder, startWorkOrderOperation } from "./work-orders.ts";
import { completeWorkOrderOperation, issueMaterials } from "./materials.ts";
import { completeWorkOrder, markWorkOrderDone, reverseMaterialIssue, waiveMaterial } from "./completion.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
type Fixture = { org: ScratchOrg; actorId: string; wipId: string; usageId: string; departmentId: string; postingDate: string };
type Case = { name: string; run: (f: Fixture) => Promise<void> };
function run<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> { return withBypassContext(() => db.transaction(work)); }
async function setup(): Promise<Fixture> {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Shop lead", "admin"));
    const wipId = randomUUID(), usageId = randomUUID(), departmentId = randomUUID();
    await withBypassContext(async () => {
      const department = await db.execute<{ id: string }>(sql`insert into departments (id, org_id, name, subsidiary_id)
        values (${departmentId}, ${org.orgId}, 'Assembly', ${org.subsidiaryId}) returning id`);
      assert.equal(department.rows.length, 1, "assembly department fixture must be created before manufacturing completion");
      const laborRate = await db.execute<{ id: string }>(sql`insert into labor_cost_rates
        (org_id, department_id, currency, rate, basis, annual_hours, effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${departmentId}, 'CAD', '0', 'hour', '2080', '2026-01-01', true, ${actorId}, ${actorId})
        returning id`);
      assert.equal(laborRate.rows.length, 1, "assembly labor-cost rate fixture must cover work-order release");
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
    return { org, actorId, wipId, usageId, departmentId, postingDate };
  } catch (error) { await withBypassContext(() => dropScratchOrg(org.orgId)); throw error; }
}
async function route(f: Fixture, itemId: string, qualityGate: "none" | "measure" = "none") {
  const center = await run((tx) => createWorkCenter(tx, f.org.orgId, f.actorId, {
    code: "WC-" + randomUUID(), name: "Assembly center", kind: "machine", capacityHoursPerDay: "8", efficiencyPct: "100", departmentId: f.departmentId, absorbsOverhead: false,
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
async function account(f: Fixture, role: string, type: string): Promise<string> {
  const id = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`insert into accounts (id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children)
      values (${id},${f.org.orgId},${"9" + randomUUID().slice(0, 6)},${role},${type},false,true,false,false,'[]'::jsonb,'{}'::jsonb,true) returning id`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object(${role}::text,${id}::text),true) where id=${f.org.orgId} returning id`);
  });
  return id;
}
/**
 * A staffed machine cell: 30/h standard labor, 12/h machine rate and a 5/h
 * standard overhead card on labor hours. Ten units at 6 run minutes each and
 * two components at 3.00 per unit.
 */
async function conversionOrder(f: Fixture, produced: string) {
  await withBypassContext(async () => {
    await db.execute(sql`update labor_cost_rates set rate='30' where org_id=${f.org.orgId} and department_id=${f.departmentId} returning id`);
    await db.execute(sql`insert into overhead_rates (org_id,department_id,method,rate_kind,rate_percent,effective_from)
      values (${f.org.orgId},${f.departmentId},'standard','per_hour','5','2026-01-01') returning id`);
    if (produced !== f.org.items.assembly) await db.execute(sql`insert into bom_components (org_id,assembly_item_id,component_item_id,quantity_per,sort_order,is_byproduct)
      values (${f.org.orgId},${produced},${f.org.items.component},'2',0,false) returning id`);
    else await db.execute(sql`update bom_components set quantity_per='2',operation_seq=null,is_byproduct=false
      where org_id=${f.org.orgId} and assembly_item_id=${produced} and component_item_id=${f.org.items.component} returning id`);
  });
  const ids = { clearing: await account(f, "laborClearing", "liability_current_other"), applied: await account(f, "mfgOverheadApplied", "cogs"),
    laborVariance: await account(f, "mfgLaborEfficiencyVariance", "cogs"), overheadVariance: await account(f, "mfgOverheadVariance", "cogs") };
  const center = await run((tx) => createWorkCenter(tx, f.org.orgId, f.actorId, {
    code: "WC-" + randomUUID(), name: "Assembly cell", kind: "cell", capacityHoursPerDay: "8", efficiencyPct: "100", departmentId: f.departmentId, absorbsOverhead: true,
  }));
  await run((tx) => addWorkCenterRate(tx, f.org.orgId, f.actorId, String(center.id), { machineRatePerHour: "12", effectiveFrom: "2026-01-01" }));
  const routing = await run((tx) => createRouting(tx, f.org.orgId, f.actorId, {
    producedItemId: produced, code: "RT-" + randomUUID(), name: "Cell route", effectiveFrom: "2026-01-01",
    defaultIssueLocationId: f.org.stockLocationId, defaultReceiptLocationId: f.org.stockLocationId2, overheadBasis: "labor_hours",
  }));
  await run((tx) => createRoutingOperation(tx, f.org.orgId, f.actorId, String(routing.id), {
    sequence: 10, name: "Assemble", workCenterId: String(center.id), setupMinutes: "0", runMinutesPerUnit: "6",
  }));
  await run((tx) => activateRouting(tx, f.org.orgId, f.actorId, String(routing.id)));
  const order = await run((tx) => createWorkOrder(tx, f.org.orgId, f.actorId, {
    producedItemId: produced, quantityOrdered: "10", subsidiaryId: f.org.subsidiaryId,
    issueLocationId: f.org.stockLocationId, receiptLocationId: f.org.stockLocationId2, plannedStart: f.org.date,
  }));
  await run((tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, order.id));
  const detail = await withBypassContext(async () => ({
    material: (await db.execute<{ id: string }>(sql`select id from mfg_wo_materials where org_id=${f.org.orgId} and work_order_id=${order.id}`)).rows[0]!.id,
    operation: (await db.execute<{ id: string }>(sql`select id from mfg_wo_operations where org_id=${f.org.orgId} and work_order_id=${order.id}`)).rows[0]!.id,
  }));
  await stock(f, f.org.items.component, "20", "3");
  await issue(f, order.id, [{ materialId: detail.material, quantity: "20" }]);
  await run((tx) => startWorkOrderOperation(tx, f.org.orgId, f.actorId, order.id, detail.operation));
  return { id: order.id, number: order.number, operation: detail.operation, ...ids };
}
async function entryAmounts(f: Fixture, entryId: string) {
  return withBypassContext(async () => Object.fromEntries((await db.execute<{ account_id: string; amount: string }>(sql`
    select account_id, sum(amount)::text amount from journal_lines where org_id=${f.org.orgId} and entry_id=${entryId} group by account_id`)).rows
    .map((row) => [row.account_id, row.amount])));
}
async function normalLoss(f: Fixture, produced=f.org.items.assembly) {
  await run(tx=>tx.execute(sql`update app_roles set permissions='["manufacturing.manage","items.post"]'::jsonb where org_id=${f.org.orgId} and id in (select role_id from role_assignments where org_id=${f.org.orgId} and user_id=${f.actorId}) returning id`));
  const wo=await prepare(f,{produced,quantity:"10"});
  const operation=await withBypassContext(async()=>(await db.execute<{id:string;centerId:string}>(sql`select id,work_center_id as "centerId" from mfg_wo_operations where org_id=${f.org.orgId} and work_order_id=${wo.id}`)).rows[0]!);
  await run(tx=>addWorkCenterRate(tx,f.org.orgId,f.actorId,operation.centerId,{machineRatePerHour:"0",effectiveFrom:"2026-01-01"}));
  const reasonId=randomUUID();
  await run(tx=>tx.execute(sql`insert into mfg_scrap_reasons (id,org_id,code,name,classification,is_active) values (${reasonId},${f.org.orgId},${reasonId},'Normal production loss','normal',true) returning id`));
  await run(tx=>startWorkOrderOperation(tx,f.org.orgId,f.actorId,wo.id,operation.id));
  return {...wo,operationId:operation.id,reasonId};
}
async function scrapState(f:Fixture,id:string) {
 return withBypassContext(async()=>(await db.execute<{scrap:string;completed:string;events:number;audit:number}>(sql`select quantity_scrapped::text as scrap,quantity_completed::text as completed,(select count(*)::int from mfg_scrap_events where org_id=${f.org.orgId} and work_order_id=${id}) as events,(select count(*)::int from audit_log where org_id=${f.org.orgId} and table_name='mfg_scrap_events') as audit from mfg_work_orders where org_id=${f.org.orgId} and id=${id}`)).rows[0]!);
}
const cases: Case[] = [
  { name: "completed operations carry labor, machine and overhead into FIFO finished goods", run: async (f) => {
    const wo = await conversionOrder(f, f.org.items.assembly);
    // Standard time: 60 minutes of a staffed machine cell.
    await run((tx) => completeWorkOrderOperation(tx, f.org.orgId, f.actorId, wo.id, wo.operation, { doneQty: "10" }));
    const absorbed = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`select id from journal_entries
      where org_id=${f.org.orgId} and custom->>'work_order_number'=${wo.number} and custom ? 'conversion_labor_amount'`)).rows);
    assert.equal(absorbed.length, 1);
    const conversion = await entryAmounts(f, absorbed[0]!.id);
    assert.equal(conversion[f.wipId], "47.0000"); // 30 labor + 12 machine + 5 overhead
    assert.equal(conversion[wo.clearing], "-30.0000");
    assert.equal(conversion[wo.applied], "-17.0000");
    const result = await run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity: "10" }));
    assert.equal(result.relievedWip, "107.0000"); // 60 material + 47 conversion
    assert.equal(result.value, "107.0000");
    assert.equal(await wip(f, wo.number), "0.0000");
    assert.equal((await getOnHand(f.org.orgId, f.org.items.assembly, f.org.stockLocationId2)).value, "107.0000");
  } },
  { name: "standard output splits labor and overhead variances from production variance", run: async (f) => {
    await withBypassContext(() => db.execute(sql`update item_inventory_profiles set standard_cost='10.70'
      where org_id=${f.org.orgId} and item_id=${f.org.items.standard} returning item_id`));
    const wo = await conversionOrder(f, f.org.items.standard);
    // 72 reported minutes against 60 standard: labor 36, machine 14.40, overhead 6.
    await run((tx) => completeWorkOrderOperation(tx, f.org.orgId, f.actorId, wo.id, wo.operation,
      { doneQty: "10", actualRunMinutes: "72", actualLaborMinutes: "72" }));
    const result = await run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity: "10" }));
    const amounts = await entryAmounts(f, result.entryId);
    assert.equal(amounts[f.wipId], "-116.4000");
    assert.equal(result.value, "107.0000");
    assert.equal(amounts[wo.laborVariance], "6.0000");
    assert.equal(amounts[wo.overheadVariance], "3.4000");
    assert.equal(amounts[f.org.accounts.adjustment], undefined, "the conversion in the standard is not a production variance");
  } },
  { name: "operation completion refuses by name when its work center has no machine rate", run: async (f) => {
    const wo = await conversionOrder(f, f.org.items.assembly);
    await withBypassContext(() => db.execute(sql`delete from mfg_work_center_rates where org_id=${f.org.orgId} returning id`));
    await refuse(run((tx) => completeWorkOrderOperation(tx, f.org.orgId, f.actorId, wo.id, wo.operation, { doneQty: "10" })),
      "machine_rate_missing", "has no machine rate covering", "Add a machine rate for work center");
  } },
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
  { name: "serial receipts accept equivalent decimal spellings of one and refuse multiple units per serial", run: async (f) => {
    const wo = await prepare(f, { quantity: "3" });
    await withBypassContext(() => db.execute(sql`update item_inventory_profiles set tracking='serial' where org_id=${f.org.orgId} and item_id=${f.org.items.assembly} returning item_id`));
    await stock(f, f.org.items.component, "6", "3");
    await issue(f, wo.id, [{ materialId: wo.materials[0]!.id, quantity: "6" }]);
    await refuse(run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity: "2", lots: [{ quantity: "2.0000", serialNumber: "SERIAL-MULTIPLE" }] })), "receipt_serial_required", "one serial number per unit", "Enter a serial number");
    for (const [i, quantity] of ["1", "1.0", "1.0000"].entries()) {
      const result = await run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity, lots: [{ quantity, serialNumber: "SERIAL-" + i }] }));
      const movements = await withBypassContext(() => db.execute<{ quantity: string; status: string }>(sql`
        select m.quantity::text as quantity, s.status from inventory_movements m join serials s on s.id=m.serial_id and s.org_id=m.org_id
        where m.org_id=${f.org.orgId} and m.journal_entry_id=${result.entryId} and m.item_id=${f.org.items.assembly}`));
      assert.deepEqual(movements.rows, [{ quantity: "1.0000", status: "in_stock" }]);
    }
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
    assert.equal((await withOrgContext(f.org.orgId, () => getOnHand(f.org.orgId, f.org.items.component, f.org.stockLocationId))).quantity, "5.0000");
    const restoredLayerQuantity = await withBypassContext(async () => (await db.execute<{ quantity: string }>(sql`select coalesce(sum(remaining_quantity),0)::text quantity
      from cost_layers where org_id=${f.org.orgId} and item_id=${f.org.items.component} and stock_location_id=${f.org.stockLocationId}`)).rows[0]!.quantity);
    assert.equal(restoredLayerQuantity, "5.0000");
    assert.equal(await wip(f, wo.number), "0.0000");
    const qty = await withBypassContext(async () => (await db.execute<{ issued_qty: string }>(sql`select issued_qty::text from mfg_wo_materials where org_id=${f.org.orgId} and id=${wo.materials[0]!.id}`)).rows[0]!.issued_qty);
    assert.equal(qty, "0.0000");
    assert.equal((await run((tx) => cancelWorkOrder(tx, f.org.orgId, f.actorId, wo.id, "Cancel the stopped order"))).status, "cancelled");
  } },
  { name: "an issue carried into finished goods reverses only after the completion that carried it", run: async (f) => {
    const wo = await prepare(f); await stock(f, f.org.items.component, "5", "3");
    const issued = await issue(f, wo.id, [{ materialId: wo.materials[0]!.id, quantity: "2" }]);
    const movement = async (entryId: string, kind: string) => withBypassContext(async () => (await db.execute<{ id: string }>(sql`
      select id from inventory_movements where org_id=${f.org.orgId} and journal_entry_id=${entryId} and kind=${kind}`)).rows[0]!.id);
    const issueMovement = await movement(issued.entryId!, "assembly_consume");
    const completion = await run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity: "1" }));
    assert.equal(await wip(f, wo.number), "0.0000");
    const completionNumber = await withBypassContext(async () => (await db.execute<{ n: string }>(sql`
      select entry_number n from journal_entries where org_id=${f.org.orgId} and id=${completion.entryId}`)).rows[0]!.n);
    // The completion relieved all 6.00 of the issue to finished goods:
    // returning the material now would drive WIP to -6.00.
    await refuse(run(() => reverseMaterialIssue(f.org.orgId, f.actorId, { movementId: issueMovement, reversalDate: f.postingDate, reason: "Return the over-issue" })),
      "issue_cost_relieved_to_finished_goods", completionNumber, "Reverse the completion receipts posted after this issue");
    await run((tx) => holdWorkOrder(tx, f.org.orgId, f.actorId, wo.id, "Stop the production run"));
    // The named remedy exists: the completion receipt reverses on a held order.
    const receiptMovement = await movement(completion.entryId, "assembly_build");
    await run(() => reverseMaterialIssue(f.org.orgId, f.actorId, { movementId: receiptMovement, reversalDate: f.postingDate, reason: "Undo the finished-goods receipt" }));
    assert.equal(await wip(f, wo.number), "6.0000");
    assert.equal((await getOnHand(f.org.orgId, f.org.items.assembly, f.org.stockLocationId2)).quantity, "0.0000");
    await run(() => reverseMaterialIssue(f.org.orgId, f.actorId, { movementId: issueMovement, reversalDate: f.postingDate, reason: "Return the over-issue" }));
    assert.equal(await wip(f, wo.number), "0.0000");
    assert.equal((await run((tx) => cancelWorkOrder(tx, f.org.orgId, f.actorId, wo.id, "Cancel the stopped order"))).status, "cancelled");
  } },
  { name: "cancelling after operation time was absorbed writes the consumed conversion off", run: async (f) => {
    const wo = await conversionOrder(f, f.org.items.assembly);
    await run((tx) => completeWorkOrderOperation(tx, f.org.orgId, f.actorId, wo.id, wo.operation, { doneQty: "10" }));
    await run((tx) => holdWorkOrder(tx, f.org.orgId, f.actorId, wo.id, "Customer cancelled"));
    await refuse(run((tx) => cancelWorkOrder(tx, f.org.orgId, f.actorId, wo.id, "Customer cancelled")), "work_order_has_postings", "posted manufacturing entries", "through the inventory movement reversal");
    const issueMovement = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`select movement.id from inventory_movements movement
      join journal_entries entry on entry.org_id=movement.org_id and entry.id=movement.journal_entry_id
      where movement.org_id=${f.org.orgId} and movement.kind='assembly_consume' and entry.custom->>'work_order_number'=${wo.number}`)).rows[0]!.id);
    await run(() => reverseMaterialIssue(f.org.orgId, f.actorId, { movementId: issueMovement, reversalDate: f.postingDate, reason: "Return unused material" }));
    assert.equal(await wip(f, wo.number), "47.0000");
    assert.equal((await run((tx) => cancelWorkOrder(tx, f.org.orgId, f.actorId, wo.id, "Customer cancelled"))).status, "cancelled");
    assert.equal(await wip(f, wo.number), "0.0000");
    const writeOff = await withBypassContext(async () => (await db.execute<{ amount: string }>(sql`select line.amount::text amount
      from journal_lines line join journal_entries entry on entry.org_id=line.org_id and entry.id=line.entry_id
      where line.org_id=${f.org.orgId} and line.account_id=${f.org.accounts.adjustment} and entry.entry_number like 'MFG-CANCEL-%'`)).rows);
    assert.deepEqual(writeOff, [{ amount: "47.0000" }]);
  } },
  { name: "issue reversal refuses after the order is done", run: async (f) => {
    const wo = await prepare(f); await stock(f, f.org.items.component, "4", "3"); const issued = await issue(f, wo.id, [{ materialId: wo.materials[0]!.id, quantity: "2" }]);
    const movementId = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`select id from inventory_movements where org_id=${f.org.orgId} and journal_entry_id=${issued.entryId} and kind='assembly_consume'`)).rows[0]!.id);
    await run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity: "1" })); await run((tx) => markWorkOrderDone(tx, f.org.orgId, f.actorId, wo.id));
    await refuse(run(() => reverseMaterialIssue(f.org.orgId, f.actorId, { movementId, reversalDate: f.postingDate, reason: "Correct the issue quantity" })), "issue_reversal_after_completion", "cannot be reversed after it is done");
  } },
];
cases.push(
 {name:"normal loss is scoped, replayable, quantity bounded and atomic with audit",run:async f=>{
  const wo=await normalLoss(f),id=randomUUID(),input={operationId:wo.operationId,quantity:"2",reasonId:wo.reasonId};
  await assert.rejects(run(tx=>recordNormalScrap(tx,f.org.orgId,f.actorId,new Set(),wo.id,id,input)),e=>e instanceof ManufacturingError&&e.status===404);
  const before=await counts(f);
  await run(tx=>recordNormalScrap(tx,f.org.orgId,f.actorId,null,wo.id,id,input));
  await run(tx=>recordNormalScrap(tx,f.org.orgId,f.actorId,null,wo.id,id,input));
  assert.deepEqual(await scrapState(f,wo.id),{scrap:"2.0000",completed:"0.0000",events:1,audit:1});
  assert.deepEqual(await counts(f),before,"evidence does not post an inventory or accounting loss");
  const frozen=await withBypassContext(async()=>(await db.execute(sql`select treatment,frozen_value::text,approval_required,posted_entry_id from mfg_scrap_events where org_id=${f.org.orgId} and id=${id}`)).rows[0]);
  assert.deepEqual(frozen,{treatment:"evidence",frozen_value:"0.0000",approval_required:false,posted_entry_id:null});
  await assert.rejects(run(tx=>recordNormalScrap(tx,f.org.orgId,f.actorId,null,wo.id,id,{...input,quantity:"3"})),e=>e instanceof ManufacturingError&&e.code==='idempotency_key_conflict');
  await assert.rejects(run(tx=>recordNormalScrap(tx,f.org.orgId,f.actorId,null,wo.id,randomUUID(),{...input,quantity:"8"})),e=>e instanceof ManufacturingError&&e.code==='all_loss_disposition_required');
  await assert.rejects(run(async tx=>{await recordNormalScrap(tx,f.org.orgId,f.actorId,null,wo.id,randomUUID(),{...input,quantity:"1"});throw new Error('rollback normal loss')}),/rollback normal loss/);
  assert.deepEqual(await scrapState(f,wo.id),{scrap:"2.0000",completed:"0.0000",events:1,audit:1});
  await assert.rejects(run(tx=>completeWorkOrderOperation(tx,f.org.orgId,f.actorId,wo.id,wo.operationId,{doneQty:"9"})),e=>e instanceof ManufacturingError&&e.code==='completion_tolerance_exceeded');
  assert.equal((await run(tx=>listManufacturingRecords(tx,f.org.orgId,new Set(),'work-orders'))).total,0);
  assert.ok((await run(tx=>searchManufacturingChoices(tx,f.org.orgId,new Set(),'items','',f.org.items.component))).some(item=>item.value===f.org.items.component),'organization-owned item identities do not fabricate entity ownership');
  const selected=await run(tx=>searchManufacturingChoices(tx,f.org.orgId,null,'items','no-matching-item-name',f.org.items.component));
  assert.equal(selected[0]?.value,f.org.items.component,"a selected visible item remains resolvable when it is outside the search window");

  await assert.rejects(run(tx=>readManufacturingRecord(tx,f.org.orgId,new Set(),'work-orders',wo.id)),e=>e instanceof ManufacturingError&&e.status===404);
 }},
 {name:"normal loss splits exact actual-cost receipts, replays and reverses without rewriting scrap",run:async f=>{
  const wo=await normalLoss(f),input={operationId:wo.operationId,quantity:"2",reasonId:wo.reasonId};
  await run(tx=>recordNormalScrap(tx,f.org.orgId,f.actorId,null,wo.id,randomUUID(),input));
  await stock(f,f.org.items.component,"20","3");
  const issueKey=randomUUID(),lines=[{materialId:wo.materials[0]!.id,quantity:"20"}];
  const issueCommand=()=>withBypassContext(()=>executeManufacturingIssue(f.org.orgId,f.actorId,null,wo.id,issueKey,lines));
  assert.equal((await issueCommand()).replayed,false);const issued=await counts(f);assert.equal((await issueCommand()).replayed,true);assert.deepEqual(await counts(f),issued);
  await run(tx=>completeWorkOrderOperation(tx,f.org.orgId,f.actorId,wo.id,wo.operationId,{doneQty:"8"}));
  await assert.rejects(run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,wo.id,{quantity:"9"})),e=>e instanceof ManufacturingError&&e.code==='completion_tolerance_exceeded');
  const key=randomUUID(),receipt=()=>withBypassContext(()=>executeManufacturingReceipt(f.org.orgId,f.actorId,null,wo.id,key,{quantity:"3"}));
  const first=await receipt();assert.equal(first.value.relievedWip,"22.5000");const evidence=await counts(f);assert.deepEqual((await receipt()).value,first.value);assert.deepEqual(await counts(f),evidence);
  await assert.rejects(run(tx=>recordNormalScrap(tx,f.org.orgId,f.actorId,null,wo.id,randomUUID(),{...input,quantity:"1"})),e=>e instanceof ManufacturingError&&e.code==='scrap_after_receipt_requires_review');
  const last=await run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,wo.id,{quantity:"5"}));assert.equal(last.relievedWip,"37.5000");assert.equal(await wip(f,wo.number),"0.0000");
  const movement=await withBypassContext(async()=>(await db.execute<{id:string}>(sql`select id from inventory_movements where org_id=${f.org.orgId} and journal_entry_id=${last.entryId} and kind='assembly_build'`)).rows[0]!);
  await run(()=>reverseMaterialIssue(f.org.orgId,f.actorId,{movementId:movement.id,reversalDate:f.postingDate,reason:'Correct finished receipt quantity'}));
  assert.equal(await wip(f,wo.number),"37.5000");assert.deepEqual(await scrapState(f,wo.id),{scrap:"2.0000",completed:"3.0000",events:1,audit:1});
  assert.equal((await run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,wo.id,{quantity:"5"}))).relievedWip,"37.5000");
  await assert.rejects(run(tx=>markWorkOrderDone(tx,f.org.orgId,f.actorId,wo.id)),e=>e instanceof ManufacturingError&&e.code==='short_close_reason_required');
  await run(tx=>markWorkOrderDone(tx,f.org.orgId,f.actorId,wo.id,{shortCloseReason:'Two units of normal production loss'}));
  assert.equal(await wip(f,wo.number),"0.0000");
  const read=await run(tx=>readManufacturingRecord(tx,f.org.orgId,null,'work-orders',wo.id));assert.equal(read.sections.scrap!.length,1);assert.ok(read.sections.receipts!.length>=2);assert.ok(read.sections.entries!.length>=3);
 }},
 {name:"normal loss retains frozen standard output valuation and clears WIP through native variance",run:async f=>{
  const wo=await normalLoss(f,f.org.items.standard);
  await run(tx=>recordNormalScrap(tx,f.org.orgId,f.actorId,null,wo.id,randomUUID(),{operationId:wo.operationId,quantity:"2",reasonId:wo.reasonId}));
  await stock(f,f.org.items.component,"10","3");await issue(f,wo.id,[{materialId:wo.materials[0]!.id,quantity:"10"}]);
  await run(tx=>completeWorkOrderOperation(tx,f.org.orgId,f.actorId,wo.id,wo.operationId,{doneQty:"8"}));
  await run(tx=>tx.execute(sql`update item_inventory_profiles set standard_cost='99' where org_id=${f.org.orgId} and item_id=${f.org.items.standard} returning item_id`));
  const receipt=await run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,wo.id,{quantity:"8"}));assert.equal(receipt.value,"16.0000");assert.equal(receipt.relievedWip,"30.0000");assert.equal(await wip(f,wo.number),"0.0000");
  const balance=await withBypassContext(async()=>(await db.execute<{amount:string}>(sql`select sum(amount)::text as amount from journal_lines where org_id=${f.org.orgId} and entry_id=${receipt.entryId}`)).rows[0]!.amount);assert.equal(balance,"0.0000");
 }},
 {name:"live execution authority refuses revoked grants, unknown actors and derived entity narrowing before replay",run:async f=>{
  const wo=await normalLoss(f),input={operationId:wo.operationId,quantity:"1",reasonId:wo.reasonId},scrapKey=randomUUID();
  await run(tx=>recordNormalScrap(tx,f.org.orgId,f.actorId,null,wo.id,scrapKey,input));
  await stock(f,f.org.items.component,"20","3");const lines=[{materialId:wo.materials[0]!.id,quantity:"20"}],issueKey=randomUUID(),receiptKey=randomUUID();
  await withBypassContext(()=>executeManufacturingIssue(f.org.orgId,f.actorId,null,wo.id,issueKey,lines));
  await withBypassContext(()=>executeManufacturingReceipt(f.org.orgId,f.actorId,null,wo.id,receiptKey,{quantity:"1"}));
  const before=await counts(f),scrapBefore=await scrapState(f,wo.id);
  const denied=(work:Promise<unknown>)=>assert.rejects(work,e=>typeof e==='object'&&e!==null&&'status' in e&&e.status===404);
  const attempts=async()=>{
   await denied(run(tx=>recordNormalScrap(tx,f.org.orgId,f.actorId,null,wo.id,scrapKey,input)));
   await denied(run(tx=>recordNormalScrap(tx,f.org.orgId,f.actorId,null,wo.id,randomUUID(),input)));
   await denied(withBypassContext(()=>executeManufacturingIssue(f.org.orgId,f.actorId,null,wo.id,issueKey,lines)));
   await denied(withBypassContext(()=>executeManufacturingIssue(f.org.orgId,f.actorId,null,wo.id,randomUUID(),lines)));
   await denied(withBypassContext(()=>executeManufacturingReceipt(f.org.orgId,f.actorId,null,wo.id,receiptKey,{quantity:"1"})));
   await denied(withBypassContext(()=>executeManufacturingReceipt(f.org.orgId,f.actorId,null,wo.id,randomUUID(),{quantity:"1"})));
   assert.deepEqual(await counts(f),before);assert.deepEqual(await scrapState(f,wo.id),scrapBefore);
  };
  for(const remaining of ['manufacturing.manage','items.post']){
   await run(tx=>tx.execute(sql`update app_roles set permissions=${JSON.stringify([remaining])}::jsonb where org_id=${f.org.orgId} returning id`));await attempts();
  }
  await run(tx=>tx.execute(sql`update app_roles set permissions='["manufacturing.manage","items.post"]'::jsonb,subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb where org_id=${f.org.orgId} returning id`));await attempts();
  await run(tx=>tx.execute(sql`update app_roles set subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${f.org.orgId} returning id`));
  for(const unknown of [randomUUID()]){
   await denied(run(tx=>recordNormalScrap(tx,f.org.orgId,unknown,null,wo.id,scrapKey,input)));
   await denied(withBypassContext(()=>executeManufacturingReceipt(f.org.orgId,unknown,null,wo.id,receiptKey,{quantity:"1"})));
   await denied(withBypassContext(()=>executeManufacturingIssue(f.org.orgId,unknown,null,wo.id,issueKey,lines)));
  }
  await denied(withBypassContext(()=>executeManufacturingReceipt(f.org.orgId,f.actorId,new Set(),wo.id,receiptKey,{quantity:"1"})));
  const foreign=await withBypassContext(()=>createScratchOrg());
  try{const actor=await withBypassContext(()=>createScratchUser(foreign.orgId,'Foreign operator','admin'));await denied(withBypassContext(()=>executeManufacturingReceipt(f.org.orgId,actor,null,wo.id,receiptKey,{quantity:'1'})));await denied(run(tx=>recordNormalScrap(tx,f.org.orgId,actor,null,wo.id,scrapKey,input)))}finally{await withBypassContext(()=>dropScratchOrg(foreign.orgId))}
  assert.deepEqual(await counts(f),before);assert.deepEqual(await scrapState(f,wo.id),scrapBefore);
 }},
 {name:"concurrent normal-loss retries count once and distinct events accumulate under the order lock",run:async f=>{
  const wo=await normalLoss(f),id=randomUUID(),input={operationId:wo.operationId,quantity:"1",reasonId:wo.reasonId};
  await Promise.all([run(tx=>recordNormalScrap(tx,f.org.orgId,f.actorId,null,wo.id,id,input)),run(tx=>recordNormalScrap(tx,f.org.orgId,f.actorId,null,wo.id,id,input))]);
  assert.equal((await scrapState(f,wo.id)).scrap,"1.0000");
  await Promise.all([run(tx=>recordNormalScrap(tx,f.org.orgId,f.actorId,null,wo.id,randomUUID(),input)),run(tx=>recordNormalScrap(tx,f.org.orgId,f.actorId,null,wo.id,randomUUID(),input))]);
  assert.deepEqual(await scrapState(f,wo.id),{scrap:"3.0000",completed:"0.0000",events:3,audit:3});
 }}
);


cases.push({ name: "native workspace uses organization item identity and current whole-resource entity visibility", run: async (f) => {
  await route(f, f.org.items.component);
  await run(tx => upsertItemPolicy(tx, f.org.orgId, f.actorId, f.org.items.component, {
    supplyMethod: "make", leadTimeDays: 1, safetyStockQty: "0", minimumQty: "0", orderMultipleQty: "0", scrapPctPlanned: "0",
  }));
  await run(tx => tx.execute(sql`insert into bom_components (org_id,assembly_item_id,component_item_id,quantity_per,sort_order)
    values (${f.org.orgId},${f.org.items.component},${f.org.items.standard},'1',0) returning id`));
  const parent = await prepare(f);
  const children = await run(async tx => (await tx.execute<{ id: string }>(sql`select id from mfg_work_orders
    where org_id=${f.org.orgId} and parent_wo_id=${parent.id}`)).rows);
  assert.equal(children.length, 1, "native release creates the subassembly child");
  const childId = children[0]!.id;
  const resourceRows = await run(async tx => (await tx.execute<{ work_order_id: string; work_center_id: string; routing_id: string }>(sql`
    select operation.work_order_id,operation.work_center_id,orders.routing_id from mfg_wo_operations operation
    join mfg_work_orders orders on orders.org_id=operation.org_id and orders.id=operation.work_order_id
    where operation.org_id=${f.org.orgId} and operation.work_order_id in (${parent.id},${childId})`)).rows);
  assert.equal(resourceRows.length, 2);
  for (const row of resourceRows) await run(tx => updateWorkCenter(tx, f.org.orgId, f.actorId, row.work_center_id, { subsidiaryId: f.org.subsidiaryId }));
  const parentResource = resourceRows.find(row => row.work_order_id === parent.id)!;
  const childResource = resourceRows.find(row => row.work_order_id === childId)!;
  const allowed = new Set([f.org.subsidiaryId]);
  const read = (view: "work-orders" | "routings", id: string) => run(tx => readManufacturingRecord(tx, f.org.orgId, allowed, view, id));
  const list = (view: "work-orders" | "routings" | "work-centers") => run(tx => listManufacturingRecords(tx, f.org.orgId, allowed, view));
  const denied = (work: Promise<unknown>) => assert.rejects(work, error => error instanceof ManufacturingError && error.status === 404);
  assert.deepEqual(new Set((await list("work-orders")).rows.map(row => row.id)), new Set([parent.id, childId]));
  assert.equal((await read("work-orders", parent.id)).sections.children!.length, 1);
  assert.equal((await read("routings", parentResource.routing_id)).sections.operations!.length, 1);
  assert.equal((await list("routings")).total, 2);
  assert.equal((await list("work-centers")).total, 2);
  const options = await run(tx => manufacturingOptions(tx, f.org.orgId, allowed));
  assert.ok(options.items.some(item => item.value === f.org.items.assembly));
  assert.equal(options.routings.length, 2);
  assert.ok((await run(tx => searchManufacturingChoices(tx, f.org.orgId, allowed, "items", "no-match", f.org.items.component))).some(item => item.value === f.org.items.component));
  assert.deepEqual(await run(tx => manufacturingTracking(tx, f.org.orgId, allowed, f.org.items.component)), { lots: [], serials: [] });
  await denied(run(tx => manufacturingTracking(tx, f.org.orgId, allowed, randomUUID())));

  const otherEntity = randomUUID();
  assert.equal((await run(tx => tx.execute(sql`insert into subsidiaries
    (id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
    values (${otherEntity},${f.org.orgId},${f.org.subsidiaryId},'Other manufacturing entity','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb) returning id`))).rows.length, 1);
  const otherCenter = await run(tx => createWorkCenter(tx, f.org.orgId, f.actorId, {
    code: "OTHER-" + randomUUID(), name: "Other entity resource", kind: "machine", subsidiaryId: otherEntity,
    capacityHoursPerDay: "8", efficiencyPct: "100", departmentId: f.departmentId, absorbsOverhead: false,
  }));
  const next = await run(tx => createNextRoutingVersion(tx, f.org.orgId, f.actorId, parentResource.routing_id));
  const copied = next.operations[0]!;
  await run(tx => updateRoutingOperation(tx, f.org.orgId, f.actorId, String(next.id), String(copied.id), { workCenterId: String(otherCenter.id) }));
  assert.deepEqual((await read("routings", parentResource.routing_id)).sections.versions!.map(row => row.id), [parentResource.routing_id], "related versions are filtered using their own current resources");
  await denied(read("routings", String(next.id)));
  assert.equal((await list("routings")).total, 2);
  assert.equal((await run(tx => getRouting(tx, f.org.orgId, parentResource.routing_id)))?.operations.length, 1);

  await run(tx => updateWorkCenter(tx, f.org.orgId, f.actorId, childResource.work_center_id, { subsidiaryId: otherEntity }));
  assert.deepEqual((await read("work-orders", parent.id)).sections.children, [], "a child's resource change is visible on the next parent read");
  await denied(read("work-orders", childId));
  assert.deepEqual((await list("work-orders")).rows.map(row => row.id), [parent.id]);
  assert.deepEqual((await run(tx => manufacturingOptions(tx, f.org.orgId, allowed))).routings.map(row => row.value), [parentResource.routing_id]);
  await run(tx => updateWorkCenter(tx, f.org.orgId, f.actorId, parentResource.work_center_id, { subsidiaryId: otherEntity }));
  await denied(read("work-orders", parent.id));
  await denied(read("routings", parentResource.routing_id));
  assert.equal((await list("work-orders")).total, 0);
  assert.equal((await list("routings")).total, 0);
  for (const row of resourceRows) await run(tx => updateWorkCenter(tx, f.org.orgId, f.actorId, row.work_center_id, { subsidiaryId: f.org.subsidiaryId }));
  assert.equal((await list("work-orders")).total, 2);
  assert.equal((await run(tx => tx.execute(sql`update locations set subsidiary_id=${otherEntity},subsidiary_include_children=false
    where org_id=${f.org.orgId} and id=${f.org.locationId} returning id`))).rows.length, 1);
  await denied(read("work-orders", parent.id));
  await denied(read("routings", parentResource.routing_id));
  assert.equal((await list("work-orders")).total, 0);
  assert.equal((await list("routings")).total, 0);
  assert.equal((await run(tx => manufacturingOptions(tx, f.org.orgId, allowed))).routings.length, 0);

  await run(tx => tx.execute(sql`update orgs set settings=jsonb_set(settings,'{features,manufacturingMrp}','true'::jsonb,true) where id=${f.org.orgId} returning id`));
  await run(tx => upsertItemPolicy(tx, f.org.orgId, f.actorId, f.org.items.standard, {
    supplyMethod: "buy", leadTimeDays: 1, safetyStockQty: "0", minimumQty: "0", orderMultipleQty: "0", scrapPctPlanned: "0",
  }));
  // This caller exercises the run's legal-entity read fence; capacity calendars belong to the capacity cases.
  const mrp = await run(tx => runMrp(tx, f.org.orgId, f.actorId, { subsidiaryId: f.org.subsidiaryId, horizonDays: 30, capacityCheck: false }));
  assert.equal((await run(tx => listManufacturingRecords(tx, f.org.orgId, allowed, "mrp"))).rows[0]?.id, mrp.id);
  assert.equal((await run(tx => readManufacturingRecord(tx, f.org.orgId, allowed, "mrp", mrp.id))).record.id, mrp.id);
  await denied(run(tx => readManufacturingRecord(tx, f.org.orgId, new Set([otherEntity]), "mrp", mrp.id)));

  const foreign = await withBypassContext(() => createScratchOrg());
  try {
    await denied(run(tx => assertManufacturingItemExists(tx, f.org.orgId, foreign.items.assembly)));
    assert.equal((await run(tx => tx.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
      coalesce(settings->'features','{}'::jsonb)||'{"manufacturing":true,"inventory":true}'::jsonb)
      where id=${foreign.orgId} returning id`))).rows.length, 1);
    await denied(run(tx => readManufacturingRecord(tx, foreign.orgId, null, "work-orders", parent.id)));
    assert.deepEqual(await run(tx => searchManufacturingChoices(tx, f.org.orgId, allowed, "items", "no-match", foreign.items.assembly)), []);
  } finally { await withBypassContext(() => dropScratchOrg(foreign.orgId)); }
}});

test("manufacturing completion and reversal case table", { skip: !DB }, async () => {
  for (const scenario of cases) {
    const f = await setup();
    try { await scenario.run(f); }
    catch (error) { throw new Error(scenario.name + ": " + (error instanceof Error ? error.message : String(error)), { cause: error }); }
    finally { await withBypassContext(() => dropScratchOrg(f.org.orgId)); }
  }
});
