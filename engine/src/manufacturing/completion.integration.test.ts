import { createHash } from "node:crypto";
import { canonicalJson } from "../platform/canonical-json.ts";
import { createSandbox,deleteSandbox } from "../sandbox/lifecycle.ts";
import {markEntryReversed} from "../journal/post-entry.ts";
import {proposeProductionLoss,applyProductionLoss} from "./loss-disposition.ts";
import { createDocument } from "../ledger/document-write.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { readSubcontractWorkspace,searchProductionServiceBills } from "./subcontract-workspace.ts";
import { saveInspectionPlan, loadInspection, resolveInspectionPlan } from "../inventory/inspections.ts";
import { createProductionSubcontract,shipSubcontractMaterial,recordSubcontractReturn,capitalizeSubcontractServiceBill,reverseSubcontractServiceCost,returnSubcontractComponents } from "./subcontracts.ts";
import { consumeSubcontractMaterials } from "./materials.ts";
import { getAvailableToPromise } from "../inventory/availability.ts";
import { issueInventory } from "../inventory/movements.ts";
import { reverseInventoryMovement } from "../inventory/reversal.ts";
import { setStockHold } from "../inventory/stock-holds.ts";
import { inventoryTrackingOptions } from "../inventory/tracking-options.ts";
import { createOperationInspection, recordQualityInspection, registerInspectionIdentifier } from "./quality-execution.ts";
import { disposeQualityInspection } from "./quality-disposition.ts";
import { readManufacturingInspection, listManufacturingInspections } from "./quality-workspace.ts";
import { saveBomPolicy,applyBomRevision,readBomPolicyVersion } from "../inventory/bom-policy.ts";
import { explodeBom } from "./bom-explode.ts";
import { approveFixtureRouting, createManufacturingOperator, createWorkOperator } from "../testing/manufacturing.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { withSimClock } from "../platform/clock.ts";
import { addCalendarDays,businessToday } from "../platform/business-date.ts";
import { createScratchOrg, dropScratchOrg, seedApprovalFlow, seedPayrollPerson, seedActiveEmployment, type ScratchOrg } from "../testing/fixtures.ts";
import { receiveInventory } from "../inventory/movements.ts";
import { getOnHand, getOnHandWith } from "../inventory/position.ts";
import { assertCostingPolicyChangeAllowed, lockItemInventoryProfile } from "../inventory/profile-policy.ts";
import { recordNormalScrap } from "./scrap.ts";
import { executeManufacturingReceipt, executeManufacturingIssue } from "./execution.ts";
import { readManufacturingRecord, listManufacturingRecords, searchManufacturingChoices, manufacturingOptions, manufacturingTracking } from "./workspace.ts";
import { ManufacturingError } from "./errors.ts";
import { upsertItemPolicy, assertManufacturingItemExists } from "./item-policies.ts";
import { runMrp } from "./mrp.ts";
import { activateRouting, proposeRoutingActivation, applyRoutingActivation, updateRouting, createRouting, createRoutingOperation, createNextRoutingVersion, updateRoutingOperation, getRouting } from "./routings.ts";
import { addWorkCenterRate, createWorkCenter, updateWorkCenter } from "./work-centers.ts";
import { createWorkOrder,getWorkOrder, updateDraftWorkOrder, holdWorkOrder, releaseWorkOrder, cancelWorkOrder, startWorkOrderOperation } from "./work-orders.ts";
import { completeWorkOrderOperation, issueMaterials } from "./materials.ts";
import { completeWorkOrder, markWorkOrderDone, reverseMaterialIssue, waiveMaterial } from "./completion.ts";
import { previewStandardRollup,proposeStandardRollup,applyStandardRollup } from "./standard-rollup.ts";
import { submitFinancialChange } from "../flows/financial-changes-adapter.ts";
import { decideGate } from "../flows/gates.ts";
import { traceManufacturingGenealogy } from "./genealogy.ts";
import { readOperatingSetupJourney } from "./setup-journey.ts";
import { ensureLot,ensureSerial } from "../inventory/tracking.ts";
import { applyProductionTimeCorrections } from "./conversion.ts";
import { lockSharedTimeAuthority } from "../projects/time-work-target.ts";
import { laborClearingReconciliation } from "../projects/labor-costing.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
type Fixture = { org: ScratchOrg; actorId: string; wipId: string; usageId: string; departmentId: string; postingDate: string };
type Case = { name: string; run: (f: Fixture) => Promise<void> };
function run<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> { return withBypassContext(() => db.transaction(work)); }
async function setup(): Promise<Fixture> {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createManufacturingOperator(org.orgId, "Shop lead"));
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
  await approveFixtureRouting(f.org.orgId, f.actorId, String(routing.id));
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
async function conversionOrder(f: Fixture, produced: string, laborTimeSource: "operation" | "approved_time" = "operation") {
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
    sequence: 10, name: "Assemble", workCenterId: String(center.id), setupMinutes: "0", runMinutesPerUnit: "6",laborTimeSource,
  }));
  await approveFixtureRouting(f.org.orgId, f.actorId, String(routing.id));
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
  {name:"zero-output loss approves actual consumed conversion, expenses remaining WIP and preserves stock and terminal evidence",run:async f=>{
    await inspectionPlan(f,f.org.items.assembly,'operation');
    const order=await conversionOrder(f,f.org.items.assembly),reasonId=randomUUID();
    await run(tx=>tx.execute(sql`insert into mfg_scrap_reasons(id,org_id,code,name,classification,is_active) values(${reasonId},${f.org.orgId},${reasonId},'Abnormal fabrication loss','abnormal',true) returning id`));
    const input={operationId:order.operation,reasonId,quantity:'6',reason:'Discard damaged work; cancel the unstarted remainder',requestKey:randomUUID(),times:[{operationId:order.operation,attemptedQty:'6',actualSetupMinutes:'0',actualRunMinutes:'12',actualLaborMinutes:'12'}]};
    const before=await counts(f),beforeScrap=await scrapState(f,order.id);
    await assert.rejects(run(async tx=>{await proposeProductionLoss(tx,f.org.orgId,f.actorId,order.id,input);throw new Error('rollback proposed loss')}),/rollback proposed loss/);
    assert.deepEqual(await counts(f),before);assert.deepEqual(await scrapState(f,order.id),beforeScrap);
    assert.equal((await run(tx=>tx.execute<{status:string}>(sql`select status from mfg_work_orders where org_id=${f.org.orgId} and id=${order.id}`))).rows[0]?.status,'in_progress');
    const proposal=await run(tx=>proposeProductionLoss(tx,f.org.orgId,f.actorId,order.id,input));
    assert.deepEqual(await run(tx=>proposeProductionLoss(tx,f.org.orgId,f.actorId,order.id,input)),proposal);
    await assert.rejects(withBypassContext(()=>applyProductionLoss(f.org.orgId,f.actorId,proposal.changeId)),/approval policy/);
    assert.deepEqual(await counts(f),before);assert.equal(await wip(f,order.number),'60.0000');
    const approver=await withBypassContext(()=>createWorkOperator(f.org.orgId,"Independent loss approver",["manufacturing.manage"]));
    await withBypassContext(()=>seedApprovalFlow(f.org.orgId,{subjectKind:'financial_change',assignees:[{type:'user',userId:approver}],mode:'any',preventSelfApproval:true}));
    await withBypassContext(()=>submitFinancialChange(f.org.orgId,proposal.changeId,f.actorId));
    const gates=(await run(tx=>tx.execute<{id:string}>(sql`select id from flow_gates where org_id=${f.org.orgId} and subject_kind='financial_change' and subject_id=${proposal.changeId} and status='pending'`))).rows;
    assert.equal(gates.length,1);await withBypassContext(()=>decideGate({gateId:gates[0]!.id,userId:approver,decision:'approved'}));
    await run(async tx=>addWorkCenterRate(tx,f.org.orgId,f.actorId,(await tx.execute<{center:string}>(sql`select work_center_id as center from mfg_wo_operations where org_id=${f.org.orgId} and id=${order.operation}`)).rows[0]!.center,{machineRatePerHour:'13',effectiveFrom:f.postingDate}));
    const stale=await counts(f);await assert.rejects(withBypassContext(()=>applyProductionLoss(f.org.orgId,f.actorId,proposal.changeId)),/changed/);assert.deepEqual(await counts(f),stale);
    // A new proposal retains the changed effective rate and obtains its own decision.
    const replacement=await run(tx=>proposeProductionLoss(tx,f.org.orgId,f.actorId,order.id,{...input,requestKey:randomUUID()}));
    await withBypassContext(()=>submitFinancialChange(f.org.orgId,replacement.changeId,f.actorId));
    const replacementGate=(await run(tx=>tx.execute<{id:string}>(sql`select id from flow_gates where org_id=${f.org.orgId} and subject_id=${replacement.changeId} and status='pending'`))).rows[0]!;
    await withBypassContext(()=>decideGate({gateId:replacementGate.id,userId:approver,decision:'approved'}));
    const result=await withBypassContext(()=>applyProductionLoss(f.org.orgId,f.actorId,replacement.changeId));
    assert.equal(result.status,'cancelled');assert.equal(result.quantity,'6');assert.equal(result.value,'69.6000');assert.equal(await wip(f,order.number),'0.0000');
    assert.equal((await counts(f)).movements,before.movements,'loss does not recreate components or invent finished inventory');
    const state=(await run(tx=>tx.execute<{status:string;good:string;scrap:string;loss:string}>(sql`select status,quantity_completed::text as good,quantity_scrapped::text as scrap,loss_change_id as loss from mfg_work_orders where org_id=${f.org.orgId} and id=${order.id}`))).rows[0]!;
    assert.deepEqual(state,{status:'cancelled',good:'0.0000',scrap:'6.0000',loss:replacement.changeId});
    const after=await counts(f);assert.deepEqual(await withBypassContext(()=>applyProductionLoss(f.org.orgId,f.actorId,replacement.changeId)),result);assert.deepEqual(await counts(f),after);
    const inspection=(await run(tx=>tx.execute<{id:string}>(sql`select id from inventory_inspections where org_id=${f.org.orgId} and operation_id=${order.operation}`))).rows[0]!;
    assert.equal((await run(tx=>loadInspection(tx,f.org.orgId,inspection.id))).sourceActive,false);
    await assert.rejects(run(tx=>markEntryReversed(tx,{orgId:f.org.orgId,actorId:f.actorId,entryId:String(result.entryId)})),/adjusting journal/);
    await assert.rejects(run(tx=>tx.execute(sql`update mfg_work_orders set status='released',cancel_reason=null where org_id=${f.org.orgId} and id=${order.id} returning id`)),/terminal loss/);
    await assert.rejects(run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,order.id,{quantity:'1'})));
    const roles=(await run(tx=>tx.execute<{id:string;permissions:unknown}>(sql`select id,permissions from app_roles where org_id=${f.org.orgId} and id in(select role_id from role_assignments where org_id=${f.org.orgId} and user_id=${f.actorId})`))).rows;
    await run(tx=>tx.execute(sql`update app_roles set permissions='["manufacturing.read"]'::jsonb where org_id=${f.org.orgId} and id in(select role_id from role_assignments where org_id=${f.org.orgId} and user_id=${f.actorId}) returning id`));
    await assert.rejects(withBypassContext(()=>applyProductionLoss(f.org.orgId,f.actorId,replacement.changeId)));
    await assert.rejects(run(tx=>proposeProductionLoss(tx,f.org.orgId,f.actorId,order.id,input)));assert.deepEqual(await counts(f),after);
    for(const role of roles)await run(tx=>tx.execute(sql`update app_roles set permissions=${JSON.stringify(role.permissions)}::jsonb where org_id=${f.org.orgId} and id=${role.id} returning id`));
    await assert.rejects(withBypassContext(()=>applyProductionLoss(f.org.orgId,randomUUID(),replacement.changeId)));assert.deepEqual(await counts(f),after);
  }},
  {name:"zero-valued loss retains an approved quantity disposition without a zero-value journal or fake receipt",run:async f=>{
    const order=await prepare(f,{quantity:'10'}),operation=(await run(tx=>tx.execute<{id:string}>(sql`select id from mfg_wo_operations where org_id=${f.org.orgId} and work_order_id=${order.id}`))).rows[0]!,reasonId=randomUUID();
    await run(tx=>tx.execute(sql`insert into mfg_scrap_reasons(id,org_id,code,name,classification,is_active) values(${reasonId},${f.org.orgId},${reasonId},'Unvalued failed trial','abnormal',true) returning id`));
    const input={operationId:operation.id,reasonId,quantity:'2',reason:'Discard two unvalued trial units and cancel eight unstarted units',requestKey:randomUUID(),times:[]};
    const proposal=await run(tx=>proposeProductionLoss(tx,f.org.orgId,f.actorId,order.id,input));
    const approver=await withBypassContext(()=>createWorkOperator(f.org.orgId,"Loss decision",["manufacturing.manage"]));
    await withBypassContext(()=>seedApprovalFlow(f.org.orgId,{subjectKind:'financial_change',assignees:[{type:'user',userId:approver}],mode:'any',preventSelfApproval:true}));
    await withBypassContext(()=>submitFinancialChange(f.org.orgId,proposal.changeId,f.actorId));
    const gate=(await run(tx=>tx.execute<{id:string}>(sql`select id from flow_gates where org_id=${f.org.orgId} and subject_id=${proposal.changeId} and status='pending'`))).rows[0]!;
    await withBypassContext(()=>decideGate({gateId:gate.id,userId:approver,decision:'approved'}));
    const before=await counts(f),result=await withBypassContext(()=>applyProductionLoss(f.org.orgId,f.actorId,proposal.changeId));
    assert.equal(result.entryId,null);assert.equal(result.value,'0.0000');assert.equal(result.quantity,'2');assert.deepEqual(await counts(f),before);assert.equal(await wip(f,order.number),'0.0000');
    assert.deepEqual((await run(tx=>tx.execute<{value:string;unit:string;approval:boolean}>(sql`select frozen_value::text as value,frozen_unit_cost::text as unit,approval_required as approval from mfg_scrap_events where org_id=${f.org.orgId} and disposition_change_id=${proposal.changeId}`))).rows,[{value:'0.0000',unit:'0.0000',approval:true}]);
  }},
  {name:"BOM approval retains historical effectivity and released material snapshots, replays once and refuses revoked authority",run:async f=>{
    const order=await prepare(f);
    for(const mutation of [sql`update bom_components set quantity_per='99' where org_id=${f.org.orgId} and assembly_item_id=${f.org.items.assembly}`,sql`delete from bom_components where org_id=${f.org.orgId} and assembly_item_id=${f.org.items.assembly}`,sql`insert into bom_components(org_id,assembly_item_id,component_item_id,quantity_per,sort_order) values(${f.org.orgId},${f.org.items.assembly},${f.org.items.standard},'1',9)`])await assert.rejects(run(tx=>tx.execute(mutation)),/approved revision/);
    await assert.rejects(run(async tx=>{await tx.execute(sql`select set_config('openbooks.production_bom_changes',${JSON.stringify({[f.org.orgId+':'+f.org.items.assembly]:randomUUID()})},true)`);await tx.execute(sql`delete from bom_components where org_id=${f.org.orgId} and assembly_item_id=${f.org.items.assembly}`)}),/approval decision/);
    const retained=(await run(tx=>tx.execute<{revision:string;quantity:string}>(sql`select work.bom_revision as revision,material.required_qty::text as quantity from mfg_work_orders work join mfg_wo_materials material on material.org_id=work.org_id and material.work_order_id=work.id where work.org_id=${f.org.orgId} and work.id=${order.id}`))).rows;
    const tomorrow=addCalendarDays(f.postingDate,1);
    const version=await run(tx=>readBomPolicyVersion(tx,f.org.orgId,f.org.items.assembly));
    const line={componentItemId:f.org.items.component,quantityPer:"2",effectiveFrom:null,effectiveTo:tomorrow,operationSeq:null,scrapPct:null,isByproduct:false};
    const input={assemblyItemId:f.org.items.assembly,expectedVersion:version,reason:"Approve the next material requirement",subsidiaryId:f.org.subsidiaryId,requestKey:randomUUID(),components:[line,{...line,quantityPer:"3",effectiveFrom:tomorrow,effectiveTo:null}]};
    await assert.rejects(run(tx=>saveBomPolicy(tx,f.org.orgId,f.actorId,{...input,components:[{...line,quantityPer:"3",effectiveTo:null}]})),/Retain earlier/);
    const proposal=await run(tx=>saveBomPolicy(tx,f.org.orgId,f.actorId,input));
    assert.ok("changeId" in proposal);if(!("changeId" in proposal)) throw new Error("BOM proposal was not created");
    const replay=await run(tx=>saveBomPolicy(tx,f.org.orgId,f.actorId,input));assert.ok("changeId" in replay);assert.equal("changeId" in replay ? replay.changeId : null,proposal.changeId);
    const before=await counts(f);
    await assert.rejects(withBypassContext(()=>applyBomRevision(f.org.orgId,f.actorId,proposal.changeId)),/approval policy/);
    assert.equal(await run(tx=>readBomPolicyVersion(tx,f.org.orgId,f.org.items.assembly)),version);
    const approver=await withBypassContext(()=>createWorkOperator(f.org.orgId,"Recipe decision",["manufacturing.manage","admin.setup.manage"]));
    await withBypassContext(()=>seedApprovalFlow(f.org.orgId,{subjectKind:"financial_change",assignees:[{type:"user",userId:approver}],mode:"any",preventSelfApproval:true}));
    await withBypassContext(()=>submitFinancialChange(f.org.orgId,proposal.changeId,f.actorId));
    const gate=(await run(tx=>tx.execute<{id:string}>(sql`select id from flow_gates where org_id=${f.org.orgId} and subject_id=${proposal.changeId} and subject_kind='financial_change' and status='pending'`))).rows;
    assert.equal(gate.length,1);await withBypassContext(()=>decideGate({gateId:gate[0]!.id,userId:approver,decision:"approved"}));
    const result=await withBypassContext(()=>applyBomRevision(f.org.orgId,f.actorId,proposal.changeId));
    assert.equal(result.componentCount,2);
    assert.deepEqual(await withBypassContext(()=>applyBomRevision(f.org.orgId,f.actorId,proposal.changeId)),result);
    assert.equal((await run(tx=>explodeBom(tx,f.org.orgId,f.org.items.assembly,"1",f.postingDate))).components[0]?.requiredQuantity,"2.0000");
    assert.equal((await run(tx=>explodeBom(tx,f.org.orgId,f.org.items.assembly,"1",tomorrow))).components[0]?.requiredQuantity,"3.0000");
    assert.deepEqual((await run(tx=>tx.execute<{revision:string;quantity:string}>(sql`select work.bom_revision as revision,material.required_qty::text as quantity from mfg_work_orders work join mfg_wo_materials material on material.org_id=work.org_id and material.work_order_id=work.id where work.org_id=${f.org.orgId} and work.id=${order.id}`))).rows,retained);
    assert.deepEqual(await counts(f),before);
    const appliedVersion=await run(tx=>readBomPolicyVersion(tx,f.org.orgId,f.org.items.assembly));
    await run(tx=>tx.execute(sql`update app_roles set permissions='["manufacturing.read"]'::jsonb where org_id=${f.org.orgId} and id in(select role_id from role_assignments where org_id=${f.org.orgId} and user_id=${f.actorId}) returning id`));
    await assert.rejects(withBypassContext(()=>applyBomRevision(f.org.orgId,f.actorId,proposal.changeId)));
    await assert.rejects(run(tx=>saveBomPolicy(tx,f.org.orgId,f.actorId,input)));
    await assert.rejects(run(tx=>saveBomPolicy(tx,f.org.orgId,randomUUID(),input)));
    assert.equal(await run(tx=>readBomPolicyVersion(tx,f.org.orgId,f.org.items.assembly)),appliedVersion);
    assert.deepEqual(await counts(f),before);
  }},
  {name:"routing approval freezes the draft and effective windows, retains released work and rechecks authority before replay",run:async f=>{
    const order=await prepare(f);
    const initial=(await run(tx=>tx.execute<{routingId:string;revision:number;bom:string}>(sql`select routing_id as "routingId",routing_version as revision,bom_revision as bom from mfg_work_orders where org_id=${f.org.orgId} and id=${order.id}`))).rows[0]!;
    const next=await run(tx=>createNextRoutingVersion(tx,f.org.orgId,f.actorId,initial.routingId));
    await run(tx=>updateRouting(tx,f.org.orgId,f.actorId,String(next.id),{effectiveFrom:f.postingDate,name:"Revised assembly"}));
    await refuse(run(tx=>activateRouting(tx,f.org.orgId,f.actorId,String(next.id))),"routing_approval_required","approval");
    const approver=await withBypassContext(()=>createWorkOperator(f.org.orgId,"Revision decision",["manufacturing.manage"]));
    await withBypassContext(()=>seedApprovalFlow(f.org.orgId,{subjectKind:"financial_change",assignees:[{type:"user",userId:approver}],mode:"any",preventSelfApproval:true}));
    const propose=()=>run(tx=>proposeRoutingActivation(tx,f.org.orgId,f.actorId,String(next.id),{subsidiaryId:f.org.subsidiaryId,reason:"Improve the assembly process",idempotencyKey:randomUUID()}));
    const approve=async(changeId:string)=>{
      await withBypassContext(()=>submitFinancialChange(f.org.orgId,changeId,f.actorId));
      const gate=(await run(tx=>tx.execute<{id:string}>(sql`select id from flow_gates where org_id=${f.org.orgId} and subject_id=${changeId} and subject_kind='financial_change' and status='pending'`))).rows[0]!;
      await withBypassContext(()=>decideGate({gateId:gate.id,userId:approver,decision:"approved"}));
    };
    const stale=await propose();await approve(stale.changeId);
    await run(tx=>updateRouting(tx,f.org.orgId,f.actorId,String(next.id),{name:"Reviewed process update"}));
    const before=await counts(f);
    await refuse(withBypassContext(()=>applyRoutingActivation(f.org.orgId,f.actorId,stale.changeId)),"routing_approval_stale","changed");
    assert.deepEqual(await counts(f),before);
    const proposal=await propose();await approve(proposal.changeId);
    const active=await withBypassContext(()=>applyRoutingActivation(f.org.orgId,f.actorId,proposal.changeId));
    assert.equal(active.status,"active");assert.equal(active.version,2);
    assert.deepEqual(await withBypassContext(()=>applyRoutingActivation(f.org.orgId,f.actorId,proposal.changeId)),active);
    const retained=(await run(tx=>tx.execute<{routingId:string;revision:number;bom:string}>(sql`select routing_id as "routingId",routing_version as revision,bom_revision as bom from mfg_work_orders where org_id=${f.org.orgId} and id=${order.id}`))).rows[0]!;
    assert.deepEqual(retained,initial);
    const prior=(await run(tx=>tx.execute<{end:string}>(sql`select effective_to::text as "end" from mfg_routings where org_id=${f.org.orgId} and id=${initial.routingId}`))).rows[0]!;
    assert.equal(prior.end,f.postingDate);
    await assert.rejects(run(tx=>tx.execute(sql`update mfg_work_orders set routing_version=2 where org_id=${f.org.orgId} and id=${order.id}`)),/Released work retains/);
    await assert.rejects(run(tx=>tx.execute(sql`update mfg_routing_operations set name='Unapproved rewrite' where org_id=${f.org.orgId} and routing_id=${String(next.id)}`)),/immutable/);
    await run(tx=>tx.execute(sql`update app_roles set permissions='["manufacturing.read"]'::jsonb where org_id=${f.org.orgId} and id in(select role_id from role_assignments where org_id=${f.org.orgId} and user_id=${f.actorId}) returning id`));
    await assert.rejects(withBypassContext(()=>applyRoutingActivation(f.org.orgId,f.actorId,proposal.changeId)));
    assert.deepEqual(await counts(f),before);
  }},
  {name:"setup is derived per work family and current product, without production prerequisites on simple projects",run:async f=>{
    await run(tx=>tx.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"manufacturing":false}'::jsonb) where id=${f.org.orgId} returning id`));
    const job=await run(tx=>readOperatingSetupJourney(tx,f.org.orgId,f.actorId,{family:"project",selection:"shop_jobs"}));
    assert.equal(job.readyFor,"project");assert.deepEqual(job.findings,[]);
    assert.ok(job.nextHref?.startsWith("/projects?projectNew=1"));
    await assert.rejects(run(tx=>readOperatingSetupJourney(tx,f.org.orgId,f.actorId,{family:"production",selection:"discrete_production"})));
    await run(tx=>tx.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"manufacturing":true}'::jsonb) where id=${f.org.orgId} returning id`));
    const choose=await run(tx=>readOperatingSetupJourney(tx,f.org.orgId,f.actorId,{family:"production",selection:"discrete_production"}));
    assert.deepEqual(choose.findings.map(f=>f.key),["item","entity"]);assert.equal(choose.nextHref,null);
    const missing=await run(tx=>readOperatingSetupJourney(tx,f.org.orgId,f.actorId,{family:"production",selection:"discrete_production",itemId:f.org.items.assembly,subsidiaryId:f.org.subsidiaryId}));
    assert.equal(missing.findings.find(f=>f.key==="routing")?.status,"missing");assert.equal(missing.readyFor,"draft");
    assert.equal(new URL(missing.nextHref!,"http://localhost").searchParams.get("producedItemId"),f.org.items.assembly);assert.equal(new URL(missing.nextHref!,"http://localhost").searchParams.get("subsidiaryId"),f.org.subsidiaryId);
    await route(f,f.org.items.assembly);
    const configured=await run(tx=>readOperatingSetupJourney(tx,f.org.orgId,f.actorId,{family:"production",selection:"discrete_production",itemId:f.org.items.assembly,subsidiaryId:f.org.subsidiaryId,quantity:'10'}));
    assert.equal(configured.readyFor,"release");assert.ok(configured.findings.every(f=>f.status==="ready"));
    assert.equal(new URL(configured.nextHref!,"http://localhost").searchParams.get('quantityOrdered'),'10');
    await refuse(run(tx=>readOperatingSetupJourney(tx,f.org.orgId,f.actorId,{family:'production',selection:'batch_process',itemId:f.org.items.assembly,subsidiaryId:f.org.subsidiaryId,quantity:'0'})),'setup_quantity_required','positive');
    await run(tx=>tx.execute(sql`update labor_cost_rates set is_active=false where org_id=${f.org.orgId} returning id`));
    const stale=await run(tx=>readOperatingSetupJourney(tx,f.org.orgId,f.actorId,{family:"production",selection:"discrete_production",itemId:f.org.items.assembly,subsidiaryId:f.org.subsidiaryId}));
    assert.equal(stale.findings.find(f=>f.key==="costing")?.code,"standard_labor_rate_missing");assert.equal(stale.readyFor,"draft");
    await assert.rejects(run(tx=>readOperatingSetupJourney(tx,f.org.orgId,randomUUID(),{family:"project",selection:"shop_jobs"})));
  }},
  {name:"genealogy follows native lots through split receipts and later orders, excludes reversed output and checks live read authority",run:async f=>{
    await run(tx=>tx.execute(sql`update item_inventory_profiles set tracking='lot' where org_id=${f.org.orgId} and item_id in(${f.org.items.component},${f.org.items.assembly},${f.org.items.standard}) returning item_id`));
    const raw=await withBypassContext(()=>ensureLot(f.org.orgId,f.org.items.component,"RAW-TRACE",null,f.actorId));
    await withBypassContext(()=>receiveInventory(f.org.orgId,f.actorId,{itemId:f.org.items.component,stockLocationId:f.org.stockLocationId,quantity:"4",unitCost:"3",subsidiaryId:f.org.subsidiaryId,offsetAccountId:f.org.accounts.clearing,date:f.org.date,lotId:raw}));
    const first=await prepare(f,{quantity:"2"});
    await run(tx=>issueMaterials(tx,f.org.orgId,f.actorId,first.id,[{materialId:first.materials[0]!.id,quantity:"4",lotId:raw}]));
    for (const lotNumber of ["FIRST-A","FIRST-B"]) await run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,first.id,{quantity:"1",lots:[{quantity:"1",lotNumber}]}));
    const firstLot=(await run(tx=>tx.execute<{id:string}>(sql`select id from lots where org_id=${f.org.orgId} and item_id=${f.org.items.assembly} and lot_number='FIRST-A'`))).rows[0]!.id;
    await run(tx=>tx.execute(sql`insert into bom_components(org_id,assembly_item_id,component_item_id,quantity_per,sort_order,is_byproduct) values(${f.org.orgId},${f.org.items.standard},${f.org.items.assembly},'1',0,false) returning id`));
    await route(f,f.org.items.standard);
    const second=await run(tx=>createWorkOrder(tx,f.org.orgId,f.actorId,{producedItemId:f.org.items.standard,quantityOrdered:"1",subsidiaryId:f.org.subsidiaryId,issueLocationId:f.org.stockLocationId2,receiptLocationId:f.org.stockLocationId,plannedStart:f.org.date}));
    await run(tx=>releaseWorkOrder(tx,f.org.orgId,f.actorId,second.id));
    const material=(await run(tx=>tx.execute<{id:string}>(sql`select id from mfg_wo_materials where org_id=${f.org.orgId} and work_order_id=${second.id}`))).rows[0]!.id;
    await run(tx=>issueMaterials(tx,f.org.orgId,f.actorId,second.id,[{materialId:material,quantity:"1",lotId:firstLot}]));
    await run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,second.id,{quantity:"1",lots:[{quantity:"1",lotNumber:"FINAL-TRACE"}]}));
    const output=(await run(tx=>tx.execute<{id:string;movementId:string}>(sql`select lot.id,movement.id as "movementId" from lots lot join inventory_movements movement on movement.org_id=lot.org_id and movement.lot_id=lot.id and movement.kind='assembly_build' where lot.org_id=${f.org.orgId} and lot.item_id=${f.org.items.standard} and lot.lot_number='FINAL-TRACE'`))).rows[0]!;
    const forward=await run(tx=>traceManufacturingGenealogy(tx,f.org.orgId,f.actorId,{kind:"lot",id:raw,direction:"forward"}));
    assert.equal(forward.association,"receipt_evidence");assert.ok(forward.edges.every(edge=>edge.allocationBasis==='proportional'));assert.equal(forward.truncated,false);assert.equal(forward.edges.length,3);
    assert.equal(forward.edges.filter(e=>e.orderId===first.id).length,2);assert.equal(forward.edges.find(e=>e.orderId===second.id)?.depth,2);
    const backward=await run(tx=>traceManufacturingGenealogy(tx,f.org.orgId,f.actorId,{kind:"lot",id:output.id,direction:"backward"}));
    assert.equal(backward.edges.length,2);assert.ok(backward.edges.some(e=>e.componentLotId===raw));
    await run(tx=>holdWorkOrder(tx,f.org.orgId,f.actorId,second.id,"Review finished output"));
    await run(()=>reverseMaterialIssue(f.org.orgId,f.actorId,{movementId:output.movementId,reversalDate:f.postingDate,reason:"Reverse incorrect finished receipt"}));
    const after=await run(tx=>traceManufacturingGenealogy(tx,f.org.orgId,f.actorId,{kind:"lot",id:raw,direction:"forward"}));
    assert.equal(after.edges.length,2);assert.ok(after.edges.every(e=>e.orderId===first.id));
    const allowed=new Set([f.org.subsidiaryId]);
    assert.equal((await run(tx=>traceManufacturingGenealogy(tx,f.org.orgId,f.actorId,{kind:'lot',id:raw,direction:'forward'},allowed))).edges.length,2);
    const otherEntity=randomUUID(),otherLocation=randomUUID(),otherStock=randomUUID();
    await run(async tx=>{
      assert.equal((await tx.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active) values(${otherEntity},${f.org.orgId},${f.org.subsidiaryId},'Independent trace owner','CAD','CA',true) returning id`)).rows.length,1);
      assert.equal((await tx.execute(sql`insert into locations(id,org_id,name,subsidiary_id,is_active) values(${otherLocation},${f.org.orgId},'Independent trace stock',${otherEntity},true) returning id`)).rows.length,1);
      assert.equal((await tx.execute(sql`insert into stock_locations(id,org_id,location_id,code,kind,is_active) values(${otherStock},${f.org.orgId},${otherLocation},'OTHER-TRACE','warehouse',true) returning id`)).rows.length,1);
    });
    await withBypassContext(()=>receiveInventory(f.org.orgId,f.actorId,{itemId:f.org.items.component,stockLocationId:otherStock,quantity:'1',unitCost:'3',subsidiaryId:otherEntity,offsetAccountId:f.org.accounts.clearing,date:f.org.date,lotId:raw}));
    const ownershipState=await counts(f);
    await assert.rejects(run(tx=>traceManufacturingGenealogy(tx,f.org.orgId,f.actorId,{kind:'lot',id:raw,direction:'forward'},allowed)),/not found/i);
    assert.deepEqual(await counts(f),ownershipState,'a trace seed cannot reveal a shared identifier whose current native owners are outside its authorized entities');
    assert.equal((await run(tx=>traceManufacturingGenealogy(tx,f.org.orgId,f.actorId,{kind:'lot',id:raw,direction:'forward'}))).edges.length,2,'organization-wide authority retains the trace without inventing edges for ordinary receipts');
    const before=await counts(f);
    await assert.rejects(run(tx=>traceManufacturingGenealogy(tx,f.org.orgId,randomUUID(),{kind:"lot",id:raw,direction:"forward"})));
    await run(tx=>tx.execute(sql`update app_roles set permissions='["manufacturing.read"]'::jsonb where org_id=${f.org.orgId} and id in(select role_id from role_assignments where org_id=${f.org.orgId} and user_id=${f.actorId}) returning id`));
    await assert.rejects(run(tx=>traceManufacturingGenealogy(tx,f.org.orgId,f.actorId,{kind:"lot",id:raw,direction:"forward"})));
    assert.deepEqual(await counts(f),before);
  }},
  { name: "standard roll-up requires live authority and unchanged approved sources, revalues stock and preserves released standards", run: async f => {
    const order=await conversionOrder(f,f.org.items.standard);
    await run(async tx=>{
      await tx.execute(sql`update item_inventory_profiles set standard_cost='3' where org_id=${f.org.orgId} and item_id=${f.org.items.component} returning item_id`);
      await tx.execute(sql`update item_inventory_profiles set variance_account_id=${f.usageId} where org_id=${f.org.orgId} and item_id=${f.org.items.standard} returning item_id`);
    });
    await stock(f,f.org.items.standard,"2","9.9");
    const basis={itemId:f.org.items.standard,subsidiaryId:f.org.subsidiaryId,onDate:f.postingDate,batchQuantity:"10"};
    const preview=await run(tx=>previewStandardRollup(tx,f.org.orgId,f.actorId,basis));
    assert.equal(preview.material,"60.0000");assert.equal(preview.labor,"30.0000");assert.equal(preview.overhead,"17.0000");assert.equal(preview.standardCost,"10.7000");
    const input={...basis,reason:"Review standard material and cell conversion costs",idempotencyKey:randomUUID(),expectedDigest:preview.digest};
    const proposal=await run(tx=>proposeStandardRollup(tx,f.org.orgId,f.actorId,input));
    assert.equal((await run(tx=>proposeStandardRollup(tx,f.org.orgId,f.actorId,input))).changeId,proposal.changeId);
    const before=await counts(f);
    await refuse(withBypassContext(()=>applyStandardRollup(f.org.orgId,f.actorId,proposal.changeId)),"rollup_approval_required","approval policy");
    assert.deepEqual(await counts(f),before);
    const approver=await withBypassContext(()=>createWorkOperator(f.org.orgId,"Cost approver",["manufacturing.manage","items.manage"]));
    await withBypassContext(()=>seedApprovalFlow(f.org.orgId,{subjectKind:"financial_change",assignees:[{type:"user",userId:approver}],mode:"any",preventSelfApproval:true}));
    await withBypassContext(()=>submitFinancialChange(f.org.orgId,proposal.changeId,f.actorId));
    const gate=await run(async tx=>(await tx.execute<{id:string}>(sql`select id from flow_gates where org_id=${f.org.orgId} and subject_kind='financial_change' and subject_id=${proposal.changeId} and status='pending'`)).rows[0]!);
    await withBypassContext(()=>decideGate({gateId:gate.id,userId:approver,decision:"approved"}));
    await run(tx=>tx.execute(sql`update item_inventory_profiles set standard_cost='3.1' where org_id=${f.org.orgId} and item_id=${f.org.items.component} returning item_id`));
    await refuse(withBypassContext(()=>applyStandardRollup(f.org.orgId,f.actorId,proposal.changeId)),"rollup_sources_changed","changed");
    assert.deepEqual(await counts(f),before);
    await run(tx=>tx.execute(sql`update item_inventory_profiles set standard_cost='3' where org_id=${f.org.orgId} and item_id=${f.org.items.component} returning item_id`));
    const result=await withBypassContext(()=>applyStandardRollup(f.org.orgId,f.actorId,proposal.changeId));
    assert.equal(result?.standardCost,"10.7000");
    const applied=await counts(f);
    assert.deepEqual(await withBypassContext(()=>applyStandardRollup(f.org.orgId,f.actorId,proposal.changeId)),result);
    assert.deepEqual(await counts(f),applied);
    const retained=await run(async tx=>(await tx.execute<{standard:string}>(sql`select standard_cost_snapshot::text as standard from mfg_work_orders where org_id=${f.org.orgId} and id=${order.id}`)).rows[0]!);
    assert.equal(retained.standard,"9.9000");
    await run(tx=>tx.execute(sql`update app_roles set permissions='["manufacturing.read","items.read"]'::jsonb where org_id=${f.org.orgId} and id in(select role_id from role_assignments where org_id=${f.org.orgId} and user_id=${f.actorId}) returning id`));
    await assert.rejects(withBypassContext(()=>applyStandardRollup(f.org.orgId,f.actorId,proposal.changeId)));
    assert.deepEqual(await counts(f),applied);
  } },

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
    const clearing = await withBypassContext(() => laborClearingReconciliation(f.org.orgId, f.postingDate, f.postingDate, f.org.subsidiaryId));
    assert.equal(clearing?.standardPosted, "30.0000", "native conversion credits join the standard labor pool");
    assert.equal(clearing?.payrollPosted, "0", "manufacturing absorption is not payroll actual cost");
    const result = await run((tx) => completeWorkOrder(tx, f.org.orgId, f.actorId, wo.id, { quantity: "10" }));
    assert.equal(result.relievedWip, "107.0000"); // 60 material + 47 conversion
    assert.equal(result.value, "107.0000");
    assert.equal(await wip(f, wo.number), "0.0000");
    assert.equal((await getOnHand(f.org.orgId, f.org.items.assembly, f.org.stockLocationId2)).value, "107.0000");
  } },
  { name: "released primary output refuses actual-cost policy changes and retains its frozen standard after restoration", run: async (f) => {
    const itemId=f.org.items.standard;
    const order=await conversionOrder(f,itemId);
    await run(tx=>completeWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,order.operation,{doneQty:'10'}));
    const frozen=(await run(tx=>getWorkOrder(tx,f.org.orgId,order.id)))!.standardCostSnapshot;
    assert.equal(frozen,'2.0000');
    await run(async tx=>{
      const current=await lockItemInventoryProfile(tx,f.org.orgId,itemId);assert(current);
      const assessment=await assertCostingPolicyChangeAllowed(tx,f.org.orgId,itemId,current,{costingMethod:'fifo',tracking:'none'},null);
      assert.deepEqual(assessment,{changed:true,historyExisted:false},'released work alone is not posted stock history');
      const changed=await tx.execute(sql`update item_inventory_profiles set costing_method='fifo',updated_at=now(),updated_by=${f.actorId} where org_id=${f.org.orgId} and item_id=${itemId} returning id`);
      assert.equal(changed.rows.length,1);
    });
    const before=await counts(f),balance=await wip(f,order.number);
    await refuse(run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,order.id,{quantity:'10'})),'finished_good_costing_method_changed','released standard snapshot','Restore standard costing');
    assert.deepEqual(await counts(f),before);assert.equal(await wip(f,order.number),balance);
    assert.equal((await run(tx=>getWorkOrder(tx,f.org.orgId,order.id)))!.quantityCompleted,'0.0000');
    await run(async tx=>{
      const current=await lockItemInventoryProfile(tx,f.org.orgId,itemId);assert(current);
      await assertCostingPolicyChangeAllowed(tx,f.org.orgId,itemId,current,{costingMethod:'standard',tracking:'none'},null);
      const changed=await tx.execute(sql`update item_inventory_profiles set costing_method='standard',standard_cost='9',updated_at=now(),updated_by=${f.actorId} where org_id=${f.org.orgId} and item_id=${itemId} returning id`);
      assert.equal(changed.rows.length,1);
    });
    const received=await run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,order.id,{quantity:'10'}));
    assert.equal(received.value,'20.0000','the later item standard does not replace the released two-per-unit snapshot');
    assert.equal(received.relievedWip,balance);assert.equal(await wip(f,order.number),'0.0000');
    assert.equal((await run(tx=>getWorkOrder(tx,f.org.orgId,order.id)))!.standardCostSnapshot,frozen);
    assert.equal((await withBypassContext(()=>getOnHandWith(db,f.org.orgId,itemId,f.org.stockLocationId2,{subsidiaryId:f.org.subsidiaryId}))).value,'20.0000');
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
    await assert.rejects(withBypassContext(() => db.execute(sql`update bom_components set quantity_per='8'
      where org_id=${f.org.orgId} and assembly_item_id=${f.org.items.assembly} and is_byproduct returning id`)),/approved revision/);
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
  {name:'Done, material waiver and governed reversal require live posting and management grants before successful replay',run:async f=>{
    const wo=await prepare(f);await stock(f,f.org.items.component,'8','3');
    await issue(f,wo.id,[{materialId:wo.materials[0]!.id,quantity:'1'}]);
    await run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,wo.id,{quantity:'1'}));
    const waiver=()=>run(tx=>waiveMaterial(tx,f.org.orgId,f.actorId,wo.id,wo.materials[0]!.id,'Approved material substitution'));
    const waived=await waiver();assert.deepEqual(await waiver(),waived);
    const done=()=>run(tx=>markWorkOrderDone(tx,f.org.orgId,f.actorId,wo.id));const finished=await done();assert.deepEqual(await done(),finished);
    const active=await run(tx=>createWorkOrder(tx,f.org.orgId,f.actorId,{producedItemId:f.org.items.assembly,quantityOrdered:'1',subsidiaryId:f.org.subsidiaryId,issueLocationId:f.org.stockLocationId,receiptLocationId:f.org.stockLocationId2,plannedStart:f.org.date}));
    await run(tx=>releaseWorkOrder(tx,f.org.orgId,f.actorId,active.id));
    const material=(await run(tx=>getWorkOrder(tx,f.org.orgId,active.id)))!.materials[0]!;
    const draw=async()=>{const result=await issue(f,active.id,[{materialId:material.id,quantity:'1'}]);return (await run(tx=>tx.execute<{id:string}>(sql`select id from inventory_movements where org_id=${f.org.orgId} and journal_entry_id=${result.entryId} and kind='assembly_consume'`))).rows[0]!.id;};
    const oldMovement=await draw(),reverse=(movementId:string,actorId=f.actorId)=>run(()=>reverseMaterialIssue(f.org.orgId,actorId,{movementId,reversalDate:f.postingDate,reason:'Correct the genuine component issue'}));
    const reversed=await reverse(oldMovement);assert.deepEqual(await reverse(oldMovement),{...reversed,alreadyReversed:true});
    const newMovement=await draw();
    const roles=(await run(tx=>tx.execute<{id:string;permissions:unknown}>(sql`select id,permissions from app_roles where org_id=${f.org.orgId} and id in(select role_id from role_assignments where org_id=${f.org.orgId} and user_id=${f.actorId})`))).rows;
    const state=()=>run(async tx=>(await tx.execute(sql`select
      (select jsonb_agg(to_jsonb(work) order by id) from mfg_work_orders work where org_id=${f.org.orgId}) as orders,
      (select jsonb_agg(to_jsonb(material) order by id) from mfg_wo_materials material where org_id=${f.org.orgId}) as materials,
      (select count(*) from journal_entries where org_id=${f.org.orgId}) as entries,
      (select count(*) from inventory_movements where org_id=${f.org.orgId}) as movements,
      (select count(*) from audit_log where org_id=${f.org.orgId}) as audits`)).rows[0]);
    const before=await state();
    for(const permissions of [['manufacturing.manage','items.read'],['items.post','items.read']]){
      for(const role of roles)assert.equal((await run(tx=>tx.execute(sql`update app_roles set permissions=${JSON.stringify(permissions)}::jsonb where org_id=${f.org.orgId} and id=${role.id} returning id`))).rows.length,1);
      for(const command of [done,waiver,()=>run(tx=>waiveMaterial(tx,f.org.orgId,f.actorId,active.id,material.id,'Approved material substitution')),()=>reverse(oldMovement),()=>reverse(newMovement),()=>reverse(newMovement,randomUUID())])await assert.rejects(command(),/not.found/i);
      assert.deepEqual(await state(),before);
    }
    for(const role of roles)assert.equal((await run(tx=>tx.execute(sql`update app_roles set permissions=${JSON.stringify(role.permissions)}::jsonb where org_id=${f.org.orgId} and id=${role.id} returning id`))).rows.length,1);
    await reverse(newMovement);assert.equal(await wip(f,active.number),'0.0000');
  }},
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
  try{const actor=await withBypassContext(()=>createManufacturingOperator(foreign.orgId,'Foreign operator'));await denied(withBypassContext(()=>executeManufacturingReceipt(f.org.orgId,actor,null,wo.id,receiptKey,{quantity:'1'})));await denied(run(tx=>recordNormalScrap(tx,f.org.orgId,actor,null,wo.id,scrapKey,input)))}finally{await withBypassContext(()=>dropScratchOrg(foreign.orgId))}
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
  await run(tx => upsertItemPolicy(tx, f.org.orgId, f.actorId, f.org.items.component, {
    supplyMethod: "make", leadTimeDays: 1, safetyStockQty: "0", minimumQty: "0", orderMultipleQty: "0", scrapPctPlanned: "0",
  }));
  await run(tx => tx.execute(sql`insert into bom_components (org_id,assembly_item_id,component_item_id,quantity_per,sort_order)
    values (${f.org.orgId},${f.org.items.component},${f.org.items.standard},'1',0) returning id`));
  await route(f, f.org.items.component);
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
  const read = (view: "work-orders" | "routings" | "work-centers", id: string) => run(tx => readManufacturingRecord(tx, f.org.orgId, allowed, view, id));
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

  const hiddenDepartment=(await run(tx=>tx.execute<{id:string}>(sql`insert into departments(org_id,name,subsidiary_id) values(${f.org.orgId},'Resource owner',${f.org.subsidiaryId}) returning id`))).rows[0]!;
  await run(tx=>updateWorkCenter(tx,f.org.orgId,f.actorId,childResource.work_center_id,{departmentId:hiddenDepartment.id}));
  assert.equal((await read("work-orders",parent.id)).sections.children!.length,1);
  assert.equal((await run(tx=>tx.execute(sql`update departments set subsidiary_id=${otherEntity} where org_id=${f.org.orgId} and id=${hiddenDepartment.id} returning id`))).rows.length,1);
  await denied(read("work-orders",childId));await denied(read("routings",childResource.routing_id));await denied(read("work-centers",childResource.work_center_id));
  assert.equal((await read("work-orders",parent.id)).sections.children!.length,0);
  assert(!(await list("work-centers")).rows.some(row=>row.id===childResource.work_center_id));
  assert(!(await run(tx=>manufacturingOptions(tx,f.org.orgId,allowed))).centers.some(row=>row.value===childResource.work_center_id));
  assert(!(await run(tx=>searchManufacturingChoices(tx,f.org.orgId,allowed,"centers","",childResource.work_center_id))).some(row=>row.value===childResource.work_center_id),"remote selection cannot recover a hidden center through its ID");
  assert.equal((await run(tx=>tx.execute(sql`update departments set subsidiary_id=${f.org.subsidiaryId} where org_id=${f.org.orgId} and id=${hiddenDepartment.id} returning id`))).rows.length,1);
  assert.equal((await read("work-orders",parent.id)).sections.children!.length,1);
  assert.equal((await read("work-centers",childResource.work_center_id)).record.id,childResource.work_center_id);
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


cases.push({name:"approved production employee hours consume once independently of machine minutes and correct forward after receipt",run:async f=>{
  const order=await conversionOrder(f,f.org.items.assembly,'approved_time')
  const employee=randomUUID(),otherEmployee=randomUUID(),first=randomUUID(),second=randomUUID()
  await withBypassContext(async()=>{
    await seedPayrollPerson(f.org.orgId,employee,'Operator one',{subsidiaryId:f.org.subsidiaryId})
    await seedPayrollPerson(f.org.orgId,otherEmployee,'Operator two',{subsidiaryId:f.org.subsidiaryId})
    await seedActiveEmployment(f.org.orgId,employee);await seedActiveEmployment(f.org.orgId,otherEmployee)
    const rows=await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,work_order_id,wo_operation_id,status,cost_rate,cost_rate_currency,cost_rate_subsidiary_id,is_billable)
      values(${first},${f.org.orgId},${employee},${f.postingDate},'1.5',${order.id},${order.operation},'approved','15','CAD',${f.org.subsidiaryId},false),
      (${second},${f.org.orgId},${otherEmployee},${f.postingDate},'1',${order.id},${order.operation},'draft',null,null,null,false) returning id`)
    assert.equal(rows.rows.length,2)
    assert.equal((await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,projects}','false'::jsonb,true) where id=${f.org.orgId} returning id`)).rows.length,1)
  })
  await run(tx=>lockSharedTimeAuthority(tx,f.org.orgId,f.actorId,{employeeId:employee,from:f.postingDate,through:f.postingDate,requestedScope:null,permission:'time.read',workFamily:'production'}))
  await assert.rejects(run(tx=>lockSharedTimeAuthority(tx,f.org.orgId,randomUUID(),{employeeId:employee,from:f.postingDate,through:f.postingDate,requestedScope:null,permission:'time.manage',workFamily:'production'})),/not found/i)
  const before=await counts(f)
  await refuse(run(tx=>completeWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,order.operation,{doneQty:'10'})),'production_time_unapproved','unapproved')
  assert.deepEqual(await counts(f),before)
  await run(async tx=>{assert.equal((await tx.execute(sql`update time_entries set status='approved',cost_rate='15',cost_rate_currency='CAD',cost_rate_subsidiary_id=${f.org.subsidiaryId} where org_id=${f.org.orgId} and id=${second} returning id`)).rows.length,1)})
  await refuse(run(tx=>completeWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,order.operation,{doneQty:'10',actualLaborMinutes:'60'})),'production_time_override_refused','approved employee time')
  await run(tx=>completeWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,order.operation,{doneQty:'10'}))
  const conversion=(await run(tx=>tx.execute<{id:string;custom:Record<string,unknown>}>(sql`select id,custom from journal_entries where org_id=${f.org.orgId} and custom->>'operation_id'=${order.operation} and custom ? 'conversion_labor_amount'`))).rows[0]!
  assert.deepEqual(await entryAmounts(f,conversion.id),{[f.wipId]:'99.5000',[order.clearing]:'-75.0000',[order.applied]:'-24.5000'})
  const captured=(await run(tx=>tx.execute<{actual_labor_minutes:string;actual_run_minutes:string}>(sql`select actual_labor_minutes::text,actual_run_minutes::text from mfg_wo_operations where org_id=${f.org.orgId} and id=${order.operation}`))).rows[0]!
  assert.deepEqual(captured,{actual_labor_minutes:'150.0000',actual_run_minutes:'60.0000'})
  assert.equal((await run(tx=>tx.execute(sql`select id from time_entries where org_id=${f.org.orgId} and production_consumed_operation_id=${order.operation} and cost_journal_entry_id=${conversion.id}`))).rows.length,2)
  await assert.rejects(run(tx=>tx.execute(sql`update time_entries set hours='9' where org_id=${f.org.orgId} and id=${first}`)),/immutable/)
  await assert.rejects(run(tx=>tx.execute(sql`delete from time_entries where org_id=${f.org.orgId} and id=${first}`)),/immutable/)
  await assert.rejects(run(tx=>tx.execute(sql`update mfg_wo_operations set labor_time_source='operation' where org_id=${f.org.orgId} and id=${order.operation}`)),/keep their labor/)
  const completedCounts=await counts(f)
  await run(tx=>completeWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,order.operation,{doneQty:'10'}))
  assert.deepEqual(await counts(f),completedCounts)
  await run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,order.id,{quantity:'10'}))
  const contra=randomUUID()
  assert.equal((await run(tx=>tx.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,work_order_id,wo_operation_id,status,cost_rate,cost_rate_currency,cost_rate_subsidiary_id,is_billable,amends_entry_id)
    values(${contra},${f.org.orgId},${employee},${f.postingDate},'-1.5',${order.id},${order.operation},'approved','15','CAD',${f.org.subsidiaryId},false,${first}) returning id`))).rows.length,1)
  await run(tx=>applyProductionTimeCorrections(tx,f.org.orgId,f.actorId,[contra]))
  const correcting=(await run(tx=>tx.execute<{id:string;custom:Record<string,unknown>}>(sql`select id,custom from journal_entries where org_id=${f.org.orgId} and custom->>'time_entry_id'=${contra}`))).rows[0]!
  assert.equal(correcting.custom.conversion_disposition,'variance')
  assert.deepEqual(await entryAmounts(f,correcting.id),{[order.laborVariance]:'-45.0000',[order.clearing]:'45.0000',[order.overheadVariance]:'-7.5000',[order.applied]:'7.5000'})
  assert.equal(await wip(f,order.number),'0.0000','receipt history is retained and correction does not reopen WIP')
  const replacement=randomUUID()
  assert.equal((await run(tx=>tx.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,work_order_id,wo_operation_id,status,cost_rate,cost_rate_currency,cost_rate_subsidiary_id,is_billable,corrects_entry_id)
    values(${replacement},${f.org.orgId},${employee},${f.postingDate},'0.5',${order.id},${order.operation},'approved','15','CAD',${f.org.subsidiaryId},false,${first}) returning id`))).rows.length,1)
  await run(tx=>applyProductionTimeCorrections(tx,f.org.orgId,f.actorId,[replacement]))
  const replacing=(await run(tx=>tx.execute<{id:string}>(sql`select id from journal_entries where org_id=${f.org.orgId} and custom->>'time_entry_id'=${replacement}`))).rows[0]!
  assert.deepEqual(await entryAmounts(f,replacing.id),{[order.laborVariance]:'15.0000',[order.clearing]:'-15.0000',[order.overheadVariance]:'2.5000',[order.applied]:'-2.5000'})
  assert.equal(await wip(f,order.number),'0.0000')
  const correctingCounts=await counts(f)
  await run(tx=>applyProductionTimeCorrections(tx,f.org.orgId,f.actorId,[contra,replacement]))
  assert.deepEqual(await counts(f),correctingCounts)
  const revoked=await run(tx=>tx.execute(sql`update app_roles set permissions='["time.approve","manufacturing.read"]'::jsonb where org_id=${f.org.orgId} and id in(select role_id from role_assignments where org_id=${f.org.orgId} and user_id=${f.actorId}) returning id`))
  assert(revoked.rows.length>0)
  await assert.rejects(run(tx=>applyProductionTimeCorrections(tx,f.org.orgId,f.actorId,[contra])),/not found/i)
  assert.deepEqual(await counts(f),correctingCounts,'a revoked grant also refuses replay')
}})

