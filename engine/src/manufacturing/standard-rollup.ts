import {resolveMachineRate} from "./conversion.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { businessToday, isIsoCalendarDate } from "../platform/business-date.ts";
import { assertFinancialChangeApproved, completeFinancialChange, loadFinancialChange, proposeFinancialChange, MANUFACTURING_STANDARD_ROLLUP_OPERATION } from "../platform/financial-changes.ts";
import { add, cmp, fromUnits, mul, roundDiv, sum, toUnits } from "../money/money.ts";
import { bomRequiredQuantity, type BomQuantityBasis } from "../inventory/bom-scrap.ts";
import { allocateJointProductionCost } from "../inventory/production-outputs.ts";
import { inventoryRequestHash } from "../inventory/action-idempotency.ts";
import { revalueOpenLayersToStandardCost } from "../inventory/revaluation.ts";
import { subsidiaryCurrency } from "../inventory/position.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { assertManufacturingFeature } from "./gate.ts";
import { lockManufacturingManageAuthority } from "./authority.ts";
import { resolveOperationReleaseSnapshots } from "./work-orders.ts";
import { auditChange, decimalValue } from "./master-support.ts";
import { ManufacturingError, ManufacturingNotFoundError } from "./errors.ts";

export interface StandardRollupInput { itemId: string; subsidiaryId: string; onDate: string; batchQuantity: string }
type CostProfile = { item_id: string; costing_method: string; standard_cost: string | null; asset_account_id: string; variance_account_id: string | null; base_unit: string; revision: string };
const fail = (message: string, code: string, remedy: string): never => { throw new ManufacturingError(message, { code, remedy, status: 409 }); };
const perUnit = (amount: string, quantity: string) => fromUnits(roundDiv(toUnits(amount) * 10_000n, toUnits(quantity)));
const minutesCost = (rate: string, minutes: string) => fromUnits(roundDiv(toUnits(rate) * toUnits(minutes), 600_000n));

async function authority(tx: SqlExecutor, orgId: string, actorId: string, subsidiaryId: string) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const scope = await lockManufacturingManageAuthority(tx, orgId, actorId, subsidiaryId);
  const inventoryScope = await lockActorCommandAuthority(tx, orgId, actorId, subsidiaryId, "items.manage");
  if (scope !== null || inventoryScope !== null) fail("An organization-wide standard requires access to every legal entity.", "rollup_unrestricted_required", "Ask an authorized manufacturing and inventory manager with unrestricted legal-entity access to review the roll-up.");
}

