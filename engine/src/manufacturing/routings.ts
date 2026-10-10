import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { assertManufacturingFeature } from "./gate.ts";
import { ManufacturingError, ManufacturingNotFoundError } from "./errors.ts";
import { auditChange, compareDecimal, decimalValue, isoDate, refused, storageCode } from "./master-support.ts";
import { isUuid } from "../platform/uuid.ts";
import { assertManufacturingItemExists } from "./item-policies.ts";
import { lockManufacturingManageAuthority, lockManufacturingRoutingAuthority, lockManufacturingCenterAuthority, assertManufacturingStockLocationScope } from "./authority.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import { loadFinancialChange, proposeFinancialChange, assertFinancialChangeApproved, completeFinancialChange, MANUFACTURING_ROUTING_APPROVAL_OPERATION } from "../platform/financial-changes.ts";

export interface RoutingInput {
  producedItemId: string; code: string; name: string; effectiveFrom: string; effectiveTo?: string | null;
  defaultIssueLocationId?: string | null; defaultReceiptLocationId?: string | null;
  overheadBasis: "labor_hours" | "machine_hours" | "units";
}
export interface RoutingOperationInput {
  sequence: number; name: string; workCenterId: string; setupMinutes: string; runMinutesPerUnit: string;
  laborTimeSource?: "operation" | "approved_time"; laborMinutesPerUnit?: string | null; backflushAt?: "none" | "start" | "finish"; qualityGate?: "none" | "measure";
}
export interface RoutingSubsidiaryScope {
  operations: Array<{ workCenterSubsidiaryId: string | null }>;
  locations: Array<{ subsidiaryId: string | null }>;
}

const routingColumns = sql`id, org_id as "orgId", produced_item_id as "producedItemId", code, name, version, status,
  effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
  default_issue_location_id as "defaultIssueLocationId", default_receipt_location_id as "defaultReceiptLocationId",
  overhead_basis as "overheadBasis"`;
const operationColumns = sql`id, org_id as "orgId", routing_id as "routingId", sequence, name,
  work_center_id as "workCenterId", setup_minutes::text as "setupMinutes",
  run_minutes_per_unit::text as "runMinutesPerUnit", labor_minutes_per_unit::text as "laborMinutesPerUnit",
  labor_time_source as "laborTimeSource", backflush_at as "backflushAt", quality_gate as "qualityGate"`;
const operationReadColumns = sql`operation.id, operation.org_id as "orgId", operation.routing_id as "routingId", operation.sequence, operation.name,
  operation.work_center_id as "workCenterId", operation.setup_minutes::text as "setupMinutes",
  operation.run_minutes_per_unit::text as "runMinutesPerUnit", operation.labor_minutes_per_unit::text as "laborMinutesPerUnit",
  operation.labor_time_source as "laborTimeSource", operation.backflush_at as "backflushAt", operation.quality_gate as "qualityGate"`;

function headerInput(input: RoutingInput): RoutingInput {
  if (!input || !input.producedItemId || !input.code?.trim() || !input.name?.trim()) {
    refused("Produced item, routing code, and routing name are required.", "invalid_routing", "producedItemId", "Choose a produced item and enter a routing code and name.");
  }
  if (!["labor_hours", "machine_hours", "units"].includes(input.overheadBasis)) {
    refused("Choose a valid overhead basis for the routing.", "invalid_overhead_basis", "overheadBasis", "Choose labor hours, machine hours, or units.");
  }
  const from = isoDate(input.effectiveFrom, "effectiveFrom");
  const to = input.effectiveTo == null ? null : isoDate(input.effectiveTo, "effectiveTo");
  if (to !== null && to <= from) refused("The routing end date must be after its start date.", "invalid_routing_range", "effectiveTo", "Choose an end date after the start date.");
  return { ...input, code: input.code.trim(), name: input.name.trim(), effectiveFrom: from, effectiveTo: to };
}

async function validateHeaderRefs(tx: SqlExecutor, orgId: string, input: RoutingInput): Promise<void> {
  const item = await tx.execute(sql`select 1 from items where org_id=${orgId} and id=${input.producedItemId}`);
  if (!item.rows.length) throw new ManufacturingNotFoundError();
  for (const id of [input.defaultIssueLocationId, input.defaultReceiptLocationId]) {
    if (id && !(await tx.execute(sql`select 1 from stock_locations where org_id=${orgId} and id=${id} and is_active`)).rows.length) {
      refused("A default routing location must be active in this organization.", "invalid_stock_location", "defaultIssueLocationId", "Choose an active stock location in this organization.");
    }
  }
}

