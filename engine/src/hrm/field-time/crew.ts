/**
 * HR-20 crew batch service: foreman batch lifecycle with signatures,
 * multi-stage Flows approval, and posting.
 *
 * Foreman = the actor holds time.crew.enter (enforced at the route)
 * and is assigned to the project through schedule_resources
 * (party → project) or holds time.manage. Submit needs a signature
 * when the org says so; the signature is an HMAC record over the
 * canonical lines digest, verifiable without the photo. Edits after
 * submit are refused — withdraw, edit, resubmit — with history in the
 * append-only batch events. Posting creates one time entry per line
 * plus one project_charge document per equipment line through the
 * EXISTING equipment charge path (unit charge_item_id → item rate),
 * in one transaction; the route posts the charge documents to the
 * ledger afterwards. A unit with no charge_item_id refuses by name
 * rather than posting a zero.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrg, withOrgTransaction, withTransactionSavepoint } from "../../platform/db.ts";
import { runRecordFlows } from "../../flows/index.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { subsidiaryScopeAllows } from "../../organization/subsidiary-scope.ts";
import { keyedFingerprint } from "../../platform/secrets.ts";
import { FieldTimeError, isUniqueViolation, refuse } from "./errors.ts";
import {
  FIELD_TIME_CREW_ENTRY_FEATURE,
  FIELD_TIME_EQUIPMENT_FEATURE,
  FIELD_TIME_FEATURE,
  loadFieldTimeSettings,
} from "./settings.ts";
import { checkEquipmentTolerance } from "./pure.ts";
import {
  chainComplete,
  CREW_BATCH_CHAIN,
  loadChain,
  nextStage,
  statusForStage,
} from "./stages.ts";
import { CREW_TIME_BATCH_SUBJECT_KIND } from "../../flows/crew-batches-adapter.ts";

export interface CrewLineInput {
  employeePartyId: string;
  hours: string;
  timeTypeId?: string | null;
  projectTaskId?: string | null;
  costCodeRef?: string | null;
  equipmentId?: string | null;
  equipmentHours?: string | null;
  memo?: string | null;
}

async function requireCrewFeature(orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, FIELD_TIME_FEATURE))) {
    refuse(
      "field_time_off",
      "Field time is turned off — turn on fieldTime in Company Settings → Features to enter crew time",
    );
  }
  if (!(await lockAndCheckOrgFeature(db, orgId, FIELD_TIME_CREW_ENTRY_FEATURE))) {
    refuse(
      "field_time_crew_off",
      "Crew time entry is turned off — turn on fieldTimeCrewEntry in Company Settings → Features to enter crew time",
    );
  }
}

/**
 * The foreman writing a batch must be on the project's crew
 * (schedule_resources party → project) or hold time.manage. The route
 * passes canManageAll from the caller's grants; this checks assignment.
 */
export async function assertForemanOnProject(
  orgId: string,
  foremanPartyId: string,
  projectId: string,
  canManageAll: boolean,
): Promise<void> {
  if (canManageAll) return;
  const row = (await db.execute<{ id: string }>(sql`
    select r.id from schedule_resources r
     where r.org_id = ${orgId} and r.party_id = ${foremanPartyId}
       and r.project_id = ${projectId}
     limit 1`)).rows[0];
  if (!row) {
    refuse(
      "foreman_not_on_project",
      "This foreman is not assigned to the project crew — assign them through project scheduling or ask someone with time.manage to enter the batch",
    );
  }
}

type BatchStatusRow = { id: string; status: string; project_id: string; foreman_party_id: string; worked_on: string };

/**
 * The actor's own party (users.party_id on the trusted runner); null when
 * the login is not linked to a party. Resolved here, never taken from the
 * caller — a caller-supplied party id would be impersonation.
 */
async function actorPartyId(orgId: string, actorUserId: string): Promise<string | null> {
  const row = (await db.execute<{ party_id: string | null }>(sql`
    select party_id from users where org_id = ${orgId} and id = ${actorUserId}`)).rows[0];
  return row?.party_id ?? null;
}

/**
 * Foreman-action ownership (canonical H-CREW rule): the actor is the
 * batch's foreman, or a time.manage holder acting for them. Anyone else —
 * including a foreman holding time.crew.enter on another batch — is
 * refused with the same unknown-batch refusal as a missing id, so one
 * foreman can never learn another's batch exists through this path.
 */