async function inspectionPlan(f:Fixture,itemId:string,point:'receipt'|'operation') {
  const input={id:randomUUID(),name:'Dimensional acceptance',itemId,point,operationSequence:point==='operation'?10:null,effectiveFrom:'2026-01-01',measures:[{key:'length',label:'Length',unit:'mm',required:true,minimum:'9.9999',maximum:'10.0001'}],reason:'Establish dimensional inspection policy'};
  await run(tx=>saveInspectionPlan(tx,f.org.orgId,f.actorId,input));return input;
}
cases.push({name:'untracked items allow operation inspection policy but refuse receipt policy without creating plan or audit evidence',run:async f=>{
  const itemId=f.org.items.assembly;
  const profile=(await run(tx=>tx.execute<{tracking:string}>(sql`select tracking from item_inventory_profiles where org_id=${f.org.orgId} and item_id=${itemId}`))).rows[0]!;
  assert.equal(profile.tracking,'none');
  const plan=await inspectionPlan(f,itemId,'operation');
  const resolved=await run(tx=>resolveInspectionPlan(tx,f.org.orgId,itemId,'operation',f.postingDate,10));
  assert.equal(resolved?.id,plan.id);assert.equal(resolved?.point,'operation');assert.equal(resolved?.operationSequence,10);
  const evidence=()=>run(tx=>tx.execute<{plans:number;audits:number}>(sql`select
    (select count(*)::int from inventory_inspection_plans where org_id=${f.org.orgId}) as plans,
    (select count(*)::int from audit_log where org_id=${f.org.orgId} and table_name='inventory_inspection_plans') as audits`));
  const before=(await evidence()).rows;
  await assert.rejects(run(tx=>saveInspectionPlan(tx,f.org.orgId,f.actorId,{...plan,id:randomUUID(),point:'receipt',operationSequence:null})),/lot or serial tracking.*receipt inspection plan/i);
  assert.deepEqual((await evidence()).rows,before);
  assert.equal(await run(tx=>resolveInspectionPlan(tx,f.org.orgId,itemId,'receipt',f.postingDate)),null);
  await run(tx=>saveInspectionPlan(tx,f.org.orgId,f.actorId,plan));
  assert.deepEqual((await evidence()).rows,before,'replaying the accepted operation policy preserves its audit evidence');
}});
async function trackedQualityReceipt(f:Fixture,itemId:string,quantity='2') {
  await run(tx=>tx.execute(sql`update item_inventory_profiles set tracking='lot' where org_id=${f.org.orgId} and item_id=${itemId} returning item_id`));
  const plan=await inspectionPlan(f,itemId,'receipt'),lotId=await withBypassContext(()=>ensureLot(f.org.orgId,itemId,'INSPECT-'+randomUUID(),null,f.actorId));
  const receipt=await withBypassContext(()=>receiveInventory(f.org.orgId,f.actorId,{itemId,stockLocationId:f.org.stockLocationId,quantity,unitCost:'3',lotId,subsidiaryId:f.org.subsidiaryId,offsetAccountId:f.org.accounts.clearing,date:f.postingDate}));
  const inspection=(await run(tx=>tx.execute<{id:string}>(sql`select id from inventory_inspections where org_id=${f.org.orgId} and receipt_movement_id=${receipt.movementId}`))).rows[0]!;
  return {plan,lotId,receipt,inspection};
}
for(const {tracking,quarantined} of [{tracking:'lot',quarantined:false},{tracking:'serial',quarantined:false},{tracking:'lot',quarantined:true}] as const)cases.push({name:`received ${tracking} rework ${quarantined?'from quarantine ':''}preserves original valuation and identity, other holds and reversal claims`,run:async f=>{
  const item=f.org.items.component,quantity=tracking==='serial'?'1':'2';
  await run(tx=>tx.execute(sql`update item_inventory_profiles set tracking=${tracking} where org_id=${f.org.orgId} and item_id=${item} returning id`));
  await inspectionPlan(f,item,'receipt');
  const identifier=tracking==='lot'?await withBypassContext(()=>ensureLot(f.org.orgId,item,'REPAIR-'+randomUUID(),null,f.actorId)):await withBypassContext(()=>ensureSerial(f.org.orgId,item,'REPAIR-'+randomUUID(),null,f.actorId));
  const selection={lotId:tracking==='lot'?identifier:null,serialId:tracking==='serial'?identifier:null};
  const source=await withBypassContext(()=>receiveInventory(f.org.orgId,f.actorId,{itemId:item,stockLocationId:f.org.stockLocationId,quantity,unitCost:'3',subsidiaryId:f.org.subsidiaryId,offsetAccountId:f.org.accounts.clearing,date:f.postingDate,...selection}));
  const original=(await run(tx=>tx.execute<{id:string}>(sql`select id from inventory_inspections where org_id=${f.org.orgId} and receipt_movement_id=${source.movementId}`))).rows[0]!;
  await run(tx=>recordQualityInspection(tx,f.org.orgId,f.actorId,original.id,{outcome:'pass',measurements:{length:'10.1000'},reason:'Received finish outside tolerance'}));
  if(quarantined)assert.equal((await run(tx=>tx.execute(sql`update stock_locations set kind='quarantine' where org_id=${f.org.orgId} and id=${f.org.stockLocationId} returning id`))).rows.length,1);
  await route(f,item);
  const routing=(await run(tx=>tx.execute<{id:string;centerId:string}>(sql`select route.id,operation.work_center_id as "centerId" from mfg_routings route join mfg_routing_operations operation on operation.org_id=route.org_id and operation.routing_id=route.id where route.org_id=${f.org.orgId} and route.produced_item_id=${item} and route.status='active' and operation.sequence=10`))).rows[0]!;
  await run(tx=>addWorkCenterRate(tx,f.org.orgId,f.actorId,routing.centerId,{machineRatePerHour:'12',effectiveFrom:'2026-01-01'}));
  const input={action:'rework' as const,reason:'Repair the finish and reinspect the original stock',requestKey:randomUUID(),reworkRoutingId:routing.id,reworkSequence:10};
  const before=await counts(f);await assert.rejects(run(async tx=>{await disposeQualityInspection(tx,f.org.orgId,f.actorId,original.id,input);throw new Error('rollback repair draft')}),/rollback repair draft/);assert.deepEqual(await counts(f),before);
  assert.equal((await run(tx=>loadInspection(tx,f.org.orgId,original.id))).disposition,null);
  const disposition=await run(tx=>disposeQualityInspection(tx,f.org.orgId,f.actorId,original.id,input));
  assert.ok(disposition.reworkWorkOrderId);const orderId=disposition.reworkWorkOrderId!;
  assert.equal((await run(tx=>disposeQualityInspection(tx,f.org.orgId,f.actorId,original.id,input))).reworkWorkOrderId,orderId);
  assert.equal((await run(tx=>tx.execute(sql`select id from mfg_work_orders where org_id=${f.org.orgId} and receipt_rework_inspection_id=${original.id}`))).rows.length,1);
  const draftState=await counts(f);
  for(const patch of [{quantityOrdered:'3'},{issueLocationId:f.org.stockLocationId2}])await refuse(run(tx=>updateDraftWorkOrder(tx,f.org.orgId,f.actorId,orderId,patch)),'receipt_rework_identity_frozen','full inspected quantity');
  assert.deepEqual(await counts(f),draftState);
  await run(tx=>updateDraftWorkOrder(tx,f.org.orgId,f.actorId,orderId,{plannedStart:f.postingDate,...(quarantined?{receiptLocationId:f.org.stockLocationId2}:{})}));
  await run(tx=>releaseWorkOrder(tx,f.org.orgId,f.actorId,orderId));
  const material=(await run(tx=>tx.execute<{id:string;item:string}>(sql`select id,component_item_id as item from mfg_wo_materials where org_id=${f.org.orgId} and work_order_id=${orderId}`))).rows;
  assert.equal(material.length,1);assert.equal(material[0]?.item,item,'repair consumes the failed item rather than exploding its ordinary recipe');
  await withBypassContext(()=>setStockHold(f.org.orgId,f.actorId,{kind:tracking,id:identifier,held:true,reason:'Independent safety review'}));
  await assert.rejects(run(tx=>issueMaterials(tx,f.org.orgId,f.actorId,orderId,[{materialId:material[0]!.id,quantity,...selection}])),/Another stock or inspection hold/);
  await withBypassContext(()=>setStockHold(f.org.orgId,f.actorId,{kind:tracking,id:identifier,held:false,reason:'Independent safety review completed'}));
  const issueKey=randomUUID(),issueCommand=()=>withBypassContext(()=>executeManufacturingIssue(f.org.orgId,f.actorId,null,orderId,issueKey,[{materialId:material[0]!.id,quantity,...selection}]));
  const issued=await issueCommand(),issuedCounts=await counts(f);assert.deepEqual((await issueCommand()).value,issued.value);assert.deepEqual(await counts(f),issuedCounts);
  const order=(await run(tx=>getWorkOrder(tx,f.org.orgId,orderId)))!;assert.equal(await wip(f,order.number),tracking==='lot'?'6.0000':'3.0000');
  const operation=(await run(tx=>tx.execute<{id:string}>(sql`select id from mfg_wo_operations where org_id=${f.org.orgId} and work_order_id=${orderId}`))).rows[0]!;
  await run(tx=>startWorkOrderOperation(tx,f.org.orgId,f.actorId,orderId,operation.id));
  const acceptance=(await run(tx=>tx.execute<{id:string}>(sql`select id from inventory_inspections where org_id=${f.org.orgId} and operation_id=${operation.id}`))).rows[0]!;
  await run(tx=>recordQualityInspection(tx,f.org.orgId,f.actorId,acceptance.id,{outcome:'pass',measurements:{length:'10.0000'},reason:'Repair meets original acceptance limits',quantity,...selection}));
  await run(tx=>completeWorkOrderOperation(tx,f.org.orgId,f.actorId,orderId,operation.id,{doneQty:quantity,actualSetupMinutes:'0',actualRunMinutes:'5',actualLaborMinutes:'0'}));
  const receipt=await run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,orderId,{quantity}));
  assert.equal(receipt.value,tracking==='lot'?'7.0000':'4.0000');assert.equal(await wip(f,order.number),'0.0000');
  const repaired=(await run(tx=>tx.execute<{id:string;lotId:string|null;serialId:string|null}>(sql`select id,lot_id as "lotId",serial_id as "serialId" from inventory_movements where org_id=${f.org.orgId} and journal_entry_id=${receipt.entryId} and kind='assembly_build'`))).rows[0]!;
  assert.equal(repaired.lotId,selection.lotId);assert.equal(repaired.serialId,selection.serialId);
  const inspected=(await run(tx=>tx.execute<{id:string}>(sql`select id from inventory_inspections where org_id=${f.org.orgId} and receipt_movement_id=${repaired.id}`))).rows[0]!;
  await run(tx=>recordQualityInspection(tx,f.org.orgId,f.actorId,inspected.id,{outcome:'pass',measurements:{length:'10.0000'},reason:'Repaired receipt meets frozen limits'}));
  const available=()=>run(tx=>getAvailableToPromise(tx,f.org.orgId,{itemId:item,subsidiaryId:f.org.subsidiaryId}));assert.equal((await available()).available,quantity+'.0000');
  await run(()=>reverseMaterialIssue(f.org.orgId,f.actorId,{movementId:repaired.id,reversalDate:f.postingDate,reason:'Correct repaired receipt without losing original hold'}));
  assert.equal((await available()).available,'0.0000');assert.equal(await wip(f,order.number),receipt.value);
  const afterReversal=await counts(f);await assert.rejects(run(tx=>issueInventory(f.org.orgId,f.actorId,{tx,itemId:item,stockLocationId:f.org.stockLocationId,quantity,subsidiaryId:f.org.subsidiaryId,date:f.postingDate,...selection})),/held/);assert.deepEqual(await counts(f),afterReversal);
  await run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,orderId,{quantity}));assert.equal(await wip(f,order.number),'0.0000');
}});