async function routing(tx: SqlExecutor, orgId: string, id: string) {
  const result = await tx.execute<Record<string, unknown>>(sql`select ${routingColumns} from mfg_routings where org_id=${orgId} and id=${id}`);
  return result.rows[0] ?? null;
}

async function assertDraft(tx: SqlExecutor, orgId: string, id: string) {
  const result = await tx.execute<Record<string, unknown>>(sql`select ${routingColumns} from mfg_routings where org_id=${orgId} and id=${id} for update`);
  const row = result.rows[0] ?? null;
  if (!row) throw new ManufacturingNotFoundError();
  if (row.status !== "draft") {
    throw new ManufacturingError("This routing version is not a draft and cannot be edited; create a new version.", {
      status: 409, code: "routing_not_draft", remedy: "Create a new version and edit that draft.",
    });
  }
  return row;
}

export async function createRouting(tx: SqlExecutor, orgId: string, actorId: string, raw: RoutingInput, idempotency?: { id: string; requestId: string; match: Record<string, unknown> }) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const input = headerInput(raw);
  const commandScope = await lockManufacturingManageAuthority(tx,orgId,actorId,null);
  await assertManufacturingStockLocationScope(tx,orgId,input.defaultIssueLocationId,commandScope);
  await assertManufacturingStockLocationScope(tx,orgId,input.defaultReceiptLocationId,commandScope);
  await validateHeaderRefs(tx, orgId, input);
  await tx.execute(sql`select id from items where org_id=${orgId} and id=${input.producedItemId} for update`);
  const existing = await tx.execute(sql`select 1 from mfg_routings where org_id=${orgId} and produced_item_id=${input.producedItemId} and version=1`);
  if (existing.rows.length) refused("A routing already exists for this item; create its next version.", "routing_exists", "producedItemId", "Open the existing routing and create a new version.");
  const result = await tx.execute<Record<string, unknown>>(sql`
    insert into mfg_routings (id, org_id, produced_item_id, code, name, version, status, effective_from, effective_to,
      default_issue_location_id, default_receipt_location_id, overhead_basis, created_by, updated_by)
    values (coalesce(${idempotency?.id ?? null}::uuid, public.uuid_generate_v7()), ${orgId}, ${input.producedItemId}, ${input.code}, ${input.name}, 1, 'draft', ${input.effectiveFrom}, ${input.effectiveTo ?? null},
      ${input.defaultIssueLocationId ?? null}, ${input.defaultReceiptLocationId ?? null}, ${input.overheadBasis}, ${actorId}, ${actorId})
    returning ${routingColumns}`);
  const after = result.rows[0];
  if (!after) throw new ManufacturingError("The routing was not created.", { code: "write_failed", remedy: "Retry the save." });
  await auditChange(tx, { orgId, actorId, table: "mfg_routings", rowId: String(after.id), action: "insert", before: null, after, requestId: idempotency?.requestId, match: idempotency?.match });
  return after;
}