async function assertBatchOwnerOrSupervisor(
  orgId: string,
  actorUserId: string,
  batch: BatchStatusRow,
  canManageAll: boolean,
): Promise<void> {
  if (canManageAll) return;
  const partyId = await actorPartyId(orgId, actorUserId);
  if (partyId !== null && partyId === batch.foreman_party_id) return;
  refuse("batch_unknown", "The crew batch is unknown in this organization — reload the crew list");
}

/**
 * Project scope inside the write transaction (canonical shape 1): lock the
 * batch's project row FOR UPDATE and assert the caller's subsidiary scope
 * against the locked row, so a concurrent project rehome cannot move the
 * write onto another entity mid-transaction. Unknown and out-of-scope
 * projects answer identically.
 */
async function assertProjectInScope(
  orgId: string,
  projectId: string,
  scope: ReadonlySet<string> | null,
): Promise<void> {
  const row = (await db.execute<{ subsidiary_id: string | null }>(sql`
    select subsidiary_id::text as subsidiary_id from projects
     where org_id = ${orgId} and id = ${projectId} for update`)).rows[0];
  if (!row || !subsidiaryScopeAllows(scope, row.subsidiary_id)) {
    refuse("project_unknown", "The project is unknown in this organization — pick a project and retry");
  }
}

async function loadBatch(orgId: string, batchId: string): Promise<BatchStatusRow> {
  const row = (await db.execute<BatchStatusRow>(sql`
    select id::text as id, status, project_id::text as project_id,
           foreman_party_id::text as foreman_party_id, worked_on::text as worked_on
      from crew_time_batches where org_id = ${orgId} and id = ${batchId}`)).rows[0];
  if (!row) refuse("batch_unknown", "The crew batch is unknown in this organization — reload the crew list");
  return row!;
}

async function appendEvent(
  orgId: string,
  batchId: string,
  kind: string,
  actorId: string | null,
  reason: string | null,
): Promise<void> {
  await db.execute(sql`
    insert into crew_time_batch_events (org_id, batch_id, kind, actor_id, reason)
    values (${orgId}, ${batchId}, ${kind}, ${actorId}, ${reason})`);
}