/** A standard is a deliberate policy, not an implicit recalculation during release. */
export async function previewStandardRollup(tx: SqlExecutor, orgId: string, actorId: string, input: StandardRollupInput) {
  if (![input.itemId,input.subsidiaryId].every(id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) throw new ManufacturingNotFoundError();
  await authority(tx, orgId, actorId, input.subsidiaryId);
  // Shared item standards are one organization-wide policy; serialize roll-ups before cross-item profile locks.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`openbooks:manufacturing-standard-rollup:${orgId}`},0))`);
  await lockLedgerSetupFence(tx, orgId, "shared");
  if (!isIsoCalendarDate(input.onDate)) fail("Choose a valid costing date.", "rollup_date_invalid", "Enter a calendar date.");
  const batchQuantity = decimalValue(input.batchQuantity, "batchQuantity", "Enter a positive exact batch quantity.");
  if (cmp(batchQuantity, "0") <= 0) fail("Setup must be allocated over a positive batch quantity.", "rollup_batch_required", "Enter the normal production batch quantity used to allocate setup cost.");
  if (!(await tx.execute(sql`select id from subsidiaries where org_id=${orgId} and id=${input.subsidiaryId} and is_active and not is_elimination for share`)).rows.length) throw new ManufacturingNotFoundError();
  const currency = await subsidiaryCurrency(orgId, input.subsidiaryId, tx);
  const currencies = (await tx.execute<{ currency: string }>(sql`select base_currency as currency from subsidiaries where org_id=${orgId} and is_active and not is_elimination order by base_currency,id for share`)).rows;
  if (!currencies.length || currencies.some(row => row.currency !== currency)) fail("This shared item standard spans legal entities with different functional currencies.", "rollup_currency_policy_required", "Use an item costing policy with a single functional currency before applying an organization-wide standard.");
  const profile = (await tx.execute<CostProfile>(sql`select item_id,costing_method,standard_cost::text,asset_account_id,variance_account_id,base_unit,updated_at::text as revision from item_inventory_profiles where org_id=${orgId} and item_id=${input.itemId} for update`)).rows[0];
  if (!profile) throw new ManufacturingNotFoundError();
  if (profile.costing_method !== "standard") fail("This item is not configured for standard costing.", "rollup_standard_profile_required", "Review the item's costing profile and govern the change to standard costing before rolling up its standard.");
  const routing = (await tx.execute<{ id: string; version: number; effective_from: string; effective_to: string | null; default_issue_location_id: string | null; default_receipt_location_id: string | null; overheadBasis: string }>(sql`select id,version,effective_from::text,effective_to::text,default_issue_location_id,default_receipt_location_id,overhead_basis as "overheadBasis" from mfg_routings where org_id=${orgId} and produced_item_id=${input.itemId} and status='active' and effective_from<=${input.onDate}::date and (effective_to is null or ${input.onDate}::date<effective_to) order by version desc for share`)).rows;
  if (routing.length !== 1) fail("Exactly one active routing must cover the costing date.", "rollup_routing_required", "Approve an effective routing and resolve overlapping revisions before rolling up cost.");
  const route = routing[0]!;
  const materials = (await tx.execute<{ id: string; componentItemId: string; name: string; quantityPer: string;quantityBasis:BomQuantityBasis;formulaOutputQuantity:string; scrapPct: string | null; isByproduct: boolean;outputCostWeight:string|null; standardCost: string | null; defaultRate: string | null; baseUnit: string | null; revision: string }>(sql`
    select b.id,b.component_item_id as "componentItemId",i.name,b.quantity_per::text as "quantityPer",b.scrap_pct::text as "scrapPct",b.is_byproduct as "isByproduct",b.output_cost_weight::text as "outputCostWeight",b.quantity_basis as "quantityBasis",b.formula_output_quantity::text as "formulaOutputQuantity",p.standard_cost::text as "standardCost",i.default_rate::text as "defaultRate",p.base_unit as "baseUnit",b.updated_at::text as revision
    from bom_components b join items i on i.org_id=b.org_id and i.id=b.component_item_id left join item_inventory_profiles p on p.org_id=b.org_id and p.item_id=b.component_item_id
    where b.org_id=${orgId} and b.assembly_item_id=${input.itemId} and (b.effective_from is null or b.effective_from<=${input.onDate}::date) and (b.effective_to is null or ${input.onDate}::date<b.effective_to)
    order by b.sort_order,b.id for share of b,i`)).rows;
  await tx.execute(sql`select item_id from item_inventory_profiles where org_id=${orgId} and item_id in (select jsonb_array_elements_text(${JSON.stringify(materials.map(row=>row.componentItemId))}::jsonb)::uuid) order by item_id for share`);
  if (!materials.length) fail("No effective BOM covers the costing date.", "rollup_bom_required", "Add and approve the item's effective BOM before rolling up cost.");
  const componentProfiles = (await tx.execute<{item_id:string;standard_cost:string|null;base_unit:string}>(sql`select item_id,standard_cost::text,base_unit from item_inventory_profiles where org_id=${orgId} and item_id in (select jsonb_array_elements_text(${JSON.stringify(materials.map(row=>row.componentItemId))}::jsonb)::uuid) order by item_id`)).rows;
  const componentProfileById = new Map(componentProfiles.map(row=>[row.item_id,row]));
  const materialLines = materials.map(source => {
    const current = componentProfileById.get(source.componentItemId);
    const row = {...source,standardCost:current?.standard_cost??null,baseUnit:current?.base_unit??null};
    const joint=row.outputCostWeight!==null;
    const unitCost = joint?null:row.isByproduct ? row.defaultRate : row.standardCost;
    if ((!joint&&(unitCost===null||cmp(unitCost, "0") < 0)) || !row.baseUnit) fail(`Cost or base unit is missing for ${row.name}.`, "rollup_component_cost_required", "Configure each component standard and each NRV by-product's net realizable value in the native item profile; joint outputs need base units and relative cost weights.");
    const quantity = bomRequiredQuantity(batchQuantity, row.quantityPer, row.isByproduct ? null : row.scrapPct,row).quantity;
    return { ...row, quantity, unitCost, amount: joint?'0.0000':mul(quantity, unitCost!) };
  });
  const operations = (await tx.execute<{ id: string; sequence: number; name: string; work_center_id: string; setup: string; runPer: string; laborPer: string | null; kind: string; absorbs: boolean }>(sql`select o.id,o.sequence,o.name,o.work_center_id,o.setup_minutes::text as setup,o.run_minutes_per_unit::text as "runPer",o.labor_minutes_per_unit::text as "laborPer",c.kind,c.absorbs_overhead as absorbs from mfg_routing_operations o join mfg_work_centers c on c.org_id=o.org_id and c.id=o.work_center_id where o.org_id=${orgId} and o.routing_id=${route.id} order by o.sequence for share of o,c`)).rows;
  if (!operations.length) fail("The routing has no operations.", "rollup_operations_required", "Add operations to an approved routing.");
  const snapshots = await resolveOperationReleaseSnapshots(tx, orgId, { number: "standard-cost roll-up", subsidiaryId: input.subsidiaryId }, operations, route, input.onDate, currency);
  const conversion = [];
  for (const [index, operation] of operations.entries()) {
    const snapshot = snapshots[index]!;
    const runMinutes = mul(operation.runPer, batchQuantity);
    const elapsedMinutes = add(operation.setup, runMinutes);
    const laborMinutes = operation.laborPer !== null ? mul(operation.laborPer, batchQuantity) : ["labor", "cell"].includes(operation.kind) ? elapsedMinutes : "0.0000";
    const machineMinutes = ["machine", "cell"].includes(operation.kind) ? elapsedMinutes : "0.0000";
    const labor = minutesCost(snapshot.finalRate, laborMinutes);
    let machine = "0.0000", machineRateId: string | null = null;
    if (cmp(machineMinutes, "0") > 0) {
      const rate=await resolveMachineRate(tx,orgId,operation.work_center_id,input.onDate,operation.name);
      machine = minutesCost(rate.rate, machineMinutes); machineRateId = rate.id;
    }
    if (operation.absorbs && !snapshot.overhead.cards.length) fail(`No standard overhead rate covers ${operation.name}.`, "rollup_overhead_required", "Configure standard overhead for the work center's department and routing basis.");
    const overhead = operation.absorbs ? sum(snapshot.overhead.cards.map(card => route.overheadBasis === "units" ? mul(card.rate, batchQuantity) : minutesCost(card.rate, route.overheadBasis === "machine_hours" ? machineMinutes : laborMinutes))) : "0.0000";
    conversion.push({ ...operation, snapshot, laborMinutes, machineMinutes, machineRateId, labor, machine, overhead });
  }
  const material = sum(materialLines.filter(row => !row.isByproduct).map(row => row.amount));
  const byproductCredit = sum(materialLines.filter(row => row.isByproduct&&row.outputCostWeight===null).map(row => row.amount));
  const labor = sum(conversion.map(row => row.labor));
  const overhead = sum(conversion.map(row => add(row.machine, row.overhead)));
  const jointPool = add(sum([material, labor, overhead]), fromUnits(-toUnits(byproductCredit)));
  if (cmp(jointPool, "0") < 0) fail("Byproduct credit exceeds the production cost.", "rollup_negative_standard", "Review the BOM quantities and net realizable values.");
  const jointOutputs=new Map<string,{itemId:string;name:string;quantity:string;costWeight:string}>();
  for(const row of materialLines.filter(row=>row.outputCostWeight!==null)) {
    const prior=jointOutputs.get(row.componentItemId);
    if(prior&&cmp(prior.costWeight,row.outputCostWeight!)!==0)fail('A joint output has conflicting cost weights.','rollup_joint_output_weight_conflict','Use one weight on every effective line of the same joint output.');
    jointOutputs.set(row.componentItemId,{itemId:row.componentItemId,name:row.name,quantity:add(prior?.quantity??'0',row.quantity),costWeight:row.outputCostWeight!});
  }
  const actualOutputs=[...jointOutputs.values()].filter(row=>cmp(row.quantity,'0')>0);
  const allocated=allocateJointProductionCost(jointPool,[{itemId:input.itemId,quantity:batchQuantity,costWeight:'1'},...actualOutputs]);
  const total=allocated.get(input.itemId)!;
  const jointOutputCosts=actualOutputs.map(row=>({...row,amount:allocated.get(row.itemId)!,unitCost:perUnit(allocated.get(row.itemId)!,row.quantity)}));
  const standardCost = perUnit(total,batchQuantity);
  if(toUnits(standardCost)>=10n**19n) fail("The rolled standard exceeds the item costing precision.","rollup_standard_overflow","Review the BOM quantities, rates and batch quantity before proposing this standard.");
  const preview = { input: { ...input, batchQuantity }, currency, profile, routing: route, materialLines, conversion, material, byproductCredit, labor, overhead, jointPool,jointOutputCosts,total, standardCost };
  return {...preview,digest:inventoryRequestHash(preview)};
}

export async function proposeStandardRollup(tx: SqlExecutor, orgId: string, actorId: string, input: StandardRollupInput & { reason: string; idempotencyKey: string; expectedDigest: string }) {
  const { reason, idempotencyKey, expectedDigest, ...basis } = input;
  await authority(tx,orgId,actorId,input.subsidiaryId);
  const prior=(await tx.execute<{id:string;subject_id:string;submitted_by:string;effective_on:string;reason:string;payload:Record<string,unknown>;before_state:Awaited<ReturnType<typeof previewStandardRollup>>}>(sql`select id,subject_id,submitted_by,effective_on::text,reason,payload,before_state from financial_changes where org_id=${orgId} and idempotency_key=${idempotencyKey} and domain='manufacturing' and operation=${MANUFACTURING_STANDARD_ROLLUP_OPERATION}`)).rows[0];
  if(prior) {
    if(prior.subject_id!==input.itemId || prior.submitted_by!==actorId || prior.effective_on!==input.onDate || prior.reason!==reason.trim() || cmp(String(prior.payload.batchQuantity),input.batchQuantity)!==0 || prior.payload.subsidiaryId!==input.subsidiaryId || prior.before_state.digest!==expectedDigest) fail("This request key belongs to another roll-up.","rollup_request_conflict","Use a new request key for a changed proposal.");
    return {changeId:prior.id,preview:prior.before_state};
  }
  const preview = await previewStandardRollup(tx, orgId, actorId, basis);
  if(preview.digest!==expectedDigest) fail("The cost sources changed after your preview.","rollup_preview_changed","Review a fresh preview before proposing the standard.");
  const changeId = await proposeFinancialChange(tx, { orgId, actorId, subsidiaryId: input.subsidiaryId, domain: "manufacturing", subjectId: input.itemId, operation: MANUFACTURING_STANDARD_ROLLUP_OPERATION, effectiveOn: input.onDate, reason, idempotencyKey, payload: { ...basis, requiredSubsidiaryIds: [input.subsidiaryId], standardCost: preview.standardCost }, beforeState: preview });
  return { changeId, preview };
}

export async function applyStandardRollup(orgId: string, actorId: string, changeId: string) {
  return withOrgTransaction(orgId, async () => {
    const change = await loadFinancialChange(db, orgId, changeId);
    if (change.domain !== "manufacturing" || change.operation !== MANUFACTURING_STANDARD_ROLLUP_OPERATION) throw new ManufacturingNotFoundError();
    await authority(db, orgId, actorId, change.subsidiary_id);
    await lockActorCommandAuthority(db, orgId, actorId, change.subsidiary_id, "items.post");
    if (change.status === "applied") return change.result;
    if(change.effective_on!==await businessToday(orgId)) fail("A shared item standard can only become current on its costing date.","rollup_effective_date_required","Apply an approved proposal on its costing date. Create a new current-date proposal if that date has passed.");
    const input: StandardRollupInput = { itemId: change.subject_id, subsidiaryId: change.subsidiary_id, onDate: change.effective_on, batchQuantity: String(change.payload.batchQuantity) };
    const preview = await previewStandardRollup(db, orgId, actorId, input);
    if(change.status!=="approved" || !change.approved_by || change.approved_by===change.submitted_by && change.self_approval_authorized!==true) fail("The standard requires a decision permitted by its approval policy.","rollup_approval_required","Submit the proposal through the configured Accounting event flow and obtain approval before applying it.");
    if(canonicalJson(change.before_state)!==canonicalJson(preview)) fail("The cost sources changed after this proposal.","rollup_sources_changed","Review, propose and approve a new roll-up against current sources.");
    assertFinancialChangeApproved(change, { domain: "manufacturing", subjectId: change.subject_id, beforeState: preview });
    if (canonicalJson(change.payload.requiredSubsidiaryIds) !== canonicalJson([change.subsidiary_id]) || change.payload.standardCost !== preview.standardCost) fail("The approved standard does not match the frozen roll-up.", "rollup_evidence_changed", "Create and approve a new roll-up from current data.");
    const entries = await revalueOpenLayersToStandardCost(db, orgId, actorId, change.subject_id, { standardCost: preview.standardCost, assetAccountId: preview.profile.asset_account_id, varianceAccountId: preview.profile.variance_account_id, allowedSubsidiaryIds: null, memo: `Approved manufacturing standard-cost roll-up: ${change.reason}` });
    const updated = await db.execute(sql`update item_inventory_profiles set standard_cost=${preview.standardCost},updated_by=${actorId},updated_at=now() where org_id=${orgId} and item_id=${change.subject_id} and updated_at::text=${preview.profile.revision} returning item_id`);
    if (updated.rows.length !== 1) fail("The costing profile changed during application.", "rollup_profile_changed", "Reload the profile and propose another roll-up.");
    const result = { standardCost: preview.standardCost, revaluationEntries: entries ?? [] };
    await auditChange(db, { orgId, actorId, table: "item_inventory_profiles", rowId: change.subject_id, action: "update", before: preview.profile, after: { ...preview.profile, standard_cost: preview.standardCost, approvalChangeId: changeId } });
    await completeFinancialChange(db, orgId, changeId, actorId, result);
    return result;
  });
}