export async function createNextRoutingVersion(tx: SqlExecutor, orgId: string, actorId: string, routingId: string, idempotency?: { id: string; requestId: string; match: Record<string, unknown> }): Promise<Record<string, unknown> & { operations: Record<string, unknown>[] }> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  await lockManufacturingRoutingAuthority(tx,orgId,actorId,routingId);
  const base = await routing(tx, orgId, routingId);
  if (!base) throw new ManufacturingNotFoundError();
  await tx.execute(sql`select id from items where org_id=${orgId} and id=${base.producedItemId} for update`);
  const latestResult = await tx.execute<Record<string, unknown>>(sql`
    select ${routingColumns} from mfg_routings where org_id=${orgId} and produced_item_id=${base.producedItemId}
     order by version desc limit 1 for update`);
  const latest = latestResult.rows[0];
  if (!latest) throw new ManufacturingNotFoundError();
  await lockManufacturingRoutingAuthority(tx,orgId,actorId,String(latest.id));
  const created = await tx.execute<Record<string, unknown>>(sql`
    insert into mfg_routings (id, org_id, produced_item_id, code, name, version, status, effective_from, effective_to,
      default_issue_location_id, default_receipt_location_id, overhead_basis, created_by, updated_by)
    values (coalesce(${idempotency?.id ?? null}::uuid, public.uuid_generate_v7()), ${orgId}, ${latest.producedItemId}, ${latest.code}, ${latest.name}, ${Number(latest.version) + 1}, 'draft',
      ${latest.effectiveFrom}, ${latest.effectiveTo}, ${latest.defaultIssueLocationId}, ${latest.defaultReceiptLocationId},
      ${latest.overheadBasis}, ${actorId}, ${actorId}) returning ${routingColumns}`);
  const after = created.rows[0];
  if (!after) throw new ManufacturingError("The next routing version was not created.", { code: "write_failed", remedy: "Retry the save." });
  await auditChange(tx, { orgId, actorId, table: "mfg_routings", rowId: String(after.id), action: "insert", before: null, after: { ...after, copiedFromRoutingId: latest.id }, requestId: idempotency?.requestId, match: idempotency?.match });
  const sourceOperations = await tx.execute<{ id: string }>(sql`select id from mfg_routing_operations where org_id=${orgId} and routing_id=${String(latest.id)} order by sequence`);
  let copiedOperations: Record<string, unknown>[] = [];
  if (sourceOperations.rows.length > 0) {
    const copies = await tx.execute<Record<string, unknown>>(sql`
      insert into mfg_routing_operations (org_id, routing_id, sequence, name, work_center_id, setup_minutes,
        run_minutes_per_unit, labor_minutes_per_unit, labor_time_source, backflush_at, quality_gate, created_by, updated_by)
      select org_id, ${String(after.id)}, sequence, name, work_center_id, setup_minutes,
        run_minutes_per_unit, labor_minutes_per_unit, labor_time_source, backflush_at, quality_gate, ${actorId}, ${actorId}
        from mfg_routing_operations where org_id=${orgId} and routing_id=${String(latest.id)}
        order by sequence returning ${operationColumns}`);
    if (copies.rows.length !== sourceOperations.rows.length) {
      throw new ManufacturingError("The next routing version did not copy every operation.", {
        code: "write_failed", remedy: "Retry creating the routing version; contact an administrator if it continues.",
      });
    }
    copiedOperations = copies.rows;
  }
  for (const operation of copiedOperations) await auditChange(tx, { orgId, actorId, table: "mfg_routing_operations", rowId: String(operation.id), action: "insert", before: null, after: { ...operation, copiedFromRoutingId: latest.id } });
  return { ...after, operations: copiedOperations };
}

export async function getRouting(tx: SqlExecutor, orgId: string, id: string): Promise<(Record<string, unknown> & RoutingSubsidiaryScope) | null> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const row = await routing(tx, orgId, id);
  if (!row) return null;
  const operations = await tx.execute<Record<string, unknown> & { workCenterSubsidiaryId: string | null }>(sql`
    select ${operationReadColumns}, center.subsidiary_id as "workCenterSubsidiaryId"
      from mfg_routing_operations operation
      join mfg_work_centers center on center.org_id=operation.org_id and center.id=operation.work_center_id
     where operation.org_id=${orgId} and operation.routing_id=${id} order by operation.sequence`);
  await assertManufacturingItemExists(tx, orgId, String(row.producedItemId));
  const locationIds = [...new Set([row.defaultIssueLocationId, row.defaultReceiptLocationId].filter((id): id is string => typeof id === "string"))];
  const locations = locationIds.length ? (await tx.execute<{ subsidiaryId: string | null }>(sql`
    select location.subsidiary_id as "subsidiaryId" from stock_locations stock
    join locations location on location.org_id=stock.org_id and location.id=stock.location_id
    where stock.org_id=${orgId} and stock.id in (${sql.join(locationIds.map(id => sql`${id}::uuid`), sql`, `)}) order by stock.id`)).rows : [];
  if (locations.length !== locationIds.length) throw new ManufacturingNotFoundError();
  return { ...row, operations: operations.rows, locations };
}