cases.push(
 {name:'a failed received-stock repair disposes its complete original stock through approved loss without inventing output or clearing another hold',run:async f=>{
  const item=f.org.items.component,{lotId,inspection}=await trackedQualityReceipt(f,item,'2');
  await run(tx=>recordQualityInspection(tx,f.org.orgId,f.actorId,inspection.id,{outcome:'fail',measurements:{length:'12'},reason:'Original stock requires repair'}));
  await route(f,item);
  const routing=(await run(tx=>tx.execute<{id:string;centerId:string}>(sql`select route.id,operation.work_center_id as "centerId" from mfg_routings route join mfg_routing_operations operation on operation.org_id=route.org_id and operation.routing_id=route.id where route.org_id=${f.org.orgId} and route.produced_item_id=${item} and route.status='active' and operation.sequence=10`))).rows[0]!;
  await run(tx=>addWorkCenterRate(tx,f.org.orgId,f.actorId,routing.centerId,{machineRatePerHour:'0',effectiveFrom:'2026-01-01'}));
  const disposition=await run(tx=>disposeQualityInspection(tx,f.org.orgId,f.actorId,inspection.id,{action:'rework',reason:'Attempt repair under original dimensional criteria',requestKey:randomUUID(),reworkRoutingId:routing.id,reworkSequence:10}));
  const id=disposition.reworkWorkOrderId!;await run(tx=>releaseWorkOrder(tx,f.org.orgId,f.actorId,id));
  const work=(await run(tx=>getWorkOrder(tx,f.org.orgId,id)))!,operation=work.operations[0]!,reasonId=randomUUID();
  await run(tx=>tx.execute(sql`insert into mfg_scrap_reasons(id,org_id,code,name,classification,is_active) values(${reasonId},${f.org.orgId},${reasonId},'Failed repair','abnormal',true) returning id`));
  const input={operationId:operation.id,reasonId,quantity:'2',reason:'The original stock cannot be repaired and must be discarded',requestKey:randomUUID(),times:[]};
  const before=await counts(f);await assert.rejects(run(tx=>proposeProductionLoss(tx,f.org.orgId,f.actorId,id,input)),/all of its original inspected stock/);assert.deepEqual(await counts(f),before);assert.equal((await run(tx=>getWorkOrder(tx,f.org.orgId,id)))!.status,'released');
  await run(tx=>issueMaterials(tx,f.org.orgId,f.actorId,id,[{materialId:work.materials[0]!.id,quantity:'2',lotId}]));
  await run(tx=>startWorkOrderOperation(tx,f.org.orgId,f.actorId,id,operation.id));
  const loss={...input,times:[{operationId:operation.id,attemptedQty:'2',actualSetupMinutes:'0',actualRunMinutes:'0',actualLaborMinutes:'0'}]};
  await assert.rejects(run(tx=>proposeProductionLoss(tx,f.org.orgId,f.actorId,id,{...loss,quantity:'1',requestKey:randomUUID()})),/all of its original inspected stock/);
  await withBypassContext(()=>setStockHold(f.org.orgId,f.actorId,{kind:'lot',id:lotId,held:true,reason:'Independent recall review'}));
  const proposal=await run(tx=>proposeProductionLoss(tx,f.org.orgId,f.actorId,id,loss));
  const approver=await withBypassContext(()=>createWorkOperator(f.org.orgId,"Independent repair disposition",["manufacturing.manage"]));
  await withBypassContext(()=>seedApprovalFlow(f.org.orgId,{subjectKind:'financial_change',assignees:[{type:'user',userId:approver}],mode:'any',preventSelfApproval:true}));
  await withBypassContext(()=>submitFinancialChange(f.org.orgId,proposal.changeId,f.actorId));
  const gates=(await run(tx=>tx.execute<{id:string}>(sql`select id from flow_gates where org_id=${f.org.orgId} and subject_kind='financial_change' and subject_id=${proposal.changeId} and status='pending'`))).rows;
  assert.equal(gates.length,1);await withBypassContext(()=>decideGate({gateId:gates[0]!.id,userId:approver,decision:'approved'}));
  const result=await withBypassContext(()=>applyProductionLoss(f.org.orgId,f.actorId,proposal.changeId));assert.equal(result.value,'6.0000');assert.equal(await wip(f,work.number),'0.0000');
  const after=await counts(f);assert.deepEqual(await withBypassContext(()=>applyProductionLoss(f.org.orgId,f.actorId,proposal.changeId)),result);assert.deepEqual(await counts(f),after);
  const retained=await run(tx=>readManufacturingInspection(tx,f.org.orgId,f.actorId,inspection.id));assert.equal(retained.sourceActive,true);assert.equal(retained.reworkResolved,true);assert.equal(retained.reworkLoss,true);
  assert.equal((await run(tx=>tx.execute<{reason:string|null}>(sql`select hold_reason as reason from lots where org_id=${f.org.orgId} and id=${lotId}`))).rows[0]?.reason,'Independent recall review');
  assert.equal((await run(tx=>tx.execute(sql`select movement.id from inventory_movements movement join journal_entries entry on entry.org_id=movement.org_id and entry.id=movement.journal_entry_id where movement.org_id=${f.org.orgId} and entry.custom->>'work_order_number'=${work.number} and movement.kind='assembly_build'`))).rows.length,0);
  const issueMovement=(await run(tx=>tx.execute<{id:string}>(sql`select movement.id from inventory_movements movement join journal_entries entry on entry.org_id=movement.org_id and entry.id=movement.journal_entry_id where movement.org_id=${f.org.orgId} and entry.custom->>'work_order_number'=${work.number} and movement.kind='assembly_consume'`))).rows[0]!.id;
  await assert.rejects(run(()=>reverseMaterialIssue(f.org.orgId,f.actorId,{movementId:issueMovement,reversalDate:f.postingDate,reason:'Attempt to restore discarded stock'})));
 }},
 {name:'receipt inspection freezes policy, derives failure and preserves independent manual holds through disposition',run:async f=>{
  const itemId=f.org.items.fifo,{plan,lotId,receipt,inspection}=await trackedQualityReceipt(f,itemId);
  const available=()=>run(tx=>getAvailableToPromise(tx,f.org.orgId,{itemId,subsidiaryId:f.org.subsidiaryId}));
  assert.equal((await available()).available,'0.0000');assert.equal((await withBypassContext(()=>getOnHandWith(db,f.org.orgId,itemId,f.org.stockLocationId,{subsidiaryId:f.org.subsidiaryId}))).quantity,'2.0000');
  const before=await counts(f);
  await assert.rejects(withBypassContext(()=>issueInventory(f.org.orgId,f.actorId,{itemId,stockLocationId:f.org.stockLocationId,quantity:'1',lotId,subsidiaryId:f.org.subsidiaryId,offsetAccountId:f.org.accounts.adjustment,date:f.postingDate})),/held|quarantined/i);
  assert.deepEqual(await counts(f),before);
  await assert.rejects(withBypassContext(()=>setStockHold(f.org.orgId,f.actorId,{kind:'lot',id:lotId,held:false,reason:'Attempt independent release'})),/inspection/i);
  const result=await run(tx=>recordQualityInspection(tx,f.org.orgId,f.actorId,inspection.id,{outcome:'pass',measurements:{length:'10.0002'},reason:'Record exact out of tolerance dimension'}));assert.equal(result.status,'fail');
  const note={...plan,effectiveTo:f.postingDate,expectedRevision:1,reason:'End this policy before next effective revision'};
  const ended=await run(tx=>saveInspectionPlan(tx,f.org.orgId,f.actorId,note));assert.equal(ended.revision,2);
  assert.deepEqual(await run(tx=>saveInspectionPlan(tx,f.org.orgId,f.actorId,note)),ended,'identical optimistic retry retains its revision');
  await assert.rejects(run(tx=>saveInspectionPlan(tx,f.org.orgId,f.actorId,{...note,reason:'Another stale concurrent policy change'})),/changed/i);
  assert.equal((await run(tx=>loadInspection(tx,f.org.orgId,inspection.id))).planSnapshot.name,plan.name);
  await withBypassContext(()=>setStockHold(f.org.orgId,f.actorId,{kind:'lot',id:lotId,held:true,reason:'Independent safety investigation'}));
  const input={action:'use_as_is' as const,reason:'Engineering accepts this dimensional deviation',requestKey:randomUUID()};
  await run(tx=>disposeQualityInspection(tx,f.org.orgId,f.actorId,inspection.id,input));const evidence=await counts(f);
  await run(tx=>disposeQualityInspection(tx,f.org.orgId,f.actorId,inspection.id,input));assert.deepEqual(await counts(f),evidence);
  assert.equal((await available()).available,'0.0000','use-as-is does not clear the separate manual hold');
  await withBypassContext(()=>setStockHold(f.org.orgId,f.actorId,{kind:'lot',id:lotId,held:false,reason:'Safety review completed independently'}));assert.equal((await available()).available,'2.0000');
  assert.equal((await run(tx=>readManufacturingInspection(tx,f.org.orgId,f.actorId,inspection.id))).receiptMovementId,receipt.movementId);
  assert.equal((await run(tx=>listManufacturingInspections(tx,f.org.orgId,f.actorId,{status:'fail'}))).total,1);
 }},
 {name:'quality scrap disposes the exact receipt layers, balances once and refuses revoked replay without changes',run:async f=>{
  const itemId=f.org.items.fifo,{lotId,receipt,inspection}=await trackedQualityReceipt(f,itemId);
  await run(tx=>recordQualityInspection(tx,f.org.orgId,f.actorId,inspection.id,{outcome:'fail',measurements:{length:'10'},reason:'Visual damage fails accepted dimensions'}));
  const input={action:'scrap' as const,reason:'Damaged received stock cannot be repaired',requestKey:randomUUID()};
  const result=await run(tx=>disposeQualityInspection(tx,f.org.orgId,f.actorId,inspection.id,input));
  assert.equal(result.dispositionResult?.value,'-6.0000');
  assert.equal((await withBypassContext(()=>getOnHandWith(db,f.org.orgId,itemId,f.org.stockLocationId,{subsidiaryId:f.org.subsidiaryId,lotId}))).quantity,'0.0000');
  const consumed=(await run(tx=>tx.execute<{source:string;quantity:string}>(sql`select layer.source_movement_id as source,consumption.quantity::text from cost_layer_consumptions consumption join cost_layers layer on layer.org_id=consumption.org_id and layer.id=consumption.cost_layer_id where consumption.org_id=${f.org.orgId} and consumption.issue_movement_id=${String(result.dispositionResult?.movementId)}`))).rows;
  assert.deepEqual(consumed,[{source:receipt.movementId,quantity:'2.0000'}]);
  const entryId=String(result.dispositionResult?.entryId),balanced=(await run(tx=>tx.execute<{amount:string}>(sql`select sum(amount)::text as amount from journal_lines where org_id=${f.org.orgId} and entry_id=${entryId}`))).rows[0]!.amount;assert.equal(balanced,'0.0000');
  const before=await counts(f);await run(tx=>disposeQualityInspection(tx,f.org.orgId,f.actorId,inspection.id,input));assert.deepEqual(await counts(f),before);
  await run(tx=>tx.execute(sql`update app_roles set permissions='["manufacturing.read","items.read"]'::jsonb where org_id=${f.org.orgId} and id in(select role_id from role_assignments where org_id=${f.org.orgId} and user_id=${f.actorId}) returning id`));
  await assert.rejects(run(tx=>disposeQualityInspection(tx,f.org.orgId,f.actorId,inspection.id,input)),/not found/i);assert.deepEqual(await counts(f),before);
 }},
 {name:'reversed receipts retain inspection history without holding replacements or accepting new results',run:async f=>{
  const itemId=f.org.items.fifo,{lotId,receipt,inspection}=await trackedQualityReceipt(f,itemId);
  await withBypassContext(()=>reverseInventoryMovement(f.org.orgId,f.actorId,{movementId:receipt.movementId,reversalDate:f.postingDate,reason:'Replace an incorrect inbound receipt'}));
  const historical=await run(tx=>readManufacturingInspection(tx,f.org.orgId,f.actorId,inspection.id));assert.equal(historical.sourceActive,false);assert.equal(historical.status,'pending');
  const identifiers=await withBypassContext(()=>inventoryTrackingOptions(f.org.orgId,f.actorId,{itemId,selectedLotId:lotId}));assert.equal(identifiers.lots.find(lot=>lot.id===lotId)?.hold_reason,null);
  await assert.rejects(run(tx=>recordQualityInspection(tx,f.org.orgId,f.actorId,inspection.id,{outcome:'pass',measurements:{length:'10'},reason:'Attempt inspection of reversed source'})),/reversed/i);
  const replacement=await withBypassContext(()=>receiveInventory(f.org.orgId,f.actorId,{itemId,stockLocationId:f.org.stockLocationId,quantity:'2',unitCost:'3',lotId,subsidiaryId:f.org.subsidiaryId,offsetAccountId:f.org.accounts.clearing,date:f.postingDate}));
  const current=(await run(tx=>tx.execute<{id:string}>(sql`select id from inventory_inspections where org_id=${f.org.orgId} and receipt_movement_id=${replacement.movementId}`))).rows[0]!;
  await run(tx=>recordQualityInspection(tx,f.org.orgId,f.actorId,current.id,{outcome:'pass',measurements:{length:'10'},reason:'Replacement receipt passes inspection'}));
  assert.equal((await run(tx=>getAvailableToPromise(tx,f.org.orgId,{itemId,subsidiaryId:f.org.subsidiaryId}))).available,'2.0000');
 }},
 {name:'in-process rework must inspect the same identifier before native completion releases its hold',run:async f=>{
  await run(tx=>tx.execute(sql`update item_inventory_profiles set tracking='lot' where org_id=${f.org.orgId} and item_id=${f.org.items.assembly} returning item_id`));
  await inspectionPlan(f,f.org.items.assembly,'operation');const order=await prepare(f);await stock(f,f.org.items.component,'2','3');await issue(f,order.id,[{materialId:order.materials[0]!.id,quantity:'2'}]);
  const original=(await run(tx=>tx.execute<{id:string}>(sql`select id from mfg_wo_operations where org_id=${f.org.orgId} and work_order_id=${order.id} and sequence=10`))).rows[0]!;
  await run(tx=>startWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,original.id));
  const failed=(await run(tx=>tx.execute<{id:string}>(sql`select id from inventory_inspections where org_id=${f.org.orgId} and operation_id=${original.id}`))).rows[0]!;
  const produced=await run(tx=>registerInspectionIdentifier(tx,f.org.orgId,f.actorId,failed.id,{kind:'lot',number:'REWORK-ORIGINAL'}));
  await run(tx=>recordQualityInspection(tx,f.org.orgId,f.actorId,failed.id,{outcome:'fail',measurements:{length:'10.2'},reason:'Rework the oversized produced unit',quantity:'1',lotId:produced.id}));
  await assert.rejects(run(tx=>completeWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,original.id,{doneQty:'1',actualSetupMinutes:'0',actualRunMinutes:'0',actualLaborMinutes:'0'})),/inspection/i);
  const disposition=await run(tx=>disposeQualityInspection(tx,f.org.orgId,f.actorId,failed.id,{action:'rework',reason:'Machine the oversized unit to specification',requestKey:randomUUID()}));
  const reworkId=String(disposition.dispositionResult?.operationId);await run(tx=>startWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,reworkId));
  const followup=(await run(tx=>tx.execute<{id:string}>(sql`select id from inventory_inspections where org_id=${f.org.orgId} and operation_id=${reworkId}`))).rows[0]!;
  const other=await run(tx=>registerInspectionIdentifier(tx,f.org.orgId,f.actorId,followup.id,{kind:'lot',number:'REWORK-OTHER'}));
  await run(tx=>recordQualityInspection(tx,f.org.orgId,f.actorId,followup.id,{outcome:'pass',measurements:{length:'10'},reason:'An unrelated unit meets its limits',quantity:'1',lotId:other.id}));
  const before=await counts(f);await assert.rejects(run(tx=>completeWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,reworkId,{doneQty:'1',actualSetupMinutes:'0',actualRunMinutes:'0',actualLaborMinutes:'0'})),/same lot or serial/i);assert.deepEqual(await counts(f),before);
  const accepted=await run(tx=>createOperationInspection(tx,f.org.orgId,f.actorId,order.id,reworkId,{id:randomUUID(),quantity:'1'}));
  assert(accepted);await run(tx=>recordQualityInspection(tx,f.org.orgId,f.actorId,accepted.id,{outcome:'pass',measurements:{length:'10'},reason:'The original repaired unit meets its limits',quantity:'1',lotId:produced.id}));
  for(const operationId of [reworkId,original.id]) await run(tx=>completeWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,operationId,{doneQty:'1',actualSetupMinutes:'0',actualRunMinutes:'0',actualLaborMinutes:'0'}));
  const completed=await run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,order.id,{quantity:'1',lots:[{quantity:'1',lotNumber:'REWORK-ORIGINAL'}]}));assert.equal(completed.value,'6.0000');assert.equal(await wip(f,order.number),'0.0000');
 }}
);

