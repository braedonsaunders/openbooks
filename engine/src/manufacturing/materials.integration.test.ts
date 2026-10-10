import { approveFixtureRouting, createManufacturingOperator } from "../testing/manufacturing.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { withSimClock } from "../platform/clock.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { ensureLot } from "../inventory/tracking.ts";
import { receiveInventory } from "../inventory/movements.ts";
import { primaryBookId } from "../inventory/position.ts";
import { recordNormalScrap } from "./scrap.ts";
import { ManufacturingError } from "./errors.ts";
import { createRouting, createRoutingOperation } from "./routings.ts";
import { addWorkCenterRate, createWorkCenter } from "./work-centers.ts";
import { createWorkOrder, holdWorkOrder, releaseWorkOrder, startWorkOrderOperation } from "./work-orders.ts";
import { completeWorkOrderOperation, issueMaterials } from "./materials.ts";
import { createSandbox, deleteSandbox } from "../sandbox/lifecycle.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
type Fixture = { org: ScratchOrg; actorId: string; wipId: string; departmentId: string };
type Case = { name: string; run: (f: Fixture) => Promise<void> };
function run<T>(work: (tx: SqlExecutor) => Promise<T>) { return withBypassContext(() => db.transaction(work)); }

async function setup(): Promise<Fixture> {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createManufacturingOperator(org.orgId, "Shop lead"));
    const wipId = randomUUID(), departmentId = randomUUID();
    await withBypassContext(async () => {
      const department = await db.execute<{ id: string }>(sql`insert into departments (id, org_id, name, subsidiary_id)
        values (${departmentId}, ${org.orgId}, 'Assembly', ${org.subsidiaryId}) returning id`);
      assert.equal(department.rows.length, 1, "assembly department fixture must be created before work-order release");
      const laborRate = await db.execute<{ id: string }>(sql`insert into labor_cost_rates
        (org_id, department_id, currency, rate, basis, annual_hours, effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${departmentId}, 'CAD', '0', 'hour', '2080', '2026-01-01', true, ${actorId}, ${actorId})
        returning id`);
      assert.equal(laborRate.rows.length, 1, "assembly labor-cost rate fixture must cover work-order release");
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"manufacturing":true,"inventory":true,"warehousing":true}'::jsonb) where id=${org.orgId} returning id`);
      await db.execute(sql`insert into accounts (id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children)
        values (${wipId},${org.orgId},'1210','Manufacturing WIP','asset_current_other',false,true,false,false,'[]'::jsonb,'{}'::jsonb,true) returning id`);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts,mfgWip}',to_jsonb(${wipId}::text),true) where id=${org.orgId} returning id`);
      await db.execute(sql`insert into accounting_periods (id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
        select ${randomUUID()},${org.orgId},extract(year from current_date)::int,extract(month from current_date)::int,
          to_char(current_date,'YYYY-MM'),date_trunc('month',current_date)::date,(date_trunc('month',current_date)+interval '1 month - 1 day')::date,false,fiscal_calendar_id
          from accounting_periods where id=${org.periodId}
          and not exists (select 1 from accounting_periods where org_id=${org.orgId} and current_date between starts_on and ends_on and not is_adjustment) returning id`);
    });
    return { org, actorId, wipId, departmentId };
  } catch (error) { await withBypassContext(() => dropScratchOrg(org.orgId)); throw error; }
}