export async function updateRouting(tx: SqlExecutor, orgId: string, actorId: string, id: string, patch: Partial<RoutingInput>) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const commandScope = await lockManufacturingRoutingAuthority(tx,orgId,actorId,id);
  const before = await assertDraft(tx, orgId, id);
  const input = headerInput({
    producedItemId: String(before.producedItemId), code: String(patch.code ?? before.code), name: String(patch.name ?? before.name),
    effectiveFrom: String(patch.effectiveFrom ?? before.effectiveFrom), effectiveTo: patch.effectiveTo === undefined ? before.effectiveTo as string | null : patch.effectiveTo,
    defaultIssueLocationId: patch.defaultIssueLocationId === undefined ? before.defaultIssueLocationId as string | null : patch.defaultIssueLocationId,
    defaultReceiptLocationId: patch.defaultReceiptLocationId === undefined ? before.defaultReceiptLocationId as string | null : patch.defaultReceiptLocationId,
    overheadBasis: (patch.overheadBasis ?? before.overheadBasis) as RoutingInput["overheadBasis"],
  });
  await assertManufacturingStockLocationScope(tx,orgId,input.defaultIssueLocationId,commandScope);
  await assertManufacturingStockLocationScope(tx,orgId,input.defaultReceiptLocationId,commandScope);
  await validateHeaderRefs(tx, orgId, input);
  const result = await tx.execute<Record<string, unknown>>(sql`
    update mfg_routings set code=${input.code}, name=${input.name}, effective_from=${input.effectiveFrom}, effective_to=${input.effectiveTo ?? null},
      default_issue_location_id=${input.defaultIssueLocationId ?? null}, default_receipt_location_id=${input.defaultReceiptLocationId ?? null},
      overhead_basis=${input.overheadBasis}, updated_by=${actorId}, updated_at=now()
     where org_id=${orgId} and id=${id} and status='draft' returning ${routingColumns}`);
  const after = result.rows[0];
  if (!after) throw new ManufacturingNotFoundError();
  await auditChange(tx, { orgId, actorId, table: "mfg_routings", rowId: id, action: "update", before, after });
  return after;
}

function operationInput(input: RoutingOperationInput): RoutingOperationInput {
  if (!input || !Number.isInteger(input.sequence) || input.sequence < 1) refused("Operation sequence must be a positive whole number.", "invalid_operation_sequence", "sequence", "Enter a positive whole number for the operation sequence.");
  if (!input.name?.trim() || !input.workCenterId) refused("Operation name and work center are required.", "invalid_operation", "name", "Enter an operation name and choose a work center.");
  const setupMinutes = decimalValue(input.setupMinutes, "setupMinutes", "Enter non-negative minutes with no more than four decimal places.");
  const runMinutesPerUnit = decimalValue(input.runMinutesPerUnit, "runMinutesPerUnit", "Enter non-negative minutes with no more than four decimal places.");
  const laborMinutesPerUnit = input.laborMinutesPerUnit == null ? null : decimalValue(input.laborMinutesPerUnit, "laborMinutesPerUnit", "Enter non-negative minutes with no more than four decimal places.");
  if (compareDecimal(setupMinutes, "0") === 0 && compareDecimal(runMinutesPerUnit, "0") === 0) {
    refused("This operation would consume no time — delete it or give it time.", "operation_no_time", "runMinutesPerUnit", "Delete the operation or enter setup or run minutes greater than zero.");
  }
  if (!["operation", "approved_time"].includes(input.laborTimeSource ?? "operation") || !(["none", "start", "finish"].includes(input.backflushAt ?? "none")) || !(["none", "measure"].includes(input.qualityGate ?? "none"))) {
    refused("Choose a supported backflush point and quality gate.", "invalid_operation_option", "backflushAt", "Choose a listed backflush point and quality gate.");
  }
  return { ...input, name: input.name.trim(), setupMinutes, runMinutesPerUnit, laborMinutesPerUnit, laborTimeSource: input.laborTimeSource ?? "operation", backflushAt: input.backflushAt ?? "none", qualityGate: input.qualityGate ?? "none" };
}

async function validateOperation(tx: SqlExecutor, orgId: string, routingId: string, input: RoutingOperationInput, existingId?: string) {
  const center = await tx.execute<{ id: string }>(sql`select id from mfg_work_centers where org_id=${orgId} and id=${input.workCenterId} and is_active for share`);
  if (!center.rows.length) refused("The operation work center is not active in this organization.", "invalid_work_center", "workCenterId", "Choose an active work center.");
  const duplicate = await tx.execute<{ id: string; sequence: number; name: string }>(sql`select id, sequence, name from mfg_routing_operations where org_id=${orgId} and routing_id=${routingId} and sequence=${input.sequence} and id is distinct from ${existingId ?? null} limit 1`);
  if (duplicate.rows[0]) refused(`Operation sequence ${input.sequence} is already used by operation ${duplicate.rows[0].name} in this routing.`, "operation_sequence_duplicate", "sequence", "Choose a sequence not used by another operation.");
}