cases.push({name:'formula and fixed batch ingredients freeze at release and split receipts conserve inputs, outputs and WIP',run:async f=>{
  await run(tx=>tx.execute(sql`update bom_components set quantity_per='10',quantity_basis='per_formula',formula_output_quantity='100',scrap_pct='0',operation_seq=null where org_id=${f.org.orgId} and assembly_item_id=${f.org.items.assembly} returning id`));
  await run(tx=>tx.execute(sql`insert into bom_components(org_id,assembly_item_id,component_item_id,quantity_per,quantity_basis,formula_output_quantity,sort_order,is_byproduct)
    values(${f.org.orgId},${f.org.items.assembly},${f.org.items.fifo},'2','per_batch','1',1,false),(${f.org.orgId},${f.org.items.assembly},${f.org.items.movingAvg},'1','per_formula','100',2,true) returning id`));
  await run(tx=>tx.execute(sql`update items set default_rate='0.5' where org_id=${f.org.orgId} and id=${f.org.items.movingAvg} returning id`));
  const exploded=await run(tx=>explodeBom(tx,f.org.orgId,f.org.items.assembly,'100',f.org.date));
  assert.deepEqual(Object.fromEntries(exploded.components.map(line=>[line.itemId,line.requiredQuantity])),{[f.org.items.component]:'10.0000',[f.org.items.fifo]:'2.0000'});assert.equal(exploded.byproducts[0]?.requiredQuantity,'1.0000');
  await stock(f,f.org.items.component,'10','3');await stock(f,f.org.items.fifo,'2','5');await route(f,f.org.items.assembly);
  await run(tx=>tx.execute(sql`update bom_components set quantity_per='0.0001' where org_id=${f.org.orgId} and assembly_item_id=${f.org.items.assembly} and component_item_id=${f.org.items.component} returning id`));
  const actualBatchSetup=await run(tx=>readOperatingSetupJourney(tx,f.org.orgId,f.actorId,{family:'production',selection:'batch_process',itemId:f.org.items.assembly,subsidiaryId:f.org.subsidiaryId,quantity:'100'}));
  assert.equal(actualBatchSetup.readyFor,'release');assert.equal(new URL(actualBatchSetup.nextHref!,'http://localhost').searchParams.get('quantityOrdered'),'100');
  const tooSmallSetup=await run(tx=>readOperatingSetupJourney(tx,f.org.orgId,f.actorId,{family:'production',selection:'batch_process',itemId:f.org.items.assembly,subsidiaryId:f.org.subsidiaryId,quantity:'1'}));
  assert.equal(tooSmallSetup.findings.find(finding=>finding.key==='bom')?.status,'missing');
  await run(tx=>tx.execute(sql`update bom_components set quantity_per='10' where org_id=${f.org.orgId} and assembly_item_id=${f.org.items.assembly} and component_item_id=${f.org.items.component} returning id`));
  const order=await run(tx=>createWorkOrder(tx,f.org.orgId,f.actorId,{producedItemId:f.org.items.assembly,quantityOrdered:'100',subsidiaryId:f.org.subsidiaryId,issueLocationId:f.org.stockLocationId,receiptLocationId:f.org.stockLocationId2,plannedStart:f.org.date}));
  await run(tx=>releaseWorkOrder(tx,f.org.orgId,f.actorId,order.id));
  const materials=(await run(tx=>tx.execute<{id:string;itemId:string;quantity:string;basis:string;output:string}>(sql`select id,component_item_id as "itemId",required_qty::text as quantity,quantity_basis as basis,formula_output_quantity::text as output from mfg_wo_materials where org_id=${f.org.orgId} and work_order_id=${order.id}`))).rows;
  assert.equal(materials.find(line=>line.itemId===f.org.items.component)?.output,'100.0000');assert.equal(materials.find(line=>line.itemId===f.org.items.fifo)?.basis,'per_batch');
  await assert.rejects(run(tx=>tx.execute(sql`update mfg_wo_materials set formula_output_quantity='50' where org_id=${f.org.orgId} and work_order_id=${order.id} and component_item_id=${f.org.items.component} returning id`)),/retain their recipe/i);
  await issue(f,order.id,materials.map(line=>({materialId:line.id,quantity:line.quantity})));assert.equal(await wip(f,order.number),'40.0000');
  const first=await run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,order.id,{quantity:'40'}));assert.equal(first.value,'15.8000');assert.equal(await wip(f,order.number),'24.0000');
  const final=await run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,order.id,{quantity:'60'}));assert.equal(final.value,'23.7000');assert.equal(await wip(f,order.number),'0.0000');
  const byproduct=await withBypassContext(()=>getOnHandWith(db,f.org.orgId,f.org.items.movingAvg,f.org.stockLocationId2,{subsidiaryId:f.org.subsidiaryId}));assert.equal(byproduct.quantity,'1.0000');assert.equal(byproduct.value,'0.5000');
  assert.equal((await run(tx=>readManufacturingRecord(tx,f.org.orgId,null,'work-orders',order.id,f.actorId))).sections.materials?.find(line=>line.itemId===f.org.items.fifo)?.quantityBasis,'per_batch');
}});