function canonicalLinesDigest(lines: CrewLineRow[]): string {
  const canonical = [...lines]
    .map((l) => [
      l.employeePartyId,
      l.hours,
      l.timeTypeId ?? "",
      l.projectTaskId ?? "",
      l.costCodeRef ?? "",
      l.equipmentId ?? "",
      l.equipmentHours ?? "",
      l.memo ?? "",
    ].join("|"))
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

type CrewLineRow = {
  id?: string;
  employeePartyId: string;
  hours: string;
  timeTypeId: string | null;
  projectTaskId: string | null;
  costCodeRef: string | null;
  equipmentId: string | null;
  equipmentHours: string | null;
  memo: string | null;
}

function validHours(value: string, what: string): string {
  if (!/^\d+(?:\.\d{1,4})?$/.test(value) || Number(value) <= 0) {
    refuse("invalid_hours", `${what} must be a positive number with at most 4 decimals — fix the line and retry`);
  }
  return value;
}

async function validateLines(
  orgId: string,
  lines: CrewLineInput[],
  equipmentOn: boolean,
  toleranceHours: string,
): Promise<CrewLineInput[]> {
  if (lines.length === 0) {
    refuse("batch_empty", "The batch has no lines — add at least one worker line before saving");
  }
  const seen = new Set<string>();
  const cleaned: CrewLineInput[] = [];
  for (const line of lines) {
    const hours = validHours(line.hours, "Line hours");
    const key = [
      line.employeePartyId, line.timeTypeId ?? "", line.projectTaskId ?? "",
      line.costCodeRef ?? "", line.equipmentId ?? "",
    ].join("|");
    if (seen.has(key)) {
      refuse(
        "batch_duplicate_line",
        "Two lines cover the same worker, time type, task, cost code and equipment — merge them into one line",
      );
    }
    seen.add(key);
    let equipmentId: string | null = line.equipmentId ?? null;
    let equipmentHours: string | null = line.equipmentHours ?? null;
    if (!equipmentOn) {
      // Feature off: equipment columns are ignored, never stored.
      equipmentId = null;
      equipmentHours = null;
    } else if (equipmentId || equipmentHours) {
      if (!equipmentId || !equipmentHours) {
        refuse(
          "equipment_pair_required",
          "Equipment needs both the unit and its hours — set both or clear both on the line",
        );
      }
      equipmentHours = validHours(equipmentHours, "Equipment hours");
      const unit = (await db.execute<{ id: string; status: string }>(sql`
        select id from equipment_units
         where org_id = ${orgId} and id = ${equipmentId} and status = 'active'`)).rows[0];
      if (!unit) {
        refuse(
          "equipment_unknown",
          "The equipment unit is unknown or not active in this organization — pick an active unit",
        );
      }
      checkEquipmentTolerance(hours, equipmentHours, toleranceHours);
    }
    cleaned.push({
      employeePartyId: line.employeePartyId,
      hours,
      timeTypeId: line.timeTypeId ?? null,
      projectTaskId: line.projectTaskId ?? null,
      costCodeRef: line.costCodeRef?.trim() ? line.costCodeRef.trim() : null,
      equipmentId,
      equipmentHours,
      memo: line.memo?.trim() ? line.memo.trim() : null,
    });
  }
  return cleaned;
}

export async function createBatch(input: {
  orgId: string;
  actorUserId: string;
  foremanPartyId: string;
  projectId: string;
  workedOn: string;
  notes?: string | null;
  canManageAll: boolean;
  /** Subsidiaries the actor may write in; null = unrestricted (explicit sentinel, never omitted). */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<string> {
  await requireCrewFeature(input.orgId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.workedOn)) {
    refuse("invalid_worked_on", "Worked-on must be a calendar date — pick the day the crew worked");
  }
  // The foreman is the actor (users.party_id) unless a time.manage holder
  // acts for them: opening a batch under another foreman's party id without
  // that grant is impersonation, refused by name.
  if (!input.canManageAll) {
    const partyId = await actorPartyId(input.orgId, input.actorUserId);
    if (partyId === null || partyId !== input.foremanPartyId) {
      refuse(
        "foreman_not_self",
        "Batches open under your own foreman identity — your login is not linked to that foreman; ask someone with time.manage to open it for them",
      );
    }
  }
  try {
    return await withOrgTransaction(input.orgId, async () => {
      await assertProjectInScope(input.orgId, input.projectId, input.allowedSubsidiaryIds);
      await assertForemanOnProject(input.orgId, input.foremanPartyId, input.projectId, input.canManageAll);
      // The insert runs behind a savepoint: a double-submit retry collides
      // on the foreman/day business key, and rolling back only to the
      // savepoint keeps the caller's transaction usable for the
      // existing-batch lookup below (a bare failure would abort it).
      const id = await withTransactionSavepoint(db, async () =>
        (await db.execute<{ id: string }>(sql`
          insert into crew_time_batches
            (org_id, foreman_party_id, project_id, worked_on, status, notes, created_by, updated_by)
          values
            (${input.orgId}, ${input.foremanPartyId}, ${input.projectId}, ${input.workedOn}::date,
             'draft', ${input.notes?.trim() || null}, ${input.actorUserId}, ${input.actorUserId})
          returning id::text as id`)).rows[0]?.id,
      );
      if (!id) throw new FieldTimeError("batch_not_stored", "The crew batch was not stored — no row was written; retry");
      await appendEvent(input.orgId, id, "created", input.actorUserId, null);
      return id;
    });
  } catch (error) {
    // A foreman's double-submit (retry or timeout) collides on the
    // foreman/day business key: name the existing batch instead of
    // leaking a PG unique violation.
    if (!isUniqueViolation(error)) throw error;
    const existing = (await withOrg(input.orgId, () => db.execute<{ id: string }>(sql`
      select id::text as id from crew_time_batches
       where org_id = ${input.orgId} and foreman_party_id = ${input.foremanPartyId}
         and project_id = ${input.projectId} and worked_on = ${input.workedOn}::date
       limit 1`))).rows[0];
    refuse(
      "batch_already_exists",
      existing?.id
        ? `A batch already exists for this foreman, project and day (batch ${existing.id}) — open it instead of creating a duplicate`
        : "A batch already exists for this foreman, project and day — open it instead of creating a duplicate",
    );
  }
}

/** Replace a draft/rejected batch's lines. Anything later refuses. */
export async function setBatchLines(input: {
  orgId: string;
  actorUserId: string;
  batchId: string;
  lines: CrewLineInput[];
  canManageAll: boolean;
  /** Subsidiaries the actor may write in; null = unrestricted (explicit sentinel, never omitted). */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<void> {
  await requireCrewFeature(input.orgId);
  const batch = await loadBatch(input.orgId, input.batchId);
  await assertBatchOwnerOrSupervisor(input.orgId, input.actorUserId, batch, input.canManageAll);
  if (batch.status !== "draft" && batch.status !== "rejected") {
    refuse(
      "batch_locked",
      `The batch is ${batch.status} — withdraw it to draft before editing lines`,
    );
  }
  const settings = await loadFieldTimeSettings(input.orgId);
  const equipmentOn = await lockAndCheckOrgFeature(db, input.orgId, FIELD_TIME_EQUIPMENT_FEATURE);
  const cleaned = await validateLines(input.orgId, input.lines, equipmentOn, settings.equipmentToleranceHours);
  await withOrgTransaction(input.orgId, async () => {
    await assertProjectInScope(input.orgId, batch.project_id, input.allowedSubsidiaryIds);
    const still = (await db.execute<{ status: string }>(sql`
      select status from crew_time_batches
       where org_id = ${input.orgId} and id = ${input.batchId} for update`)).rows[0];
    if (!still || (still.status !== "draft" && still.status !== "rejected")) {
      refuse("batch_locked", "The batch moved out of draft while saving — reload and retry");
    }
    await db.execute(sql`delete from crew_time_batch_lines where batch_id = ${input.batchId}`);
    for (const line of cleaned) {
      await db.execute(sql`
        insert into crew_time_batch_lines
          (org_id, batch_id, employee_party_id, hours, time_type_id, project_task_id,
           cost_code_ref, equipment_id, equipment_hours, memo, created_by, updated_by)
        values
          (${input.orgId}, ${input.batchId}, ${line.employeePartyId}, ${line.hours},
           ${line.timeTypeId}, ${line.projectTaskId}, ${line.costCodeRef},
           ${line.equipmentId}, ${line.equipmentHours}, ${line.memo},
           ${input.actorUserId}, ${input.actorUserId})`);
    }
    const moved = (await db.execute<{ n: number }>(sql`
      update crew_time_batches set updated_at = now(), updated_by = ${input.actorUserId}
       where org_id = ${input.orgId} and id = ${input.batchId}`)).rowCount ?? 0;
    if (moved !== 1) throw new FieldTimeError("batch_not_stored", "The batch lines were not stored — retry the save");
  });
  await appendEvent(input.orgId, input.batchId, "line_edited", input.actorUserId, null);
}

export async function submitBatch(input: {
  orgId: string;
  actorUserId: string;
  batchId: string;
  signerName?: string | null;
  canManageAll: boolean;
  /** Subsidiaries the actor may write in; null = unrestricted (explicit sentinel, never omitted). */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<void> {
  await requireCrewFeature(input.orgId);
  const batch = await loadBatch(input.orgId, input.batchId);
  await assertBatchOwnerOrSupervisor(input.orgId, input.actorUserId, batch, input.canManageAll);
  if (batch.status !== "draft" && batch.status !== "rejected") {
    refuse("batch_not_submittable", `Only a draft batch can be submitted — this batch is ${batch.status}`);
  }
  const lines = (await db.execute<{ n: string }>(sql`
    select count(*)::text as n from crew_time_batch_lines where batch_id = ${input.batchId}`)).rows[0];
  if (!lines || lines.n === "0") {
    refuse("batch_empty", "The batch has no lines — add worker lines before submitting");
  }
  const settings = await loadFieldTimeSettings(input.orgId);
  if (settings.signatureRequired) {
    const name = input.signerName?.trim() ?? "";
    if (name === "") {
      refuse("signature_required", "Sign-and-submit needs the foreman signature — sign the batch before submitting");
    }
    const rows = (await db.execute<CrewLineRow>(sql`
      select employee_party_id as "employeePartyId", hours::text as hours,
             time_type_id::text as "timeTypeId", project_task_id::text as "projectTaskId",
             cost_code_ref as "costCodeRef", equipment_id::text as "equipmentId",
             equipment_hours::text as "equipmentHours", memo
        from crew_time_batch_lines where batch_id = ${input.batchId}`)).rows;
    const digest = canonicalLinesDigest(rows);
    const evidence = {
      signerName: name,
      signedAt: new Date().toISOString(),
      linesDigest: digest,
      hmac: keyedFingerprint("crew-time-batch-signature", `${input.batchId}|${digest}|${name}`),
    };
    await db.execute(sql`
      update crew_time_batches
         set signature_evidence = ${JSON.stringify(evidence)}::jsonb
       where org_id = ${input.orgId} and id = ${input.batchId}`);
  }
  await withOrgTransaction(input.orgId, async () => {
    await assertProjectInScope(input.orgId, batch.project_id, input.allowedSubsidiaryIds);
    const moved = (await db.execute<{ n: number }>(sql`
      update crew_time_batches
         set status = 'submitted', submitted_at = now(), updated_at = now(), updated_by = ${input.actorUserId}
       where org_id = ${input.orgId} and id = ${input.batchId}
         and status in ('draft', 'rejected')`)).rowCount ?? 0;
    if (moved !== 1) {
      refuse("batch_not_submittable", "The batch moved while submitting — reload and retry");
    }
  });
  await appendEvent(input.orgId, input.batchId, "submitted", input.actorUserId, null);
  // The stage chain runs through Flows: tenant on_submit flows gate the
  // crew_time_batch subject; stage approvals release through gates.
  await runRecordFlows(
    { kind: "on_submit", source: "ui" },
    CREW_TIME_BATCH_SUBJECT_KIND,
    input.batchId,
    { orgId: input.orgId, userId: input.actorUserId },
  );
}

export async function withdrawBatch(input: {
  orgId: string;
  actorUserId: string;
  batchId: string;
  reason?: string | null;
  canManageAll: boolean;
  /** Subsidiaries the actor may write in; null = unrestricted (explicit sentinel, never omitted). */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<void> {
  await requireCrewFeature(input.orgId);
  const batch = await loadBatch(input.orgId, input.batchId);
  await assertBatchOwnerOrSupervisor(input.orgId, input.actorUserId, batch, input.canManageAll);
  await withOrgTransaction(input.orgId, async () => {
    await assertProjectInScope(input.orgId, batch.project_id, input.allowedSubsidiaryIds);
    const moved = (await db.execute<{ n: number }>(sql`
      update crew_time_batches
         set status = 'draft', submitted_at = null, updated_at = now(), updated_by = ${input.actorUserId}
       where org_id = ${input.orgId} and id = ${input.batchId} and status = 'submitted'`)).rowCount ?? 0;
    if (moved !== 1) {
      refuse("batch_not_withdrawable", "Only a submitted batch can be withdrawn — approved and posted batches stay as history");
    }
  });
  await appendEvent(input.orgId, input.batchId, "withdrawn", input.actorUserId, input.reason ?? null);
}

/** Approve the current stage. The caller proves approver identity via Flows gates. */
export async function approveBatchStage(input: {
  orgId: string;
  actorUserId: string;
  batchId: string;
  comment?: string | null;
  /** Subsidiaries the actor may write in; null = unrestricted (explicit sentinel, never omitted). */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<string> {
  await requireCrewFeature(input.orgId);
  const batch = await loadBatch(input.orgId, input.batchId);
  const chain = await loadChain(input.orgId, CREW_BATCH_CHAIN);
  const stage = nextStage(batch.status, chain);
  if (!stage) {
    refuse("batch_not_approvable", `The batch is ${batch.status} — nothing is awaiting approval`);
  }
  const status = statusForStage(stage.order);
  await withOrgTransaction(input.orgId, async () => {
    await assertProjectInScope(input.orgId, batch.project_id, input.allowedSubsidiaryIds);
    const moved = (await db.execute<{ n: number }>(sql`
      update crew_time_batches
         set status = ${status}, updated_at = now(), updated_by = ${input.actorUserId}
       where org_id = ${input.orgId} and id = ${input.batchId} and status = ${batch.status}`)).rowCount ?? 0;
    if (moved !== 1) {
      refuse("batch_moved", "The batch moved while approving — reload and retry");
    }
  });
  await appendEvent(
    input.orgId,
    input.batchId,
    stage.order === 1 ? "approved_stage_1" : "approved_stage_2",
    input.actorUserId,
    input.comment ?? null,
  );
  return status;
}

export async function rejectBatch(input: {
  orgId: string;
  actorUserId: string;
  batchId: string;
  reason: string;
  /** Subsidiaries the actor may write in; null = unrestricted (explicit sentinel, never omitted). */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<void> {
  await requireCrewFeature(input.orgId);
  if (!input.reason || input.reason.trim() === "") {
    refuse("reject_reason_required", "Rejecting needs a reason — tell the foreman what to fix");
  }
  const batch = await loadBatch(input.orgId, input.batchId);
  if (batch.status !== "submitted" && batch.status !== "approved_stage_1" && batch.status !== "approved_stage_2") {
    refuse("batch_not_rejectable", `Only a batch in approval can be rejected — this batch is ${batch.status}`);
  }
  await withOrgTransaction(input.orgId, async () => {
    await assertProjectInScope(input.orgId, batch.project_id, input.allowedSubsidiaryIds);
    const moved = (await db.execute<{ n: number }>(sql`
      update crew_time_batches
         set status = 'rejected', submitted_at = null, updated_at = now(), updated_by = ${input.actorUserId}
       where org_id = ${input.orgId} and id = ${input.batchId} and status = ${batch.status}`)).rowCount ?? 0;
    if (moved !== 1) refuse("batch_moved", "The batch moved while rejecting — reload and retry");
  });
  await appendEvent(input.orgId, input.batchId, "rejected", input.actorUserId, input.reason.trim());
}

/** hours(4dp) × rate(4dp), half-up to 4dp. */
export function multiply4(hours: string, rate: string): string {
  const toScaled = (v: string): bigint => {
    const [w, f = ""] = v.split(".");
    return BigInt(`${w}${f.padEnd(4, "0").slice(0, 4)}`);
  };
  const product = toScaled(hours) * toScaled(rate);
  // 8dp → 4dp half-up.
  const rounded = (product + 5000n) / 10_000n;
  const neg = rounded < 0n ? "-" : "";
  const abs = rounded < 0n ? -rounded : rounded;
  return `${neg}${abs / 10_000n}.${String(abs % 10_000n).padStart(4, "0")}`;
}

type ChargeSpec = {
  lineId: string;
  documentNumber: string;
  equipmentId: string;
  equipmentHours: string;
  costAmount: string;
  billAmount: string;
  costRate: string;
  billRate: string | null;
  itemId: string;
  itemCode: string;
  costAccountId: string;
  recoveryAccountId: string;
};

/**
 * Readiness + charge specs for posting. Refuses BEFORE the post
 * transaction: a unit with no charge item, an unknown task, or an
 * incomplete chain never reaches the write.
 */
async function planPost(orgId: string, batch: BatchStatusRow): Promise<{ lines: Array<CrewLineInput & { id: string }>; charges: ChargeSpec[] }> {
  const chain = await loadChain(orgId, CREW_BATCH_CHAIN);
  if (!chainComplete(batch.status, chain)) {
    refuse(
      "batch_not_approved",
      `The batch is ${batch.status} — finish every approval stage before posting`,
    );
  }
  const lines = (await db.execute<Required<CrewLineRow>>(sql`
    select id::text as id, employee_party_id as "employeePartyId", hours::text as hours,
           time_type_id::text as "timeTypeId", project_task_id::text as "projectTaskId",
           cost_code_ref as "costCodeRef", equipment_id::text as "equipmentId",
           equipment_hours::text as "equipmentHours", memo
      from crew_time_batch_lines where batch_id = ${batch.id} order by id`)).rows;
  if (lines.length === 0) refuse("batch_empty", "The batch has no lines — nothing to post");
  const equipmentOn = await lockAndCheckOrgFeature(db, orgId, FIELD_TIME_EQUIPMENT_FEATURE);
  const settings = await loadFieldTimeSettings(orgId);
  const charges: ChargeSpec[] = [];
  for (const line of lines) {
    if (line.projectTaskId) {
      const task = (await db.execute<{ id: string }>(sql`
        select id from project_tasks where org_id = ${orgId} and id = ${line.projectTaskId}`)).rows[0];
      if (!task) refuse("task_unknown", "A batch line names a task outside this organization — fix the lines before posting");
    }
    const equipmentId = equipmentOn ? line.equipmentId : null;
    const equipmentHours = equipmentOn ? line.equipmentHours : null;
    if (equipmentId && equipmentHours) {
      checkEquipmentTolerance(line.hours, equipmentHours, settings.equipmentToleranceHours);
      const unit = (await db.execute<{ charge_item_id: string | null; status: string }>(sql`
        select charge_item_id::text as charge_item_id, status from equipment_units
         where org_id = ${orgId} and id = ${equipmentId}`)).rows[0];
      if (!unit || unit.status !== "active") {
        refuse("equipment_unknown", "A batch line names equipment that is unknown or not active — fix the lines before posting");
      }
      if (!unit.charge_item_id) {
        refuse(
          "equipment_no_charge_item",
          "An equipment unit on this batch has no charge item — link the unit to an equipment_charge item before posting",
        );
      }
      const item = (await db.execute<{
        kind: string; code: string; default_cost: string | null; default_rate: string | null;
        expense_account_id: string | null; cost_recovery_account_id: string | null; is_active: boolean;
      }>(sql`
        select kind, code, default_cost::text as default_cost, default_rate::text as default_rate,
               expense_account_id::text as expense_account_id,
               cost_recovery_account_id::text as cost_recovery_account_id, is_active
          from items where org_id = ${orgId} and id = ${unit.charge_item_id}`)).rows[0];
      if (!item || item.kind !== "equipment_charge" || !item.is_active) {
        refuse("equipment_no_charge_item", "An equipment unit on this batch has no usable equipment_charge item — link the unit before posting");
      }
      if (!item.default_cost || !item.expense_account_id || !item.cost_recovery_account_id) {
        refuse(
          "equipment_no_charge_item",
          "An equipment_charge item on this batch has no cost, expense account or recovery account — complete the item before posting",
        );
      }
      charges.push({
        lineId: line.id,
        // Deterministic per line inside the org+kind number space: a
        // retried post collapses onto the same document, never a second.
        documentNumber: `FT-EQ-${batch.id.slice(0, 8)}-${line.id.slice(0, 8)}`,
        equipmentId,
        equipmentHours,
        costAmount: multiply4(equipmentHours, item.default_cost),
        billAmount: item.default_rate ? multiply4(equipmentHours, item.default_rate) : multiply4(equipmentHours, item.default_cost),
        costRate: item.default_cost,
        billRate: item.default_rate,
        itemId: unit.charge_item_id,
        itemCode: item.code,
        costAccountId: item.expense_account_id,
        recoveryAccountId: item.cost_recovery_account_id,
      });
    }
  }
  return { lines, charges };
}

/**
 * Post a fully-approved batch: one time entry per line plus one
 * project_charge document per equipment line, batch → posted, all in
 * one transaction. Posting twice refuses — the second post is request
 * state, and the deterministic charge numbers make even a retried
 * transaction collapse onto the same documents.
 */
export async function postBatch(input: {
  orgId: string;
  actorUserId: string;
  batchId: string;
  /** Subsidiaries the actor may write in; null = unrestricted (explicit sentinel, never omitted). */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<{ entryIds: string[]; chargeDocumentIds: string[] }> {
  await requireCrewFeature(input.orgId);
  const batch = await loadBatch(input.orgId, input.batchId);
  if (batch.status === "posted") {
    refuse("batch_already_posted", "The batch is already posted — posting twice would double the hours");
  }
  const { lines, charges } = await planPost(input.orgId, batch);
  const org = (await db.execute<{ base_currency: string }>(sql`
    select base_currency from orgs where id = ${input.orgId}`)).rows[0];
  if (!org) refuse("org_unknown", "The organization is unknown — reload and retry");

  // Feature off: equipment columns are ignored on the entries, never stored.
  const equipmentOn = await lockAndCheckOrgFeature(db, input.orgId, FIELD_TIME_EQUIPMENT_FEATURE);
  return withOrgTransaction(input.orgId, async () => {
    // The project subsidiary is locked and asserted INSIDE the post
    // transaction: a pre-read would let a concurrent rehome stamp and post
    // another entity's charges for a scoped caller.
    await assertProjectInScope(input.orgId, batch.project_id, input.allowedSubsidiaryIds);
    const project = (await db.execute<{ subsidiary_id: string }>(sql`
      select subsidiary_id::text as subsidiary_id from projects
       where org_id = ${input.orgId} and id = ${batch.project_id}`)).rows[0];
    if (!project) refuse("project_unknown", "The batch project is gone — withdraw the batch and re-enter it");
    const entryIds: string[] = [];
    for (const line of lines) {
      const inserted = (await db.execute<{ id: string }>(sql`
        insert into time_entries
          (org_id, employee_party_id, worked_on, hours, time_type_id,
           project_id, project_task_id, cost_code_ref, status,
           equipment_id, equipment_hours, crew_batch_line_id,
           created_by, updated_by)
        values
          (${input.orgId}, ${line.employeePartyId}, ${batch.worked_on}::date, ${line.hours},
           ${line.timeTypeId}, ${batch.project_id}, ${line.projectTaskId}, ${line.costCodeRef},
           'submitted',
           ${equipmentOn ? line.equipmentId : null},
           ${equipmentOn ? line.equipmentHours : null},
           ${line.id}, ${input.actorUserId}, ${input.actorUserId})
        returning id`)).rows[0];
      if (!inserted) throw new FieldTimeError("entry_not_stored", "A batch line produced no entry — nothing was posted; retry");
      entryIds.push(inserted.id);
    }
    const chargeDocumentIds: string[] = [];
    for (const charge of charges) {
      const seen = (await db.execute<{ id: string }>(sql`
        select id::text as id from documents
         where org_id = ${input.orgId} and kind = 'project_charge'
           and document_number = ${charge.documentNumber}`)).rows[0];
      if (seen) {
        chargeDocumentIds.push(seen.id);
        continue;
      }
      const docId = (await db.execute<{ id: string }>(sql`
        insert into documents
          (org_id, kind, document_number, document_date, posting_date, currency,
           status, project_id, subsidiary_id, subtotal, tax_total, total, custom, extra_dims)
        values
          (${input.orgId}, 'project_charge', ${charge.documentNumber},
           ${batch.worked_on}::date, ${batch.worked_on}::date, ${org.base_currency},
           'draft', ${batch.project_id}, ${project.subsidiary_id},
           ${charge.costAmount}, '0', ${charge.costAmount}, '{}'::jsonb, '{}'::jsonb)
        returning id::text as id`)).rows[0];
      if (!docId) throw new FieldTimeError("charge_not_stored", "An equipment charge produced no document — nothing was posted; retry");
      // The header is created DRAFT and approved after its lines land.
      // document_line_immutability (0034) refuses line writes on anything
      // past draft, so creating the header approved made every equipment
      // charge fail on its own first line -- the guard doing exactly its
      // job against a writer that skipped the lifecycle.
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, item_id, account_id, description,
           quantity, amount, project_id, equipment_unit_id, recovery_account_id,
           cost_rate, bill_rate, cost_amount, bill_amount, is_billable, custom, extra_dims)
        values
          (${input.orgId}, ${docId.id}, 1, ${charge.itemId}, ${charge.costAccountId},
           ${"Equipment usage " + charge.itemCode}, ${charge.equipmentHours}, ${charge.costAmount},
           ${batch.project_id}, ${charge.equipmentId}, ${charge.recoveryAccountId},
           ${charge.costRate}, ${charge.billRate}, ${charge.costAmount}, ${charge.billAmount},
           true, '{}'::jsonb, '{}'::jsonb)`);
      const approved = (await db.execute<{ n: number }>(sql`
        update documents set status = 'approved', updated_at = now()
         where org_id = ${input.orgId} and id = ${docId.id} and status = 'draft'
        returning 1 as n`)).rows[0];
      if (!approved) {
        throw new FieldTimeError(
          "charge_not_approved",
          "An equipment charge could not be approved for posting — nothing was posted; retry",
        );
      }
      chargeDocumentIds.push(docId.id);
    }
    const moved = (await db.execute<{ n: number }>(sql`
      update crew_time_batches
         set status = 'posted', updated_at = now(), updated_by = ${input.actorUserId}
       where org_id = ${input.orgId} and id = ${input.batchId} and status = ${batch.status}`)).rowCount ?? 0;
    if (moved !== 1) {
      refuse("batch_moved", "The batch moved while posting — nothing was posted; reload and retry");
    }
    return { entryIds, chargeDocumentIds };
  }).then(async (result) => {
    await appendEvent(input.orgId, input.batchId, "posted", input.actorUserId, null);
    return result;
  });
}