export async function createRoutingOperation(tx: SqlExecutor, orgId: string, actorId: string, routingId: string, raw: RoutingOperationInput, idempotency?: { id: string; requestId: string; match: Record<string, unknown> }) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  await lockManufacturingRoutingAuthority(tx,orgId,actorId,routingId);
  await assertDraft(tx, orgId, routingId);
  const input = operationInput(raw);
  await lockManufacturingCenterAuthority(tx,orgId,actorId,input.workCenterId);
  await validateOperation(tx, orgId, routingId, input);
  const result = await tx.execute<Record<string, unknown>>(sql`
    insert into mfg_routing_operations (id, org_id, routing_id, sequence, name, work_center_id, setup_minutes,
      run_minutes_per_unit, labor_minutes_per_unit, labor_time_source, backflush_at, quality_gate, created_by, updated_by)
    values (coalesce(${idempotency?.id ?? null}::uuid, public.uuid_generate_v7()), ${orgId}, ${routingId}, ${input.sequence}, ${input.name}, ${input.workCenterId}, ${input.setupMinutes},
      ${input.runMinutesPerUnit}, ${input.laborMinutesPerUnit}, ${input.laborTimeSource}, ${input.backflushAt}, ${input.qualityGate}, ${actorId}, ${actorId})
    returning ${operationColumns}`);
  const after = result.rows[0];
  if (!after) throw new ManufacturingError("The routing operation was not created.", { code: "write_failed", remedy: "Retry the save." });
  await auditChange(tx, { orgId, actorId, table: "mfg_routing_operations", rowId: String(after.id), action: "insert", before: null, after, requestId: idempotency?.requestId, match: idempotency?.match });
  return after;
}

export async function updateRoutingOperation(tx: SqlExecutor, orgId: string, actorId: string, routingId: string, operationId: string, patch: Partial<RoutingOperationInput>) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  await lockManufacturingRoutingAuthority(tx,orgId,actorId,routingId);
  await assertDraft(tx, orgId, routingId);
  const selected = await tx.execute<Record<string, unknown>>(sql`select ${operationColumns} from mfg_routing_operations where org_id=${orgId} and routing_id=${routingId} and id=${operationId} for update`);
  const before = selected.rows[0];
  if (!before) throw new ManufacturingNotFoundError();
  const input = operationInput({
    sequence: Number(patch.sequence ?? before.sequence), name: String(patch.name ?? before.name), workCenterId: String(patch.workCenterId ?? before.workCenterId),
    setupMinutes: String(patch.setupMinutes ?? before.setupMinutes), runMinutesPerUnit: String(patch.runMinutesPerUnit ?? before.runMinutesPerUnit),
    laborMinutesPerUnit: patch.laborMinutesPerUnit === undefined ? before.laborMinutesPerUnit as string | null : patch.laborMinutesPerUnit,
    backflushAt: (patch.backflushAt ?? before.backflushAt) as RoutingOperationInput["backflushAt"],
    laborTimeSource: (patch.laborTimeSource ?? before.laborTimeSource) as RoutingOperationInput["laborTimeSource"],
    qualityGate: (patch.qualityGate ?? before.qualityGate) as RoutingOperationInput["qualityGate"],
  });
  await lockManufacturingCenterAuthority(tx,orgId,actorId,input.workCenterId);
  await validateOperation(tx, orgId, routingId, input, operationId);
  const updated = await tx.execute<Record<string, unknown>>(sql`
    update mfg_routing_operations set sequence=${input.sequence}, name=${input.name}, work_center_id=${input.workCenterId},
      setup_minutes=${input.setupMinutes}, run_minutes_per_unit=${input.runMinutesPerUnit}, labor_minutes_per_unit=${input.laborMinutesPerUnit},
      labor_time_source=${input.laborTimeSource}, backflush_at=${input.backflushAt}, quality_gate=${input.qualityGate}, updated_by=${actorId}, updated_at=now()
     where org_id=${orgId} and routing_id=${routingId} and id=${operationId} returning ${operationColumns}`);
  const after = updated.rows[0];
  if (!after) throw new ManufacturingNotFoundError();
  await auditChange(tx, { orgId, actorId, table: "mfg_routing_operations", rowId: operationId, action: "update", before, after });
  return after;
}