async function prepare(f: Fixture, input: {
  backflushAt?: "none" | "start" | "finish"; qualityGate?: "none" | "measure";
  operationSeq?: number | null; quantityPer?: string; scrapPct?: string | null; orderQty?: string; tracking?: "none" | "lot" | "serial";
} = {}) {
  const cfg = { backflushAt: "none" as const, qualityGate: "none" as const, operationSeq: null as number | null,
    quantityPer: "2", scrapPct: null as string | null, orderQty: "1", tracking: "none" as const, ...input };
  await run(async (tx) => {
    await tx.execute(sql`update item_inventory_profiles set tracking=${cfg.tracking},allow_negative_inventory=false where org_id=${f.org.orgId} and item_id=${f.org.items.component} returning item_id`);
    await tx.execute(sql`update bom_components set quantity_per=${cfg.quantityPer},scrap_pct=${cfg.scrapPct},operation_seq=${cfg.operationSeq}
      where org_id=${f.org.orgId} and assembly_item_id=${f.org.items.assembly} and component_item_id=${f.org.items.component} returning id`);
  });
  const center = await run((tx) => createWorkCenter(tx, f.org.orgId, f.actorId, {
    code: `WC-${randomUUID()}`, name: "Assembly center", kind: "machine", capacityHoursPerDay: "8", efficiencyPct: "100", departmentId: f.departmentId, absorbsOverhead: false,
  }));
  // An explicit zero machine rate: these cases exercise material flows, and
  // operation completion refuses a machine center with no rate at all.
  await run((tx) => addWorkCenterRate(tx, f.org.orgId, f.actorId, String(center.id), { machineRatePerHour: "0", effectiveFrom: "2026-01-01" }));
  const routing = await run((tx) => createRouting(tx, f.org.orgId, f.actorId, {
    producedItemId: f.org.items.assembly, code: `RT-${randomUUID()}`, name: "Assembly route", effectiveFrom: "2026-01-01",
    defaultIssueLocationId: f.org.stockLocationId, defaultReceiptLocationId: f.org.stockLocationId2, overheadBasis: "units",
  }));
  await run((tx) => createRoutingOperation(tx, f.org.orgId, f.actorId, String(routing.id), {
    sequence: 10, name: "Assemble", workCenterId: String(center.id), setupMinutes: "0", runMinutesPerUnit: "1",
    backflushAt: cfg.backflushAt, qualityGate: cfg.qualityGate,
  }));
  await run((tx) => approveFixtureRouting(tx, f.org.orgId, f.actorId, String(routing.id)));
  const draft = await run((tx) => createWorkOrder(tx, f.org.orgId, f.actorId, {
    producedItemId: f.org.items.assembly, quantityOrdered: cfg.orderQty, subsidiaryId: f.org.subsidiaryId,
    issueLocationId: f.org.stockLocationId, receiptLocationId: f.org.stockLocationId2, plannedStart: f.org.date,
  }));
  await run((tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, draft.id));
  return withBypassContext(async () => ({
    id: draft.id,
    number: draft.number,
    materialId: (await db.execute<{ id: string }>(sql`select id from mfg_wo_materials where org_id=${f.org.orgId} and work_order_id=${draft.id}`)).rows[0]!.id,
    operationId: (await db.execute<{ id: string }>(sql`select id from mfg_wo_operations where org_id=${f.org.orgId} and work_order_id=${draft.id}`)).rows[0]!.id,
  }));
}

async function stock(f: Fixture, quantity: string, unitCost: string, lotName?: string) {
  const lotId = lotName ? await withBypassContext(() => ensureLot(f.org.orgId, f.org.items.component, lotName, null, f.actorId)) : null;
  await withBypassContext(() => receiveInventory(f.org.orgId, f.actorId, {
    itemId: f.org.items.component, stockLocationId: f.org.stockLocationId, quantity, unitCost,
    subsidiaryId: f.org.subsidiaryId, offsetAccountId: f.org.accounts.clearing, date: f.org.date, lotId,
  }));
  return lotId;
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
async function orderPostingDate(f: Fixture, number: string) {
  return withBypassContext(async () => (await db.execute<{ date: string }>(sql`select posting_date::text as date from journal_entries where org_id=${f.org.orgId} and origin='manufacturing' and custom->>'work_order_number'=${number} order by id desc limit 1`)).rows[0]?.date);
}
async function issue(f: Fixture, orderId: string, materialId: string, quantity = "1", lotId?: string | null, serialId?: string | null) {
  return run((tx) => issueMaterials(tx, f.org.orgId, f.actorId, orderId, [{ materialId, quantity, lotId, serialId }]));
}
async function componentLabel(f: Fixture) {
  return withBypassContext(async () => (await db.execute<{ label: string }>(sql`select coalesce(nullif(trim(code),''),name) as label from items where org_id=${f.org.orgId} and id=${f.org.items.component}`)).rows[0]!.label);
}
async function refuses(work: Promise<unknown>, code: string, text: string, remedy?: string) {
  await assert.rejects(work, (error: unknown) => error instanceof ManufacturingError && error.code === code
    && error.message.includes(text) && Boolean(error.remedy?.trim()) && (remedy === undefined || error.remedy === remedy));
}

async function withSandboxClone(f: Fixture, masked: boolean, work: (orgId: string) => Promise<void>) {
  const name = `Manufacturing ${randomUUID()}`;
  let failure: unknown;
  try {
    const clone = await withBypassContext(() => createSandbox({ productionOrgId: f.org.orgId, name, tier: masked ? "masked" : "full", masked, createdBy: f.actorId }));
    const state = await withBypassContext(() => db.execute<{ status: string }>(sql`
      select status from sandboxes where id=${clone.sandboxId} and org_id=${clone.sandboxOrgId}`));
    assert.equal(state.rows[0]?.status, "ready", "only a preserved, validated clone may run the scenario");
    await work(clone.sandboxOrgId);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await withBypassContext(async () => {
        const shells = (await db.execute<{ id: string }>(sql`
          select id from sandboxes where production_org_id=${f.org.orgId} and name=${name}`)).rows;
        for (const shell of shells) await deleteSandbox(shell.id, { actorId: f.actorId });
      });
    } catch (cleanupError) {
      if (failure) throw new AggregateError([failure, cleanupError], "Manufacturing clone scenario and cleanup both failed", { cause: failure });
      throw cleanupError;
    }
  }
}