cases.push({name:"production subcontract ships valued components once with native vendor lineage and rejects stale authority",run:async f=>{
  const order=await prepare(f,{quantity:'3'});
  await stock(f,f.org.items.component,'6','4.5');
  await run(tx=>tx.execute(sql`update orgs set settings=jsonb_set(settings,'{features,manufacturingSubcontract}','true'::jsonb,true) where id=${f.org.orgId} returning id`));
  const custody=randomUUID();
  await run(tx=>tx.execute(sql`insert into stock_locations(id,org_id,location_id,code,kind,custodian_party_id) values(${custody},${f.org.orgId},${f.org.locationId},'FINISHING-VENDOR','subcontract',${f.org.vendorId}) returning id`));
  const operation=(await run(tx=>tx.execute<{id:string}>(sql`select id from mfg_wo_operations where org_id=${f.org.orgId} and work_order_id=${order.id} order by sequence`))).rows[0]!.id;
  const request={id:randomUUID(),workOrderId:order.id,operationId:operation,vendorId:f.org.vendorId,custodyLocationId:custody};
  const contract=await run(tx=>createProductionSubcontract(tx,f.org.orgId,f.actorId,request));
  assert.equal(contract.quantityExpected,'3.0000');
  assert.equal((await run(tx=>createProductionSubcontract(tx,f.org.orgId,f.actorId,request))).replayed,true);
  const shipment={id:randomUUID(),materialId:order.materials[0]!.id,sourceLocationId:f.org.stockLocationId,quantity:'6',date:f.postingDate};
  const sent=await run(tx=>shipSubcontractMaterial(tx,f.org.orgId,f.actorId,contract.id,shipment));
  assert.equal(sent.value,'27.0000');
  const shippedCounts=await counts(f);
  assert.equal((await run(tx=>shipSubcontractMaterial(tx,f.org.orgId,f.actorId,contract.id,shipment))).replayed,true);
  assert.deepEqual(await counts(f),shippedCounts);
  assert.equal((await run(tx=>getOnHandWith(tx,f.org.orgId,f.org.items.component,custody,{subsidiaryId:f.org.subsidiaryId}))).value,'27.0000');
  assert.equal((await run(tx=>getOnHandWith(tx,f.org.orgId,f.org.items.component,custody,{subsidiaryId:f.org.subsidiaryId,saleableOnly:true}))).quantity,'0.0000');
  assert.equal(await wip(f,order.number),'0.0000','shipping keeps the asset in inventory rather than consuming it into WIP');
  const lineage=(await run(tx=>tx.execute<{item:string;entity:string;kind:string;paired:string;quantity:string}>(sql`select item_id as item,subsidiary_id as entity,kind,paired_movement_id as paired,quantity::text from inventory_movements where org_id=${f.org.orgId} and id=${sent.toMovementId}`))).rows[0]!;
  assert.deepEqual(lineage,{item:f.org.items.component,entity:f.org.subsidiaryId,kind:'transfer_in',paired:sent.fromMovementId,quantity:'6.0000'});
  await refuse(run(tx=>shipSubcontractMaterial(tx,f.org.orgId,f.actorId,contract.id,{...shipment,id:randomUUID(),quantity:'1'})),'subcontract_material_excess','remaining');
  await assert.rejects(run(tx=>tx.execute(sql`update mfg_subcontract_shipments set quantity='5' where org_id=${f.org.orgId} and id=${sent.id}`)),/immutable/);
  const consumptionKey=randomUUID();
  const beforeConsumption=await counts(f);
  await refuse(run(tx=>consumeSubcontractMaterials(tx,f.org.orgId,f.actorId,contract.id,consumptionKey,[{shipmentId:sent.id,quantity:'7'}])),'material_shortage','short');
  assert.deepEqual(await counts(f),beforeConsumption);
  const consumed=await run(tx=>consumeSubcontractMaterials(tx,f.org.orgId,f.actorId,contract.id,consumptionKey,[{shipmentId:sent.id,quantity:'6'}]));
  assert(consumed.entryId);
  assert.equal(await wip(f,order.number),'27.0000');
  assert.equal((await run(tx=>getOnHandWith(tx,f.org.orgId,f.org.items.component,custody,{subsidiaryId:f.org.subsidiaryId}))).quantity,'0.0000');
  const used=(await run(tx=>tx.execute<{issued:string;quantity:string;cost:string}>(sql`select material.issued_qty::text as issued,movement.quantity::text as quantity,movement.total_value::text as cost
    from mfg_wo_materials material join inventory_movements movement on movement.org_id=material.org_id and movement.id=${consumed.movementIds[0]!}
    where material.org_id=${f.org.orgId} and material.id=${shipment.materialId}`))).rows[0]!;
  assert.deepEqual(used,{issued:'6.0000',quantity:'-6.0000',cost:'-27.0000'});
  const consumedCounts=await counts(f);
  assert.equal((await run(tx=>consumeSubcontractMaterials(tx,f.org.orgId,f.actorId,contract.id,consumptionKey,[{shipmentId:sent.id,quantity:'6'}]))).replayed,true);
  assert.deepEqual(await counts(f),consumedCounts);
  await run(tx=>tx.execute(sql`update app_roles set permissions='["manufacturing.read","items.read"]'::jsonb where org_id=${f.org.orgId} and id in(select role_id from role_assignments where org_id=${f.org.orgId} and user_id=${f.actorId}) returning id`));
  const revokedCounts=await counts(f);
  await assert.rejects(run(tx=>shipSubcontractMaterial(tx,f.org.orgId,f.actorId,contract.id,shipment)),/not.found/i);
  await assert.rejects(run(tx=>createProductionSubcontract(tx,f.org.orgId,f.actorId,request)),/not.found/i);
  await assert.rejects(run(tx=>consumeSubcontractMaterials(tx,f.org.orgId,f.actorId,contract.id,consumptionKey,[{shipmentId:sent.id,quantity:'6'}])),/not.found/i);
  assert.deepEqual(await counts(f),revokedCounts);
}});