export async function deleteRoutingOperation(tx: SqlExecutor, orgId: string, actorId: string, routingId: string, operationId: string) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  await lockManufacturingRoutingAuthority(tx,orgId,actorId,routingId);
  await assertDraft(tx, orgId, routingId);
  const deleted = await tx.execute<Record<string, unknown>>(sql`delete from mfg_routing_operations where org_id=${orgId} and routing_id=${routingId} and id=${operationId} returning ${operationColumns}`);
  const before = deleted.rows[0];
  if (!before) throw new ManufacturingNotFoundError();
  await auditChange(tx, { orgId, actorId, table: "mfg_routing_operations", rowId: operationId, action: "delete", before, after: null });
  return { deleted: true as const };
}

async function overlappingActiveRouting(tx: SqlExecutor, orgId: string, itemId: string, from: string, to: string | null, excludeId: string) {
  return tx.execute<{ id: string; code: string; version: number; effective_from: string; effective_to: string | null }>(sql`
    select id, code, version, effective_from::text, effective_to::text from mfg_routings
     where org_id=${orgId} and produced_item_id=${itemId} and status='active' and id<>${excludeId}
       and effective_from < coalesce(${to}::date, 'infinity'::date)
       and ${from}::date < coalesce(effective_to, 'infinity'::date) limit 1`);
}

function routingOverlapRefusal(row?: { code: string; version: number; effective_from: string; effective_to: string | null }): never {
  const other = row ? `${row.code} version ${row.version} (${row.effective_from} to ${row.effective_to ?? "open-ended"})` : "another active version";
  return refused(`This routing overlaps active ${other}.`, "routing_version_overlap", "effectiveFrom", "Change the draft effective dates so they do not overlap the named version.");
}

export async function activateRouting(tx: SqlExecutor, orgId: string, actorId: string, id: string, approvalChangeId?: string) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  await routingApprovalAuthority(tx,orgId,actorId);
  if (!approvalChangeId) refused("A routing revision requires approval before activation.","routing_approval_required","approvalChangeId","Propose activation from the routing, submit its Accounting event for approval, then apply the approved event.");
  if(!isUuid(approvalChangeId)) throw new ManufacturingNotFoundError();
  const change=await loadFinancialChange(tx,orgId,approvalChangeId);
  if (change.domain!=="manufacturing" || change.operation!==MANUFACTURING_ROUTING_APPROVAL_OPERATION || change.subject_id!==id) throw new ManufacturingNotFoundError();
  if (change.status==="applied") {if(!change.result)throw new ManufacturingNotFoundError();return change.result;}
  const evidence=await routingActivationEvidence(tx,orgId,id);
  if (change.status!=="approved" || !change.approved_by || change.approved_by===change.submitted_by && !change.self_approval_authorized) refused("This routing revision has no permitted approval decision.","routing_approval_required","approvalChangeId","Submit its Accounting event for approval before applying it.");
  if (canonicalJson(change.before_state)!==canonicalJson(evidence)) refused("The routing or effective revisions changed after proposal.","routing_approval_stale","approvalChangeId","Review the routing and propose a new activation against current revisions.");
  assertFinancialChangeApproved(change,{domain:"manufacturing",subjectId:id,beforeState:evidence});
  if (canonicalJson(change.payload.supersedes)!==canonicalJson(evidence.supersedes)) refused("The approved effective-date changes differ from current evidence.","routing_approval_stale","approvalChangeId","Propose and approve the current revision again.");
  const identity = await routing(tx, orgId, id);
  if (!identity) throw new ManufacturingNotFoundError();
  await tx.execute(sql`select id from items where org_id=${orgId} and id=${identity.producedItemId} for update`);
  const before = await assertDraft(tx, orgId, id);
  const centerLocks = await tx.execute(sql`
    select center.id from mfg_routing_operations operation
      join mfg_work_centers center on center.org_id=operation.org_id and center.id=operation.work_center_id
     where operation.org_id=${orgId} and operation.routing_id=${id}
     order by center.id for share of center`);
  if (centerLocks.rows.length === 0) refused("A routing needs at least one operation before it can be activated.", "routing_operations_required", "operations", "Add an operation with an active work center.");
  const inactiveCenters = await tx.execute<{ name: string; code: string }>(sql`
    select operation.name, center.code from mfg_routing_operations operation
      join mfg_work_centers center on center.org_id=operation.org_id and center.id=operation.work_center_id
     where operation.org_id=${orgId} and operation.routing_id=${id} and not center.is_active
     order by operation.sequence`);
  if (inactiveCenters.rows.length) {
    const names = inactiveCenters.rows.map((row) => `${row.name} (${row.code})`).join(", ");
    refused(`The routing uses inactive work centers: ${names}.`, "inactive_work_center", "operations", "Reactivate each work center or change the draft operation to an active work center.");
  }
  for (const previous of evidence.supersedes) {
    const updated=await tx.execute(sql`update mfg_routings set effective_to=${String(before.effectiveFrom)},updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${previous.id} and status='active' and effective_to is not distinct from ${previous.effectiveTo}::date returning id`);
    if (updated.rows.length!==1) throw new ManufacturingNotFoundError();
    await auditChange(tx,{orgId,actorId,table:"mfg_routings",rowId:previous.id,action:"update",before:previous,after:{...previous,effectiveTo:before.effectiveFrom,approvalChangeId}});
  }
  await tx.execute(sql`select id from items where org_id=${orgId} and id=${before.producedItemId} for update`);
  const overlap = (await overlappingActiveRouting(tx, orgId, String(before.producedItemId), String(before.effectiveFrom), before.effectiveTo as string | null, id)).rows[0];
  if (overlap) routingOverlapRefusal(overlap);
  await tx.execute(sql`savepoint mfg_routing_activate`);
  let after: Record<string, unknown> | undefined;
  try {
    after = (await tx.execute<Record<string, unknown>>(sql`update mfg_routings set status='active', activation_change_id=${approvalChangeId}, updated_by=${actorId}, updated_at=now()
      where org_id=${orgId} and id=${id} and status='draft' returning ${routingColumns}`)).rows[0];
  } catch (error) {
    await tx.execute(sql`rollback to savepoint mfg_routing_activate`);
    await tx.execute(sql`release savepoint mfg_routing_activate`);
    if (storageCode(error) !== "23P01") throw error;
    const collision = (await overlappingActiveRouting(tx, orgId, String(before.producedItemId), String(before.effectiveFrom), before.effectiveTo as string | null, id)).rows[0];
    routingOverlapRefusal(collision);
  }
  await tx.execute(sql`release savepoint mfg_routing_activate`);
  if (!after) throw new ManufacturingNotFoundError();
  await auditChange(tx, { orgId, actorId, table: "mfg_routings", rowId: id, action: "update", before, after });
  await completeFinancialChange(tx,orgId,approvalChangeId,actorId,after);
  return after;
}