const cases: Case[] = [
  { name: "material issue uses the organization's business date", run: async (f) => {
    const order = await prepare(f); await stock(f, "4", "2");
    await withVancouverDate(f, async () => {
      const posted = await issue(f, order.id, order.materialId);
      const date = await withBypassContext(async () => (await db.execute<{ date: string }>(sql`select posting_date::text date from journal_entries where org_id=${f.org.orgId} and id=${posted.entryId}`)).rows[0]?.date);
      assert.equal(date, "2026-10-31");
    });
  } },
  { name: "start backflush uses the organization's business date", run: async (f) => {
    const order = await prepare(f, { backflushAt: "start", operationSeq: 10 }); await stock(f, "4", "2");
    await withVancouverDate(f, async () => {
      await run((tx) => startWorkOrderOperation(tx, f.org.orgId, f.actorId, order.id, order.operationId));
      assert.equal(await orderPostingDate(f, order.number), "2026-10-31");
    });
  } },
  { name: "operation completion backflush uses the organization's business date", run: async (f) => {
    const order = await prepare(f, { backflushAt: "finish", operationSeq: 10 }); await stock(f, "4", "2");
    await withVancouverDate(f, async () => {
      await run((tx) => startWorkOrderOperation(tx, f.org.orgId, f.actorId, order.id, order.operationId));
      await run((tx) => completeWorkOrderOperation(tx, f.org.orgId, f.actorId, order.id, order.operationId, { doneQty: "1" }));
      assert.equal(await orderPostingDate(f, order.number), "2026-10-31");
    });
  } },
  { name: "explicit issue posts balanced WIP at layer cost and links movement", run: async (f) => {
    const order = await prepare(f, { operationSeq: 10 }); await stock(f, "5", "3"); const result = await issue(f, order.id, order.materialId, "2");
    const rows = await withBypassContext(async () => {
      const bookId = await primaryBookId(f.org.orgId, db);
      return db.execute<{ total: string; movement: string; kind: string }>(sql`select sum(line.amount)::text as total,
        movement.journal_entry_id as movement,movement.kind from journal_lines line
        join journal_entries entry on entry.org_id=line.org_id and entry.id=line.entry_id
        join inventory_movements movement on movement.org_id=line.org_id and movement.journal_entry_id=line.entry_id
        where line.org_id=${f.org.orgId} and line.entry_id=${result.entryId} and entry.book_id=${bookId}
          and entry.status in ('posted','reversed') group by movement.journal_entry_id,movement.kind`);
    });
    assert.equal(rows.rows[0]?.total, "0.0000"); assert.equal(rows.rows[0]?.movement, result.entryId); assert.equal(rows.rows[0]?.kind, "assembly_consume");
  } },
  { name: "tracked explicit issue refuses without a lot", run: async (f) => {
    const order = await prepare(f, { tracking: "lot" }); await stock(f, "2", "3", "LOT-A");
    await assert.rejects(issue(f, order.id, order.materialId, "1"), /lot-tracked item requires a lot/);
  } },
  { name: "released measure and scrap snapshots survive full and masked sandbox cloning without audit rows", run: async (f) => {
    const order = await prepare(f, { backflushAt: "start", qualityGate: "measure", operationSeq: 10, quantityPer: "2", scrapPct: "10", orderQty: "2" });
    await stock(f, "5", "2");
    for (const masked of [false, true]) await withSandboxClone(f, masked, async (orgId) => {
      const copied = await withBypassContext(() => db.execute<{ tracking: string; quantity: string }>(sql`
        select profile.tracking,movement.quantity::text as quantity from inventory_movements movement
        join item_inventory_profiles profile on profile.org_id=movement.org_id and profile.item_id=movement.item_id
        where movement.org_id=${orgId} and movement.kind='receipt'`));
      assert.equal(copied.rows.length, 1, "the clone must preserve the valued receipt and its profile");
      assert.equal(copied.rows[0]!.tracking, "none");
      assert.equal(copied.rows[0]!.quantity, "5.0000");
      const clone = await withBypassContext(async () => (await db.execute<{ id: string; operation_id: string }>(sql`select wo.id,operation.id as operation_id from mfg_work_orders wo join mfg_wo_operations operation on operation.org_id=wo.org_id and operation.work_order_id=wo.id where wo.org_id=${orgId} and wo.number=${order.number}`)).rows[0]!);
      await run((tx) => startWorkOrderOperation(tx, orgId, f.actorId, clone.id, clone.operation_id));
      assert.equal((await withBypassContext(async () => db.execute<{ quantity: string }>(sql`select quantity::text from inventory_movements where org_id=${orgId} and kind='assembly_consume'`))).rows[0]?.quantity, "-4.4000");
      await refuses(run((tx) => completeWorkOrderOperation(tx, orgId, f.actorId, clone.id, clone.operation_id, { doneQty: "1" })), "measured_quantity_required", "measured quantity");
    });
  } },
  { name: "finish backflush uses reported quantity and scrap", run: async (f) => {
    const order = await prepare(f, { backflushAt: "finish", operationSeq: 10, quantityPer: "2", scrapPct: "10", orderQty: "2" });
    await stock(f, "5", "2"); await run((tx) => startWorkOrderOperation(tx, f.org.orgId, f.actorId, order.id, order.operationId));
    await run((tx) => completeWorkOrderOperation(tx, f.org.orgId, f.actorId, order.id, order.operationId, { doneQty: "1" }));
    const row = await withBypassContext(async () => db.execute<{ quantity: string }>(sql`select quantity::text from inventory_movements where org_id=${f.org.orgId} and kind='assembly_consume'`));
    assert.equal(row.rows[0]?.quantity, "-2.2000");
  } },
  { name: "tracked backflush consumes oldest lots first", run: async (f) => {
    const order = await prepare(f, { backflushAt: "start", operationSeq: 10, quantityPer: "3", tracking: "lot" });
    const old = await stock(f, "2", "2", "LOT-OLD"), next = await stock(f, "2", "3", "LOT-NEXT");
    await run((tx) => startWorkOrderOperation(tx, f.org.orgId, f.actorId, order.id, order.operationId));
    const rows = await withBypassContext(async () => db.execute<{ lot_id: string; quantity: string }>(sql`select lot_id,quantity::text from inventory_movements where org_id=${f.org.orgId} and kind='assembly_consume'`));
    assert.equal(rows.rows.find((row) => row.lot_id === old)?.quantity, "-2.0000");
    assert.equal(rows.rows.find((row) => row.lot_id === next)?.quantity, "-1.0000");
  } },
  { name: "tracked backflush shortage names missing quantity and posts nothing", run: async (f) => {
    const order = await prepare(f, { backflushAt: "start", operationSeq: 10, quantityPer: "3", tracking: "lot" });
    const component = await componentLabel(f);
    await stock(f, "1", "2", "LOT-SHORT");
    await refuses(run((tx) => startWorkOrderOperation(tx, f.org.orgId, f.actorId, order.id, order.operationId)), "backflush_lot_shortage", `Component ${component} is short by 2.0000`);
    const count = await withBypassContext(async () => db.execute<{ n: number }>(sql`select count(*)::int as n from journal_entries where org_id=${f.org.orgId} and origin='manufacturing'`));
    assert.equal(count.rows[0]?.n, 0);
  } },
  { name: "negative inventory refuses with component shortfall", run: async (f) => {
    const order = await prepare(f); const component = await componentLabel(f);
    await refuses(issue(f, order.id, order.materialId), "material_shortage", `Component ${component} is short by 1.0000`);
  } },
  { name: "hold reason blocks material issue", run: async (f) => {
    const order = await prepare(f); await stock(f, "3", "2");
    await run((tx) => holdWorkOrder(tx, f.org.orgId, f.actorId, order.id, "Quality review"));
    await refuses(issue(f, order.id, order.materialId), "work_order_on_hold", "Quality review", "Resume the work order before issuing materials or completing an operation.");
  } },
  { name: "missing manufacturing WIP mapping refuses by role", run: async (f) => {
    const order = await prepare(f); await stock(f, "3", "2");
    await withBypassContext(() => db.execute(sql`update orgs set settings=settings#-'{controlAccounts,mfgWip}' where id=${f.org.orgId} returning id`));
    await refuses(issue(f, order.id, order.materialId), "mfg_wip_account_missing", "role mfgWip", "Map Manufacturing WIP under Setup → Company & Accounting → Control accounts.");
  } },
  { name: "operation tolerance refusal names percentage and remedy", run: async (f) => {
    const order = await prepare(f); await run((tx) => startWorkOrderOperation(tx, f.org.orgId, f.actorId, order.id, order.operationId));
    await refuses(run((tx) => completeWorkOrderOperation(tx, f.org.orgId, f.actorId, order.id, order.operationId, { doneQty: "1.02" })), "completion_tolerance_exceeded", "1% completion tolerance", "Revise the order quantity.");
  } },
  { name: "measure quality gate requires a reported measurement", run: async (f) => {
    const order = await prepare(f, { qualityGate: "measure" }); await run((tx) => startWorkOrderOperation(tx, f.org.orgId, f.actorId, order.id, order.operationId));
    await refuses(run((tx) => completeWorkOrderOperation(tx, f.org.orgId, f.actorId, order.id, order.operationId, { doneQty: "1" })), "measured_quantity_required", "measured quantity", "Enter measuredQty before completing this operation.");
  } },
  { name: "WIP GL balance ties to issued layer cost", run: async (f) => {
    const order = await prepare(f); await stock(f, "5", "3"); const result = await issue(f, order.id, order.materialId, "2");
    const row = await withBypassContext(async () => {
      const bookId = await primaryBookId(f.org.orgId, db);
      return db.execute<{ wip: string; layer_cost: string }>(sql`select
        (select coalesce(sum(line.amount),0)::text from journal_lines line
          join journal_entries entry on entry.org_id=line.org_id and entry.id=line.entry_id
          where line.org_id=${f.org.orgId} and line.account_id=${f.wipId} and entry.book_id=${bookId}
            and entry.status in ('posted','reversed')) as wip,
        (select coalesce(-sum(total_value),0)::text from inventory_movements
          where org_id=${f.org.orgId} and journal_entry_id=${result.entryId}) as layer_cost`);
    });
    assert.equal(row.rows[0]?.wip, row.rows[0]?.layer_cost); assert.equal(row.rows[0]?.wip, "6.0000");
  } },
];