cases.push({name:"vendor deliveries, native bill capitalization and unused returns conserve WIP, stock, replay and reversal evidence",run:async f=>{
  const order=await prepare(f,{quantity:'3'});
  await stock(f,f.org.items.component,'6','4.5');
  await run(tx=>tx.execute(sql`update orgs set settings=jsonb_set(settings,'{features,manufacturingSubcontract}','true'::jsonb,true) where id=${f.org.orgId} returning id`));
  const custody=randomUUID();
  await run(tx=>tx.execute(sql`insert into stock_locations(id,org_id,location_id,code,kind,custodian_party_id) values(${custody},${f.org.orgId},${f.org.locationId},'COATING-VENDOR','subcontract',${f.org.vendorId}) returning id`));
  const operation=(await run(tx=>tx.execute<{id:string}>(sql`select id from mfg_wo_operations where org_id=${f.org.orgId} and work_order_id=${order.id} order by sequence`))).rows[0]!.id;
  const contract=await run(tx=>createProductionSubcontract(tx,f.org.orgId,f.actorId,{id:randomUUID(),workOrderId:order.id,operationId:operation,vendorId:f.org.vendorId,custodyLocationId:custody}));
  const sent=await run(tx=>shipSubcontractMaterial(tx,f.org.orgId,f.actorId,contract.id,{id:randomUUID(),materialId:order.materials[0]!.id,sourceLocationId:f.org.stockLocationId,quantity:'6',date:f.postingDate}));
  const first={id:randomUUID(),quantity:'1',finish:false,consumption:[{shipmentId:sent.id,quantity:'2'}]};
  await run(tx=>recordSubcontractReturn(tx,f.org.orgId,f.actorId,contract.id,first));
  assert.equal(await wip(f,order.number),'9.0000');
  const firstCounts=await counts(f);
  assert.equal((await run(tx=>recordSubcontractReturn(tx,f.org.orgId,f.actorId,contract.id,first))).replayed,true);
  assert.deepEqual(await counts(f),firstCounts);
  await refuse(run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,order.id,{quantity:'1'})),'subcontract_output_not_ready','vendor');
  await refuse(run(tx=>recordSubcontractReturn(tx,f.org.orgId,f.actorId,contract.id,{id:randomUUID(),quantity:'2',finish:true})),'subcontract_service_cost_required','bill');
  assert.deepEqual(await counts(f),firstCounts,'refused final delivery changes no quantity, costs or postings');
  const serviceDepartment=(await run(tx=>tx.execute<{id:string}>(sql`insert into departments(org_id,name,subsidiary_id) values(${f.org.orgId},'Vendor service ownership',${f.org.subsidiaryId}) returning id`))).rows[0]!.id;
  const billBody={partyId:f.org.vendorId,documentDate:f.postingDate,departmentId:serviceDepartment,lines:[{accountId:f.org.accounts.cogs,amount:'12'}]};
  const bill=await withOrgContext(f.org.orgId,()=>createDocument({orgId:f.org.orgId,userId:f.actorId,kind:'vendor_bill',key:randomUUID(),body:billBody,subsidiaryId:f.org.subsidiaryId,requestBody:billBody}));
  const submitted=await withOrgContext(f.org.orgId,()=>submitAndReleaseIfUngated('vendor_bill',bill.id,f.actorId));
  assert.equal(submitted.autoApproved,true,'the fixture has no vendor-bill approval policy; the native ungated release must succeed');
  const billEntry=await withOrgContext(f.org.orgId,()=>postDocument(bill.id,{control:{ar:f.org.accounts.ar,ap:f.org.accounts.ap,bank:f.org.accounts.bank}},{audit:{actorId:f.actorId,source:'ui'}}));
  const scopedEntity=randomUUID();await run(tx=>tx.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active) values(${scopedEntity},${f.org.orgId},${f.org.subsidiaryId},'Other service owner','CAD','CA',true) returning id`));
  const center=(await run(tx=>tx.execute<{id:string}>(sql`select work_center_id as id from mfg_wo_operations where org_id=${f.org.orgId} and id=${operation}`))).rows[0]!.id;
  await run(tx=>updateWorkCenter(tx,f.org.orgId,f.actorId,center,{subsidiaryId:f.org.subsidiaryId}));
  await run(tx=>tx.execute(sql`update app_roles set subsidiary_restriction=${JSON.stringify({mode:'list',subsidiaryIds:[f.org.subsidiaryId]})}::jsonb where org_id=${f.org.orgId} and id in(select role_id from role_assignments where org_id=${f.org.orgId} and user_id=${f.actorId}) returning id`));
  assert.equal((await run(tx=>searchProductionServiceBills(tx,f.org.orgId,f.actorId,order.id,contract.id,'',bill.id))).some(row=>row.value===bill.id),true);
  await run(tx=>tx.execute(sql`update departments set subsidiary_id=${scopedEntity} where org_id=${f.org.orgId} and id=${serviceDepartment} returning id`));
  const hiddenBill=await counts(f);
  assert(!(await run(tx=>searchProductionServiceBills(tx,f.org.orgId,f.actorId,order.id,contract.id,'',bill.id))).some(row=>row.value===bill.id));
  await assert.rejects(run(tx=>capitalizeSubcontractServiceBill(tx,f.org.orgId,f.actorId,contract.id,bill.id,randomUUID())),/not found/i);assert.deepEqual(await counts(f),hiddenBill);
  await run(tx=>tx.execute(sql`update departments set subsidiary_id=${f.org.subsidiaryId} where org_id=${f.org.orgId} and id=${serviceDepartment} returning id`));
  const key=randomUUID();
  const service=await run(tx=>capitalizeSubcontractServiceBill(tx,f.org.orgId,f.actorId,contract.id,bill.id,key));
  assert.equal(service.amount,'12.0000');assert(service.entryId);assert.equal(await wip(f,order.number),'21.0000');
  const serviceCounts=await counts(f);assert.equal((await run(tx=>capitalizeSubcontractServiceBill(tx,f.org.orgId,f.actorId,contract.id,bill.id,key))).replayed,true);assert.deepEqual(await counts(f),serviceCounts);
  await run(tx=>tx.execute(sql`update departments set subsidiary_id=${scopedEntity} where org_id=${f.org.orgId} and id=${serviceDepartment} returning id`));
  await assert.rejects(run(tx=>capitalizeSubcontractServiceBill(tx,f.org.orgId,f.actorId,contract.id,bill.id,key)),/not found/i);assert.deepEqual(await counts(f),serviceCounts);
  await run(tx=>tx.execute(sql`update departments set subsidiary_id=${f.org.subsidiaryId} where org_id=${f.org.orgId} and id=${serviceDepartment} returning id`));
  const final={id:randomUUID(),quantity:'2',finish:true,consumption:[{shipmentId:sent.id,quantity:'2'}]};
  const returned=await run(tx=>recordSubcontractReturn(tx,f.org.orgId,f.actorId,contract.id,final));
  assert.equal(returned.quantityReturned,'3.0000');assert.equal(returned.status,'received');assert.equal(await wip(f,order.number),'30.0000');
  const finishedCounts=await counts(f);assert.equal((await run(tx=>recordSubcontractReturn(tx,f.org.orgId,f.actorId,contract.id,final))).replayed,true);assert.deepEqual(await counts(f),finishedCounts);
  const unusedRequest={id:randomUUID(),shipmentId:sent.id,date:f.postingDate,reason:'Unused components returned after coating'};
  const unused=await run(tx=>returnSubcontractComponents(tx,f.org.orgId,f.actorId,contract.id,unusedRequest));
  assert.equal(unused.quantity,'2.0000');assert.equal(unused.value,'9.0000');assert.equal(await wip(f,order.number),'30.0000');
  const unusedCounts=await counts(f);assert.equal((await run(tx=>returnSubcontractComponents(tx,f.org.orgId,f.actorId,contract.id,unusedRequest))).replayed,true);assert.deepEqual(await counts(f),unusedCounts);
  const vendorStock=await run(tx=>getOnHandWith(tx,f.org.orgId,f.org.items.component,custody,{subsidiaryId:f.org.subsidiaryId}));assert.equal(vendorStock.quantity,'0.0000');
  const receipt=await run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,order.id,{quantity:'3'}));assert.equal(receipt.value,'30.0000');assert.equal(await wip(f,order.number),'0.0000');
  await refuse(run(tx=>reverseSubcontractServiceCost(tx,f.org.orgId,f.actorId,contract.id,key,f.postingDate,'Correct the vendor service invoice')),'subcontract_service_after_receipt','goods');
  const output=(await run(tx=>tx.execute<{id:string}>(sql`select id from inventory_movements where org_id=${f.org.orgId} and journal_entry_id=${receipt.entryId} and kind='assembly_build'`))).rows[0]!.id;
  await withBypassContext(()=>reverseInventoryMovement(f.org.orgId,f.actorId,output,f.postingDate,'Reverse completed goods before correcting vendor cost'));
  assert.equal(await wip(f,order.number),'30.0000');
  const reversed=await run(tx=>reverseSubcontractServiceCost(tx,f.org.orgId,f.actorId,contract.id,key,f.postingDate,'Correct the vendor service invoice'));assert(reversed.entryId);assert.equal(await wip(f,order.number),'18.0000');
  await refuse(run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,order.id,{quantity:'3'})),'subcontract_service_cost_required','service');
  const source=(await run(tx=>tx.execute<{status:string}>(sql`select status from journal_entries where org_id=${f.org.orgId} and id=${billEntry}`))).rows[0]!;assert.equal(source.status,'posted','capitalization reversal does not rewrite the AP liability or bill');
  const read=await run(tx=>readSubcontractWorkspace(tx,f.org.orgId,f.actorId,order.id,contract.id));assert.equal(read.selected?.returned,'3.0000');assert.equal(read.selected?.serviceRecorded,false);
  await run(tx=>tx.execute(sql`update app_roles set permissions='["manufacturing.read","items.read"]'::jsonb where org_id=${f.org.orgId} and id in(select role_id from role_assignments where org_id=${f.org.orgId} and user_id=${f.actorId}) returning id`));
  const revokedCounts=await counts(f);for(const command of [()=>run(tx=>recordSubcontractReturn(tx,f.org.orgId,f.actorId,contract.id,final)),()=>run(tx=>returnSubcontractComponents(tx,f.org.orgId,f.actorId,contract.id,unusedRequest)),()=>run(tx=>capitalizeSubcontractServiceBill(tx,f.org.orgId,f.actorId,contract.id,bill.id,key)),()=>run(tx=>reverseSubcontractServiceCost(tx,f.org.orgId,f.actorId,contract.id,key,f.postingDate,'Correct the vendor service invoice'))])await assert.rejects(command());assert.deepEqual(await counts(f),revokedCounts);
}});


async function jointOutputScenario(f:Fixture,standard:boolean) {
 const output=standard?f.org.items.standard:f.org.items.movingAvg;
 await run(async tx=>{
  await tx.execute(sql`insert into bom_components(org_id,assembly_item_id,component_item_id,quantity_per,sort_order,is_byproduct,output_cost_weight)
    values(${f.org.orgId},${f.org.items.assembly},${output},'1',10,true,'2'),(${f.org.orgId},${f.org.items.assembly},${f.org.items.fifo},'1',11,true,null) returning id`);
  await tx.execute(sql`update items set default_rate='0.5' where org_id=${f.org.orgId} and id=${f.org.items.fifo} returning id`);
  if(standard)await tx.execute(sql`update item_inventory_profiles set standard_cost='3' where org_id=${f.org.orgId} and item_id=${output} returning id`);
 });
 const order=await prepare(f,{quantity:'2'});await stock(f,f.org.items.component,'4','3');await issue(f,order.id,[{materialId:order.materials[0]!.id,quantity:'4'}]);
 const frozen=(await run(tx=>tx.execute<{weight:string;standard:string|null}>(sql`select output_cost_weight::text as weight,standard_cost_snapshot::text as standard from mfg_wo_byproducts where org_id=${f.org.orgId} and work_order_id=${order.id} and item_id=${output}`))).rows[0]!;
 assert.equal(frozen.weight,'2.0000');assert.equal(frozen.standard,standard?'3.0000':null);
 await assert.rejects(run(tx=>tx.execute(sql`update mfg_wo_byproducts set output_cost_weight='8' where org_id=${f.org.orgId} and work_order_id=${order.id} and item_id=${output} returning id`)),/Released|immutable/i);
 await assert.rejects(run(tx=>tx.execute(sql`update bom_components set output_cost_weight='8' where org_id=${f.org.orgId} and assembly_item_id=${f.org.items.assembly} and component_item_id=${output} returning id`)),/approved revision/i);
 const unchanged=await counts(f);
 await assert.rejects(run(tx=>tx.execute(sql`insert into mfg_wo_byproducts(org_id,work_order_id,item_id,quantity_per,output_cost_weight) values(${f.org.orgId},${order.id},${standard?f.org.items.movingAvg:f.org.items.standard},'1','1') returning id`)),/released production definition/i);
 assert.deepEqual(await counts(f),unchanged);
 if(standard)await run(tx=>tx.execute(sql`update item_inventory_profiles set standard_cost='9' where org_id=${f.org.orgId} and item_id=${output} returning id`));
 const invalidState=await counts(f);
 await assert.rejects(run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,order.id,{quantity:'1',byproductValues:[{itemId:output,nrvUnit:'1',reason:'Attempt to overwrite joint allocation'}]})),/not an NRV by-product/i);
 assert.deepEqual(await counts(f),invalidState);
 const input={quantity:'1'},firstKey=randomUUID();
 const first=await withBypassContext(()=>executeManufacturingReceipt(f.org.orgId,f.actorId,null,order.id,firstKey,input));
 assert.equal(first.value.value,'1.8333');assert.equal(first.value.relievedWip,'6.0000');assert.equal(await wip(f,order.number),'6.0000');
 const firstState=await counts(f);await withBypassContext(()=>executeManufacturingReceipt(f.org.orgId,f.actorId,null,order.id,firstKey,input));assert.deepEqual(await counts(f),firstState);
 const final=await withBypassContext(()=>executeManufacturingReceipt(f.org.orgId,f.actorId,null,order.id,randomUUID(),input));assert.equal(final.value.value,'1.8333');assert.equal(await wip(f,order.number),'0.0000');
 const outputStock=await withBypassContext(()=>getOnHandWith(db,f.org.orgId,output,f.org.stockLocationId2,{subsidiaryId:f.org.subsidiaryId}));
 assert.equal(outputStock.quantity,'2.0000');assert.equal(outputStock.value,standard?'6.0000':'7.3334');
 const balance=(await run(tx=>readManufacturingRecord(tx,f.org.orgId,null,'work-orders',order.id,f.actorId))).sections.materialBalance!;
 assert.equal(balance.reduce((sum,row)=>add(sum,String(row.inputQuantity)),'0'),'4.0000');
 assert.equal(balance.reduce((sum,row)=>add(sum,String(row.outputQuantity)),'0'),'6.0000');
 for(const entryId of [first.value.entryId,final.value.entryId]) {
  const evidence=(await run(tx=>tx.execute<{custom:{jointOutputCosts:Array<{actualValue:string;receiptValue:string}>};balance:string}>(sql`select entry.custom,(select sum(amount)::text from journal_lines where org_id=entry.org_id and entry_id=entry.id) as balance from journal_entries entry where entry.org_id=${f.org.orgId} and entry.id=${entryId}`))).rows[0]!;
  assert.equal(evidence.balance,'0.0000');assert.equal(evidence.custom.jointOutputCosts[0]?.actualValue,'3.6667');assert.equal(evidence.custom.jointOutputCosts[0]?.receiptValue,standard?'3.0000':'3.6667');
 }
 const main=(await run(tx=>tx.execute<{id:string}>(sql`select id from inventory_movements where org_id=${f.org.orgId} and journal_entry_id=${final.value.entryId} and item_id=${f.org.items.assembly} and kind='assembly_build'`))).rows[0]!;
 await withBypassContext(()=>reverseMaterialIssue(f.org.orgId,f.actorId,{movementId:main.id,reversalDate:f.postingDate,reason:'Correct all outputs of the second production receipt'}));
 assert.equal(await wip(f,order.number),'6.0000');
 const retained=await withBypassContext(()=>getOnHandWith(db,f.org.orgId,output,f.org.stockLocationId2,{subsidiaryId:f.org.subsidiaryId}));assert.equal(retained.quantity,'1.0000');assert.equal(retained.value,standard?'3.0000':'3.6667');
 const correctedBalance=(await run(tx=>readManufacturingRecord(tx,f.org.orgId,null,'work-orders',order.id,f.actorId))).sections.materialBalance!;
 assert.equal(correctedBalance.reduce((sum,row)=>add(sum,String(row.inputQuantity)),'0'),'4.0000');
 assert.equal(correctedBalance.reduce((sum,row)=>add(sum,String(row.outputQuantity)),'0'),'3.0000');
}
cases.push({name:'joint and NRV outputs conserve actual cost across partial receipts, replay and governed whole-receipt reversal',run:f=>jointOutputScenario(f,false)});
cases.push({name:'joint output standard valuation retains the released standard and posts its exact production variance',run:f=>jointOutputScenario(f,true)});
cases.push({name:'standard roll-up allocates joint production cost without inventing an NRV credit or revising released standards',run:async f=>{
 await run(tx=>tx.execute(sql`insert into bom_components(org_id,assembly_item_id,component_item_id,quantity_per,sort_order,is_byproduct,output_cost_weight)
   values(${f.org.orgId},${f.org.items.standard},${f.org.items.fifo},'1',10,true,'1') returning id`));
 const order=await conversionOrder(f,f.org.items.standard);
 await run(tx=>tx.execute(sql`update item_inventory_profiles set standard_cost='3' where org_id=${f.org.orgId} and item_id=${f.org.items.component} returning id`));
 const preview=await run(tx=>previewStandardRollup(tx,f.org.orgId,f.actorId,{itemId:f.org.items.standard,subsidiaryId:f.org.subsidiaryId,onDate:f.postingDate,batchQuantity:'10'}));
 assert.equal(preview.material,'60.0000');assert.equal(preview.byproductCredit,'0.0000');assert.equal(preview.jointPool,'107.0000');
 assert.equal(preview.total,'53.5000');assert.equal(preview.standardCost,'5.3500');assert.equal(preview.jointOutputCosts[0]?.amount,'53.5000');
 assert.equal((await run(tx=>getWorkOrder(tx,f.org.orgId,order.id)))?.standardCostSnapshot,'2.0000');
}});

cases.push({name:'same-transaction repeated inspections use native sequence rather than request UUID order for coverage',run:async f=>{
 await inspectionPlan(f,f.org.items.assembly,'operation');
 const order=await prepare(f,{quantity:'2'});await stock(f,f.org.items.component,'4','3');await issue(f,order.id,[{materialId:order.materials[0]!.id,quantity:'4'}]);
 const operation=(await run(tx=>tx.execute<{id:string}>(sql`select id from mfg_wo_operations where org_id=${f.org.orgId} and work_order_id=${order.id}`))).rows[0]!;
 await run(tx=>startWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,operation.id));
 const initial=(await run(tx=>tx.execute<{id:string}>(sql`select id from inventory_inspections where org_id=${f.org.orgId} and operation_id=${operation.id}`))).rows[0]!;
 await run(tx=>recordQualityInspection(tx,f.org.orgId,f.actorId,initial.id,{outcome:'pass',quantity:'2',measurements:{length:'10'},reason:'Initial batch acceptance'}));
 const earlier='ffffffff-ffff-4fff-8fff-ffffffffffff',later='00000000-0000-4000-8000-000000000001';
 await run(async tx=>{
  for(const [id,quantity] of [[earlier,'2'],[later,'1']] as const) {
   await createOperationInspection(tx,f.org.orgId,f.actorId,order.id,operation.id,{id,quantity});
   await recordQualityInspection(tx,f.org.orgId,f.actorId,id,{outcome:'pass',quantity,measurements:{length:'10'},reason:'Record current accepted quantity for this batch'});
  }
 });
 const ordering=(await run(tx=>tx.execute<{sequence:number;createdAt:string}>(sql`select inspection_sequence as sequence,created_at::text as "createdAt" from inventory_inspections where org_id=${f.org.orgId} and id in(${earlier},${later}) order by inspection_sequence`))).rows;
 assert.deepEqual(ordering.map(row=>row.sequence),[2,3]);assert.equal(ordering[0]?.createdAt,ordering[1]?.createdAt);
 const before=await counts(f);
 await assert.rejects(run(tx=>completeWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,operation.id,{doneQty:'2',actualSetupMinutes:'0',actualRunMinutes:'0',actualLaborMinutes:'0'})),/accepted inspections covering/i);
 assert.deepEqual(await counts(f),before);
 await assert.rejects(run(tx=>tx.execute(sql`update inventory_inspections set inspection_sequence=4 where org_id=${f.org.orgId} and id=${later} returning id`)),/immutable/i);
 const final=await run(tx=>createOperationInspection(tx,f.org.orgId,f.actorId,order.id,operation.id,{id:randomUUID(),quantity:'2'}));assert(final);
 await run(tx=>recordQualityInspection(tx,f.org.orgId,f.actorId,final.id,{outcome:'pass',quantity:'2',measurements:{length:'10'},reason:'Final accepted quantity covers the batch'}));
 await run(tx=>completeWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,operation.id,{doneQty:'2',actualSetupMinutes:'0',actualRunMinutes:'0',actualLaborMinutes:'0'}));
 await run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,order.id,{quantity:'2'}));assert.equal(await wip(f,order.number),'0.0000');
}});

cases.push({name:'required operation inspections cover multiple serials without counting repeated inspections twice',run:async f=>{
 await run(tx=>tx.execute(sql`update item_inventory_profiles set tracking='serial' where org_id=${f.org.orgId} and item_id=${f.org.items.assembly} returning id`));
 await inspectionPlan(f,f.org.items.assembly,'operation');
 const order=await prepare(f,{quantity:'2'});await stock(f,f.org.items.component,'4','3');await issue(f,order.id,[{materialId:order.materials[0]!.id,quantity:'4'}]);
 const operation=(await run(tx=>tx.execute<{id:string}>(sql`select id from mfg_wo_operations where org_id=${f.org.orgId} and work_order_id=${order.id}`))).rows[0]!;
 await run(tx=>startWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,operation.id));
 const first=(await run(tx=>tx.execute<{id:string}>(sql`select id from inventory_inspections where org_id=${f.org.orgId} and operation_id=${operation.id}`))).rows[0]!;
 const serial=await run(tx=>registerInspectionIdentifier(tx,f.org.orgId,f.actorId,first.id,{kind:'serial',number:'INSPECTED-SERIAL-1'}));
 await run(tx=>recordQualityInspection(tx,f.org.orgId,f.actorId,first.id,{outcome:'pass',measurements:{length:'10'},quantity:'1',serialId:serial.id,reason:'First produced serial meets acceptance limits'}));
 assert.equal((await run(tx=>readManufacturingInspection(tx,f.org.orgId,f.actorId,first.id))).canFollowup,true);
 const repeated=await run(tx=>createOperationInspection(tx,f.org.orgId,f.actorId,order.id,operation.id,{id:randomUUID(),quantity:'1'}));assert(repeated);
 assert.equal((await run(tx=>readManufacturingInspection(tx,f.org.orgId,f.actorId,first.id))).canFollowup,false);
 await run(tx=>recordQualityInspection(tx,f.org.orgId,f.actorId,repeated.id,{outcome:'pass',measurements:{length:'10'},quantity:'1',serialId:serial.id,reason:'Repeat inspection confirms the same unit'}));
 const completion={doneQty:'2',actualSetupMinutes:'0',actualRunMinutes:'0',actualLaborMinutes:'0'};
 const before=await counts(f);
 await assert.rejects(run(tx=>completeWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,operation.id,completion)),/accepted inspections covering/i);
 assert.deepEqual(await counts(f),before);
 const second=await run(tx=>createOperationInspection(tx,f.org.orgId,f.actorId,order.id,operation.id,{id:randomUUID(),quantity:'1'}));assert(second);
 const secondSerial=await run(tx=>registerInspectionIdentifier(tx,f.org.orgId,f.actorId,second.id,{kind:'serial',number:'INSPECTED-SERIAL-2'}));
 await run(tx=>recordQualityInspection(tx,f.org.orgId,f.actorId,second.id,{outcome:'pass',measurements:{length:'10'},quantity:'1',serialId:secondSerial.id,reason:'Second produced serial meets acceptance limits'}));
 await run(tx=>completeWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,operation.id,completion));
 assert.equal((await run(tx=>readManufacturingInspection(tx,f.org.orgId,f.actorId,second.id))).canFollowup,false);
 const ready=await counts(f);
 await assert.rejects(run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,order.id,{quantity:'1',lots:[{quantity:'1',serialNumber:'UNINSPECTED-SERIAL'}]})),/accepted operation inspections/i);
 assert.deepEqual(await counts(f),ready);
 const partial=await run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,order.id,{quantity:'1',lots:[{quantity:'1',serialNumber:'INSPECTED-SERIAL-1'}]}));
 assert.equal(partial.quantityCompleted,'1.0000');assert.equal(await wip(f,order.number),'6.0000');
 const final=await run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,order.id,{quantity:'1',lots:[{quantity:'1',serialNumber:'INSPECTED-SERIAL-2'}]}));
 assert.equal(final.quantityCompleted,'2.0000');assert.equal(await wip(f,order.number),'0.0000');
}});

cases.push({name:'masked and full native clones retain frozen costing, inspection identity and governed revision replay',run:async f=>{
 await run(tx=>tx.execute(sql`update item_inventory_profiles set tracking='lot' where org_id=${f.org.orgId} and item_id=${f.org.items.assembly} returning id`));
 await inspectionPlan(f,f.org.items.assembly,'operation');await inspectionPlan(f,f.org.items.assembly,'receipt');
 const order=await prepare(f);await stock(f,f.org.items.component,'2','3');await issue(f,order.id,[{materialId:order.materials[0]!.id,quantity:'2'}]);
 const operation=(await run(tx=>tx.execute<{id:string}>(sql`select id from mfg_wo_operations where org_id=${f.org.orgId} and work_order_id=${order.id}`))).rows[0]!;
 await run(tx=>startWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,operation.id));
 const inspection=(await run(tx=>tx.execute<{id:string}>(sql`select id from inventory_inspections where org_id=${f.org.orgId} and operation_id=${operation.id}`))).rows[0]!;
 const lot=await run(tx=>registerInspectionIdentifier(tx,f.org.orgId,f.actorId,inspection.id,{kind:'lot',number:'CLONE-FINISHED'}));
 const pendingState=await counts(f);
 await assert.rejects(run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,order.id,{quantity:'1',lots:[{quantity:'1',lotNumber:'CLONE-FINISHED'}]})),/required operation inspection/i);
 assert.deepEqual(await counts(f),pendingState);
 await run(tx=>recordQualityInspection(tx,f.org.orgId,f.actorId,inspection.id,{outcome:'pass',measurements:{length:'10'},quantity:'1',lotId:lot.id,reason:'Finished stock meets dimensional limits'}));
 await run(tx=>completeWorkOrderOperation(tx,f.org.orgId,f.actorId,order.id,operation.id,{doneQty:'1',actualSetupMinutes:'0',actualRunMinutes:'0',actualLaborMinutes:'0'}));
 const acceptedState=await counts(f);
 for(const receipt of [{quantity:'1',lots:[{quantity:'1',lotNumber:'UNINSPECTED-FINISHED'}]},{quantity:'1.01',lots:[{quantity:'1.01',lotNumber:'CLONE-FINISHED'}]}]) {
  await assert.rejects(run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,order.id,receipt)),/accepted operation inspections/i);
  assert.deepEqual(await counts(f),acceptedState,'inspection identity and coverage refusals roll back registration and all posting writes');
 }
 assert.equal((await run(tx=>tx.execute(sql`select id from lots where org_id=${f.org.orgId} and lot_number='UNINSPECTED-FINISHED'`))).rows.length,0);
 await run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,order.id,{quantity:'1',lots:[{quantity:'1',lotNumber:'CLONE-FINISHED'}]}));
 const sourceReceipt=(await run(tx=>tx.execute<{id:string}>(sql`select id from inventory_inspections where org_id=${f.org.orgId} and item_id=${f.org.items.assembly} and receipt_movement_id is not null`))).rows[0]!;
 const deviation=await trackedQualityReceipt(f,f.org.items.fifo);
 await run(tx=>recordQualityInspection(tx,f.org.orgId,f.actorId,deviation.inspection.id,{outcome:'fail',measurements:{length:'10.2'},reason:'Customer-specific inspector observation'}));
 const dispositionInput={action:'use_as_is' as const,reason:'Customer-specific engineering acceptance',requestKey:randomUUID()};
 await run(tx=>disposeQualityInspection(tx,f.org.orgId,f.actorId,deviation.inspection.id,dispositionInput));
 const lifecycleAuthority={systemReason:'Verify native production clone continuity'};
 for(const masked of [false,true]) {
  let sandboxId:string|null=null;
  try {
   const cloned=await withBypassContext(()=>createSandbox({productionOrgId:f.org.orgId,name:'Production continuity '+randomUUID(),tier:'full',masked,lifecycleAuthority}));sandboxId=cloned.sandboxId;
   const rebased=(await run(tx=>tx.execute<{actorId:string;workOrderId:string;inspectionId:string;operationId:string;lotId:string;subsidiaryId:string;receiptId:string}>(sql`select ob_rebase(${f.actorId}::uuid,sandbox_seed) as "actorId",ob_rebase(${order.id}::uuid,sandbox_seed) as "workOrderId",ob_rebase(${inspection.id}::uuid,sandbox_seed) as "inspectionId",ob_rebase(${operation.id}::uuid,sandbox_seed) as "operationId",ob_rebase(${lot.id}::uuid,sandbox_seed) as "lotId",ob_rebase(${f.org.subsidiaryId}::uuid,sandbox_seed) as "subsidiaryId",ob_rebase(${sourceReceipt.id}::uuid,sandbox_seed) as "receiptId" from orgs where id=${cloned.sandboxOrgId}`))).rows[0]!;
   const deviationId=(await run(tx=>tx.execute<{id:string}>(sql`select ob_rebase(${deviation.inspection.id}::uuid,sandbox_seed) as id from orgs where id=${cloned.sandboxOrgId}`))).rows[0]!.id;
   const clonedDeviation=await run(tx=>loadInspection(tx,cloned.sandboxOrgId,deviationId));
   const disposition=clonedDeviation.dispositionResult!;
   const intent=disposition.intent as {action:'use_as_is';reason:string};
   assert.equal(intent.action,'use_as_is');assert.equal(intent.reason,masked?'REDACTED':dispositionInput.reason);
   assert.notEqual(disposition.requestKey,dispositionInput.requestKey,'disposition request identity belongs to its cloned organization');
   const deviationState=()=>run(async tx=>(await tx.execute(sql`select (select count(*) from inventory_movements where org_id=${cloned.sandboxOrgId}) as movements,(select count(*) from journal_entries where org_id=${cloned.sandboxOrgId}) as entries,(select count(*) from audit_log where org_id=${cloned.sandboxOrgId}) as audits`)).rows[0]);
   const retained=await deviationState();
   await run(tx=>disposeQualityInspection(tx,cloned.sandboxOrgId,rebased.actorId,deviationId,{...intent,requestKey:String(disposition.requestKey)}));
   assert.deepEqual(await deviationState(),retained,'a disposition replays after native rebasing and prose masking without new postings or audit writes');
   if(masked)assert(!JSON.stringify(clonedDeviation).includes('Customer-specific'));
   const detail=await run(tx=>readManufacturingRecord(tx,cloned.sandboxOrgId,null,'work-orders',rebased.workOrderId,rebased.actorId));
   assert.equal(detail.record.quantityCompleted,'1.0000');assert.equal(detail.sections.receipts?.[0]?.lotId,rebased.lotId);
   const frozen=(await run(tx=>tx.execute<{burden:unknown;burdenHash:string;overhead:unknown;overheadHash:string;plan:Record<string,unknown>}>(sql`select standard_labor_burden as burden,standard_labor_burden_hash as "burdenHash",overhead_snapshot as overhead,overhead_snapshot_hash as "overheadHash",inspection_plan_snapshot as plan from mfg_wo_operations where org_id=${cloned.sandboxOrgId} and id=${rebased.operationId}`))).rows[0]!;
   for(const [document,fingerprint] of [[frozen.burden,frozen.burdenHash],[frozen.overhead,frozen.overheadHash]] as const)if(document)assert.equal(fingerprint,'sha256:'+createHash('sha256').update(canonicalJson(document)).digest('hex'));
   const accepted=await run(tx=>readManufacturingInspection(tx,cloned.sandboxOrgId,rebased.actorId,rebased.inspectionId));
   assert.equal(accepted.status,'pass');assert.equal(accepted.lotId,rebased.lotId);assert.deepEqual(accepted.planSnapshot,frozen.plan);
   if(masked)assert.equal(accepted.planSnapshot.name,'REDACTED');
   const posted=(await run(tx=>tx.execute<{custom:Record<string,unknown>}>(sql`select custom from journal_entries where org_id=${cloned.sandboxOrgId} and origin='manufacturing' and custom ? 'completion_quantity' and status='posted'`))).rows[0]!;
   assert.equal(posted.custom.work_order_number,order.number);assert.equal(posted.custom.completion_quantity,'1.0000');
   const change=(await run(tx=>tx.execute<{id:string}>(sql`select id from financial_changes where org_id=${cloned.sandboxOrgId} and domain='manufacturing' and status='applied' and operation='routing_revision_activation'`))).rows[0];
   assert(change);const replay=await withBypassContext(()=>applyRoutingActivation(cloned.sandboxOrgId,rebased.actorId,change.id));assert.equal(replay.id,detail.record.routingId);
   await run(tx=>recordQualityInspection(tx,cloned.sandboxOrgId,rebased.actorId,rebased.receiptId,{outcome:'pass',measurements:{length:'10'},reason:'Cloned receipt retains enforceable criteria'}));
   assert.equal((await run(tx=>loadInspection(tx,cloned.sandboxOrgId,rebased.receiptId))).status,'pass');
   assert.equal((await run(tx=>loadInspection(tx,f.org.orgId,sourceReceipt.id))).status,'pending','a clone never changes its source inspection');
  } finally {if(sandboxId)await withBypassContext(()=>deleteSandbox(sandboxId!,lifecycleAuthority));}
 }
}});

cases.push({name:'recorded receipt input batches preserve exact split lineage, refuse overassignment and free reversed claims without changing audit history',run:async f=>{
 await run(tx=>tx.execute(sql`update item_inventory_profiles set tracking='lot' where org_id=${f.org.orgId} and item_id in(${f.org.items.component},${f.org.items.assembly}) returning id`));
 const lotA=await withBypassContext(()=>ensureLot(f.org.orgId,f.org.items.component,'RECORDED-A',null,f.actorId)),lotB=await withBypassContext(()=>ensureLot(f.org.orgId,f.org.items.component,'RECORDED-B',null,f.actorId));
 for(const lotId of [lotA,lotB])await withBypassContext(()=>receiveInventory(f.org.orgId,f.actorId,{itemId:f.org.items.component,stockLocationId:f.org.stockLocationId,quantity:'2',unitCost:'3',lotId,subsidiaryId:f.org.subsidiaryId,offsetAccountId:f.org.accounts.clearing,date:f.postingDate}));
 const order=await prepare(f,{quantity:'2'});
 await run(tx=>issueMaterials(tx,f.org.orgId,f.actorId,order.id,[{materialId:order.materials[0]!.id,quantity:'2',lotId:lotA},{materialId:order.materials[0]!.id,quantity:'2',lotId:lotB}]));
 const issues=(await run(tx=>readManufacturingRecord(tx,f.org.orgId,null,'work-orders',order.id,f.actorId))).sections.issues!;
 const a=issues.find(row=>row.lotId===lotA)!,b=issues.find(row=>row.lotId===lotB)!;
 const firstInput={quantity:'1',lots:[{quantity:'1',lotNumber:'OBSERVED-A'}],componentSelections:[{movementId:a.id,quantity:'2'}]},firstKey=randomUUID();
 const first=await withBypassContext(()=>executeManufacturingReceipt(f.org.orgId,f.actorId,null,order.id,firstKey,firstInput)),afterFirst=await counts(f);
 assert.deepEqual((await withBypassContext(()=>executeManufacturingReceipt(f.org.orgId,f.actorId,null,order.id,firstKey,firstInput))).value,first.value);assert.deepEqual(await counts(f),afterFirst);
 await assert.rejects(withBypassContext(()=>executeManufacturingReceipt(f.org.orgId,f.actorId,null,order.id,randomUUID(),{quantity:'1',lots:[{quantity:'1',lotNumber:'INVALID-ASSIGNMENT'}],componentSelections:[{movementId:a.id,quantity:'1'},{movementId:b.id,quantity:'2'}]})),/unavailable or already assigned/);assert.deepEqual(await counts(f),afterFirst);
 const finalInput={quantity:'1',lots:[{quantity:'1',lotNumber:'OBSERVED-B'}],componentSelections:[{movementId:b.id,quantity:'2'}]},finalKey=randomUUID();
 const final=await withBypassContext(()=>executeManufacturingReceipt(f.org.orgId,f.actorId,null,order.id,finalKey,finalInput));
 const forwardA=await run(tx=>traceManufacturingGenealogy(tx,f.org.orgId,f.actorId,{kind:'lot',id:lotA,direction:'forward'}));
 assert(JSON.stringify(forwardA).includes('OBSERVED-A'));assert(!JSON.stringify(forwardA).includes('OBSERVED-B'));
 const frozen=(await run(tx=>tx.execute(sql`select id,allocation_basis,quantity::text from mfg_completion_batches where org_id=${f.org.orgId} and work_order_id=${order.id} order by id`))).rows;assert.equal(frozen.length,2);assert(frozen.every(row=>row.allocation_basis==='recorded'));
 const movement=(await run(tx=>tx.execute<{id:string}>(sql`select id from inventory_movements where org_id=${f.org.orgId} and journal_entry_id=${final.value.entryId} and kind='assembly_build'`))).rows[0]!;
 await withBypassContext(()=>reverseMaterialIssue(f.org.orgId,f.actorId,{movementId:movement.id,reversalDate:f.postingDate,reason:'Correct the second recorded receipt batch'}));
 assert.deepEqual((await run(tx=>tx.execute(sql`select id,allocation_basis,quantity::text from mfg_completion_batches where org_id=${f.org.orgId} and work_order_id=${order.id} order by id`))).rows,frozen);
 const afterReversal=await counts(f);await withBypassContext(()=>executeManufacturingReceipt(f.org.orgId,f.actorId,null,order.id,finalKey,finalInput));assert.deepEqual(await counts(f),afterReversal,'an original request replay retains its reversed history instead of inventing replacement output');
 await withBypassContext(()=>executeManufacturingReceipt(f.org.orgId,f.actorId,null,order.id,randomUUID(),{...finalInput,lots:[{quantity:'1',lotNumber:'OBSERVED-B-CORRECTED'}]}));assert.equal(await wip(f,order.number),'0.0000');
 const forwardB=await run(tx=>traceManufacturingGenealogy(tx,f.org.orgId,f.actorId,{kind:'lot',id:lotB,direction:'forward'}));assert(JSON.stringify(forwardB).includes('OBSERVED-B-CORRECTED'));assert(!JSON.stringify(forwardB).includes('OBSERVED-A'));
}});

cases.push({name:'continuous process runs require a bounded window, retain their campaign and revisions, and preserve native scope on reads',run:async f=>{
  await route(f,f.org.items.assembly);
  const base={producedItemId:f.org.items.assembly,quantityOrdered:'2',subsidiaryId:f.org.subsidiaryId,operatingProfile:'batch_process',productionMode:'continuous' as const,campaignReference:'WEEK-ONE'};
  const before=await counts(f);
  await refuse(run(tx=>createWorkOrder(tx,f.org.orgId,f.actorId,base)),'production_run_window_required','bounded');assert.deepEqual(await counts(f),before);
  await refuse(run(tx=>createWorkOrder(tx,f.org.orgId,f.actorId,{...base,operatingProfile:'discrete_production',plannedStart:f.postingDate,plannedEnd:f.postingDate})),'production_run_style_required','process');assert.deepEqual(await counts(f),before);
  const order=await run(tx=>createWorkOrder(tx,f.org.orgId,f.actorId,{...base,plannedStart:f.postingDate,plannedEnd:addCalendarDays(f.postingDate,1)}));
  assert.equal(order.productionMode,'continuous');assert.equal(order.campaignReference,'WEEK-ONE');
  const updated=await run(tx=>updateDraftWorkOrder(tx,f.org.orgId,f.actorId,order.id,{campaignReference:'WEEK-TWO'}));assert.equal(updated.campaignReference,'WEEK-TWO');
  await run(tx=>releaseWorkOrder(tx,f.org.orgId,f.actorId,order.id));
  await assert.rejects(run(tx=>tx.execute(sql`update mfg_work_orders set campaign_reference='REWRITE' where org_id=${f.org.orgId} and id=${order.id} returning id`)),/Released work retains/);
  await assert.rejects(run(tx=>tx.execute(sql`update mfg_work_orders set planned_end=planned_end+1 where org_id=${f.org.orgId} and id=${order.id} returning id`)),/Released work retains/);
  const projected=await run(tx=>readManufacturingRecord(tx,f.org.orgId,null,'work-orders',order.id,f.actorId));assert.equal(projected.record.productionMode,'continuous');assert.equal(projected.record.campaignReference,'WEEK-TWO');
  const matching=await run(tx=>listManufacturingRecords(tx,f.org.orgId,null,'work-orders',{q:'WEEK-TWO'},f.actorId));assert.equal(matching.rows.length,1);assert.equal(matching.rows[0]?.id,order.id);
  await assert.rejects(run(tx=>readManufacturingRecord(tx,f.org.orgId,new Set(),'work-orders',order.id,f.actorId)));assert.equal((await run(tx=>listManufacturingRecords(tx,f.org.orgId,new Set(),'work-orders',{q:'WEEK-TWO'},f.actorId))).total,0);
 }});

cases.push({name:'tracked low-value output apportions every ledger unit without a negative final serial layer',run:async f=>{
 await run(tx=>tx.execute(sql`update bom_components set quantity_per='0.5',operation_seq=null where org_id=${f.org.orgId} and assembly_item_id=${f.org.items.assembly} returning id`));
 await run(tx=>tx.execute(sql`update item_inventory_profiles set tracking='serial' where org_id=${f.org.orgId} and item_id=${f.org.items.assembly} returning id`));
 await stock(f,f.org.items.component,'2','0.0001');await route(f,f.org.items.assembly);
 const order=await run(tx=>createWorkOrder(tx,f.org.orgId,f.actorId,{producedItemId:f.org.items.assembly,quantityOrdered:'4',subsidiaryId:f.org.subsidiaryId}));
 await run(tx=>releaseWorkOrder(tx,f.org.orgId,f.actorId,order.id));
 const material=(await run(tx=>tx.execute<{id:string}>(sql`select id from mfg_wo_materials where org_id=${f.org.orgId} and work_order_id=${order.id}`))).rows[0]!;
 await issue(f,order.id,[{materialId:material.id,quantity:'2'}]);assert.equal(await wip(f,order.number),'0.0002');
 const receipt=await run(tx=>completeWorkOrder(tx,f.org.orgId,f.actorId,order.id,{quantity:'4',lots:[1,2,3,4].map(index=>({quantity:'1',serialNumber:'LOW-VALUE-'+index}))}));
 assert.equal(receipt.value,'0.0002');assert.equal(await wip(f,order.number),'0.0000');
 const movements=(await run(tx=>tx.execute<{value:string}>(sql`select total_value::text as value from inventory_movements where org_id=${f.org.orgId} and journal_entry_id=${receipt.entryId} and kind='assembly_build' order by id`))).rows;
 assert.equal(movements.length,4);assert.equal(add(add(movements[0]!.value,movements[1]!.value),add(movements[2]!.value,movements[3]!.value)),'0.0002');assert(movements.every(row=>cmp(row.value,'0')>=0));
}});

for (const scenario of cases) {
  test(`manufacturing completion and reversal: ${scenario.name}`, { skip: !DB, concurrency: false }, async () => {
    const f = await setup();
    try { await scenario.run(f); }
    catch (error) { throw new Error(scenario.name + ": " + (error instanceof Error ? error.message : String(error)), { cause: error }); }
    finally { await withBypassContext(() => dropScratchOrg(f.org.orgId)); }
  });
}