async function routingApprovalAuthority(tx: SqlExecutor,orgId:string,actorId:string) {
  await assertManufacturingFeature(tx,orgId,"manufacturing");
  if (await lockManufacturingManageAuthority(tx,orgId,actorId,null)!==null) refused("Shared routing revisions require unrestricted manufacturing authority.","routing_approval_scope_required","routingId","Ask a manufacturing manager with access to every legal entity to govern this revision.");
}

async function routingActivationEvidence(tx:SqlExecutor,orgId:string,id:string) {
  const identity=await routing(tx,orgId,id);if(!identity)throw new ManufacturingNotFoundError();
  await tx.execute(sql`select id from items where org_id=${orgId} and id=${identity.producedItemId} for update`);
  await tx.execute(sql`select id from mfg_routings where org_id=${orgId} and produced_item_id=${identity.producedItemId} order by id for update`);
  const candidate=await getRouting(tx,orgId,id);if(!candidate)throw new ManufacturingNotFoundError();
  if(candidate.status!=="draft") refused("Only a draft routing can be proposed for activation.","routing_not_draft","routingId","Create a new draft revision to change the current routing.");
  const active=(await tx.execute<{id:string;version:number;effectiveFrom:string;effectiveTo:string|null}>(sql`select id,version,effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo" from mfg_routings where org_id=${orgId} and produced_item_id=${candidate.producedItemId} and status='active' order by version,id`)).rows;
  const supersedes=active.filter(r=>r.effectiveFrom<String(candidate.effectiveTo??"9999-12-31") && String(candidate.effectiveFrom)<(r.effectiveTo??"9999-12-31"));
  if(supersedes.some(r=>r.effectiveFrom>=String(candidate.effectiveFrom)||r.version>=Number(candidate.version))) refused("This revision overlaps a later or same-date active routing.","routing_version_overlap","effectiveFrom","Choose an effective start after the current revision and before any later revision.");
  return {candidate,active,supersedes};
}