cases.push(...(["finish", "start"] as const).map(trigger => ({name:`${trigger} backflush consumes attempted quantity once with normal loss`,run:async (f: Fixture)=>{
 await run(tx=>tx.execute(sql`update app_roles set permissions='["manufacturing.manage","items.post"]'::jsonb where org_id=${f.org.orgId} returning id`));
  const order=await prepare(f,{backflushAt:trigger,operationSeq:10,quantityPer:'2',orderQty:'10'});await stock(f,'20','3');
  await run(tx=>startWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,order.operationId));
  const reasonId=randomUUID();await run(tx=>tx.execute(sql`insert into mfg_scrap_reasons (id,org_id,code,name,classification) values (${reasonId},${f.org.orgId},${reasonId},'Normal loss','normal') returning id`));
  await run(tx=>recordNormalScrap(tx,f.org.orgId,f.actorId,null,order.id,randomUUID(),{operationId:order.operationId,quantity:'2',reasonId}));
  await run(tx=>completeWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,order.operationId,{doneQty:'8'}));
  await run(tx=>completeWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,order.operationId,{doneQty:'8'}));
  const result=await withBypassContext(async()=>(await db.execute<{quantity:string;entries:number}>(sql`select m.backflush_qty::text as quantity,(select count(*)::int from journal_entries where org_id=${f.org.orgId} and custom->>'operation_id'=${order.operationId} and custom->>'backflush_trigger'=${trigger}) as entries from mfg_wo_materials m where m.org_id=${f.org.orgId} and m.work_order_id=${order.id}`)).rows[0]!);
  assert.deepEqual(result,{quantity:'20.0000',entries:1});
}})));

test("manufacturing material execution case table", { skip: !DB }, async () => {
  for (const scenario of cases) {
    const fixture = await setup();
    let failure: unknown;
    try { await scenario.run(fixture); }
    catch (error) {
      failure = new Error(`${scenario.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      throw failure;
    } finally {
      try { await withBypassContext(() => dropScratchOrg(fixture.org.orgId)); }
      catch (cleanupError) {
        if (failure) throw new AggregateError([failure, cleanupError], "Manufacturing material scenario and cleanup both failed", { cause: failure });
        throw cleanupError;
      }
    }
  }
});