export async function proposeRoutingActivation(tx:SqlExecutor,orgId:string,actorId:string,id:string,input:{subsidiaryId:string;reason:string;idempotencyKey:string}) {
  await routingApprovalAuthority(tx,orgId,actorId);
  if(!isUuid(id)||!isUuid(input.subsidiaryId)) throw new ManufacturingNotFoundError();
  if(input.reason.trim().length<8||input.reason.trim().length>1000||!input.idempotencyKey.trim()||input.idempotencyKey.length>120) refused("Provide a reason of 8–1,000 characters and a stable request key.","routing_proposal_invalid","reason","Explain the revision and retry with a stable request key.");
  const entity=(await tx.execute(sql`select id from subsidiaries where org_id=${orgId} and id=${input.subsidiaryId} and is_active and not is_elimination for share`)).rows[0];
  if(!entity)throw new ManufacturingNotFoundError();
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`financial-change:${orgId}:${input.idempotencyKey}`}))`);
  const prior=(await tx.execute<{id:string;subject_id:string;subsidiary_id:string;submitted_by:string;reason:string}>(sql`select id,subject_id,subsidiary_id,submitted_by,reason from financial_changes where org_id=${orgId} and idempotency_key=${input.idempotencyKey} and domain='manufacturing' and operation=${MANUFACTURING_ROUTING_APPROVAL_OPERATION}`)).rows[0];
  if(prior) {
    if(prior.subject_id!==id||prior.subsidiary_id!==input.subsidiaryId||prior.submitted_by!==actorId||prior.reason!==input.reason.trim()) refused("This request key identifies a different revision proposal.","routing_request_conflict","idempotencyKey","Use a new request key for a different proposal.");
    return {changeId:prior.id};
  }
  const evidence=await routingActivationEvidence(tx,orgId,id);
  if(!evidence.candidate.operations.length) refused("A routing requires operations before approval.","routing_operations_required","operations","Add an operation with an active work center.");
  const changeId=await proposeFinancialChange(tx,{orgId,actorId,subsidiaryId:input.subsidiaryId,domain:"manufacturing",subjectId:id,operation:MANUFACTURING_ROUTING_APPROVAL_OPERATION,effectiveOn:String(evidence.candidate.effectiveFrom),reason:input.reason,idempotencyKey:input.idempotencyKey,payload:{routingId:id,requiredSubsidiaryIds:[input.subsidiaryId],supersedes:evidence.supersedes},beforeState:evidence});
  return {changeId};
}

export async function applyRoutingActivation(orgId:string,actorId:string,changeId:string) {
  return withOrgTransaction(orgId,async()=>{
    await routingApprovalAuthority(db,orgId,actorId);
    const change=await loadFinancialChange(db,orgId,changeId);
    if(change.domain!=="manufacturing"||change.operation!==MANUFACTURING_ROUTING_APPROVAL_OPERATION) throw new ManufacturingNotFoundError();
    return activateRouting(db,orgId,actorId,change.subject_id,changeId);
  });
}

export async function archiveRouting(tx: SqlExecutor, orgId: string, actorId: string, id: string) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  await lockManufacturingRoutingAuthority(tx,orgId,actorId,id);
  const locked = await tx.execute<Record<string, unknown>>(sql`select ${routingColumns} from mfg_routings where org_id=${orgId} and id=${id} for update`);
  const prior = locked.rows[0] ?? null;
  if (!prior) throw new ManufacturingNotFoundError();
  const openOrders = await tx.execute<{ number: string }>(sql`
    select number from mfg_work_orders where org_id=${orgId} and routing_id=${id}
      and status in ('draft', 'released', 'in_progress', 'on_hold') order by number`);
  if (openOrders.rows.length) {
    const numbers = openOrders.rows.map((row) => row.number).join(", ");
    refused(`Routing cannot be archived while work orders ${numbers} remain open.`, "routing_in_use", "routingId", "Leave this routing active while the listed work orders reference it.");
  }
  if (prior.status === "archived") return prior;
  const result = await tx.execute<Record<string, unknown>>(sql`update mfg_routings set status='archived', updated_by=${actorId}, updated_at=now()
    where org_id=${orgId} and id=${id} and status in ('draft', 'active') returning ${routingColumns}`);
  const after = result.rows[0];
  if (!after) throw new ManufacturingNotFoundError();
  await auditChange(tx, { orgId, actorId, table: "mfg_routings", rowId: id, action: "update", before: prior, after });
  return after;
}
