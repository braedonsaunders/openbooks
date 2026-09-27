import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { assertManufacturingFeature } from "./gate.ts";
import { ManufacturingError, ManufacturingNotFoundError } from "./errors.ts";
import { auditChange, compareDecimal, decimalValue, isoDate, refused, storageCode } from "./master-support.ts";

export type WorkCenterKind = "machine" | "labor" | "cell";
export interface WorkCenterInput {
  code: string; name: string; subsidiaryId?: string | null; kind: WorkCenterKind;
  capacityHoursPerDay: string; efficiencyPct: string; departmentId?: string | null;
  absorbsOverhead: boolean; calendarId?: string | null;
}

const centerColumns = sql`id, org_id as "orgId", code, name, subsidiary_id as "subsidiaryId", kind,
  capacity_hours_per_day::text as "capacityHoursPerDay", efficiency_pct::text as "efficiencyPct",
  department_id as "departmentId", absorbs_overhead as "absorbsOverhead", calendar_id as "calendarId",
  is_active as "isActive", deactivated_at as "deactivatedAt"`;

function validateCenter(input: WorkCenterInput): WorkCenterInput {
  if (!input || typeof input !== "object") refused("Work center details are required.", "invalid_work_center");
  if (!input.code?.trim() || !input.name?.trim()) refused("Work center code and name are required.", "invalid_work_center");
  if (!["machine", "labor", "cell"].includes(input.kind)) refused("Choose machine, labor, or cell for the work center kind.", "invalid_kind", "kind");
  if (typeof input.absorbsOverhead !== "boolean") refused("Choose whether this work center absorbs overhead.", "required_field", "absorbsOverhead");
  const capacityHoursPerDay = decimalValue(input.capacityHoursPerDay, "capacityHoursPerDay", "Enter a non-negative decimal with no more than four decimal places.");
  const efficiencyPct = decimalValue(input.efficiencyPct, "efficiencyPct", "Enter an efficiency above zero and no greater than 100.");
  if (compareDecimal(efficiencyPct, "0") <= 0 || compareDecimal(efficiencyPct, "100") > 0) {
    refused("Work center efficiency must be greater than 0 and no greater than 100.", "invalid_efficiency", "efficiencyPct", "Enter a percentage above 0 and no greater than 100.");
  }
  if (input.kind !== "machine" && !input.departmentId) {
    refused(`A ${input.kind} work center needs an active department.`, "department_required", "departmentId", "Choose an active department in Company Settings → Departments.");
  }
  return { ...input, code: input.code.trim(), name: input.name.trim(), capacityHoursPerDay, efficiencyPct };
}

async function validateReferences(tx: SqlExecutor, orgId: string, input: WorkCenterInput): Promise<void> {
  if (input.kind === "labor" || input.kind === "cell") {
    const department = await tx.execute(sql`select 1 from departments where org_id=${orgId} and id=${input.departmentId} and is_active for share`);
    if (!department.rows.length) refused("The selected department is not active in this organization.", "invalid_department", "departmentId", "Choose an active department from this organization.");
  }
  if (input.calendarId) {
    const calendar = await tx.execute(sql`select 1 from schedule_calendars where org_id=${orgId} and id=${input.calendarId} for share`);
    if (!calendar.rows.length) refused("The selected calendar does not belong to this organization.", "invalid_calendar", "calendarId", "Choose a calendar configured for this organization.");
  }
}

export async function createWorkCenter(
  tx: SqlExecutor, orgId: string, actorId: string, raw: WorkCenterInput,
  idempotency?: { id: string; requestId: string; match: Record<string, unknown> },
) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const input = validateCenter(raw);
  await validateReferences(tx, orgId, input);
  const inserted = await tx.execute<Record<string, unknown>>(sql`
    insert into mfg_work_centers
      (id, org_id, code, name, subsidiary_id, kind, capacity_hours_per_day, efficiency_pct,
       department_id, absorbs_overhead, calendar_id, created_by, updated_by)
    values (coalesce(${idempotency?.id ?? null}::uuid, public.uuid_generate_v7()), ${orgId}, ${input.code}, ${input.name}, ${input.subsidiaryId ?? null}, ${input.kind},
      ${input.capacityHoursPerDay}, ${input.efficiencyPct}, ${input.departmentId ?? null},
      ${input.absorbsOverhead}, ${input.calendarId ?? null}, ${actorId}, ${actorId})
    returning ${centerColumns}`);
  const row = inserted.rows[0];
  if (!row) throw new ManufacturingError("The work center was not created.", { code: "write_failed", remedy: "Retry the save.", field: "workCenter" });
  await auditChange(tx, { orgId, actorId, table: "mfg_work_centers", rowId: String(row.id), action: "insert", before: null, after: row, requestId: idempotency?.requestId, match: idempotency?.match });
  return row;
}

export async function getWorkCenter(tx: SqlExecutor, orgId: string, id: string) {
  const result = await tx.execute<Record<string, unknown>>(sql`select ${centerColumns} from mfg_work_centers where org_id=${orgId} and id=${id}`);
  return result.rows[0] ?? null;
}

export async function updateWorkCenter(
  tx: SqlExecutor, orgId: string, actorId: string, id: string,
  patch: Partial<WorkCenterInput>,
) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const locked = await tx.execute<Record<string, unknown>>(sql`select ${centerColumns} from mfg_work_centers where org_id=${orgId} and id=${id} for update`);
  const before = locked.rows[0] ?? null;
  if (!before) throw new ManufacturingNotFoundError();
  const merged = validateCenter({
    code: String(patch.code ?? before.code), name: String(patch.name ?? before.name),
    subsidiaryId: patch.subsidiaryId === undefined ? before.subsidiaryId as string | null : patch.subsidiaryId,
    kind: (patch.kind ?? before.kind) as WorkCenterKind,
    capacityHoursPerDay: String(patch.capacityHoursPerDay ?? before.capacityHoursPerDay),
    efficiencyPct: String(patch.efficiencyPct ?? before.efficiencyPct),
    departmentId: patch.departmentId === undefined ? before.departmentId as string | null : patch.departmentId,
    absorbsOverhead: patch.absorbsOverhead === undefined ? before.absorbsOverhead as boolean : patch.absorbsOverhead,
    calendarId: patch.calendarId === undefined ? before.calendarId as string | null : patch.calendarId,
  });
  await validateReferences(tx, orgId, merged);
  const written = await tx.execute<Record<string, unknown>>(sql`
    update mfg_work_centers set code=${merged.code}, name=${merged.name}, subsidiary_id=${merged.subsidiaryId ?? null},
      kind=${merged.kind}, capacity_hours_per_day=${merged.capacityHoursPerDay}, efficiency_pct=${merged.efficiencyPct},
      department_id=${merged.departmentId ?? null}, absorbs_overhead=${merged.absorbsOverhead},
      calendar_id=${merged.calendarId ?? null}, updated_by=${actorId}, updated_at=now()
     where org_id=${orgId} and id=${id} returning ${centerColumns}`);
  const after = written.rows[0];
  if (!after) throw new ManufacturingNotFoundError();
  await auditChange(tx, { orgId, actorId, table: "mfg_work_centers", rowId: id, action: "update", before, after });
  return after;
}

async function setActive(tx: SqlExecutor, orgId: string, actorId: string, id: string, active: boolean) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const prior = await tx.execute<Record<string, unknown>>(sql`select ${centerColumns} from mfg_work_centers where org_id=${orgId} and id=${id} for update`);
  const before = prior.rows[0];
  if (!before) throw new ManufacturingNotFoundError();
  if (before.isActive === active) return before;
  const result = await tx.execute<Record<string, unknown>>(sql`
    update mfg_work_centers set is_active=${active}, deactivated_at=${active ? null : sql`now()`},
      updated_by=${actorId}, updated_at=now() where org_id=${orgId} and id=${id} and is_active=${!active}
    returning ${centerColumns}`);
  const after = result.rows[0];
  if (!after) throw new ManufacturingNotFoundError();
  await auditChange(tx, { orgId, actorId, table: "mfg_work_centers", rowId: id, action: "update", before, after });
  return after;
}

export const deactivateWorkCenter = (tx: SqlExecutor, orgId: string, actorId: string, id: string) => setActive(tx, orgId, actorId, id, false);
export const reactivateWorkCenter = (tx: SqlExecutor, orgId: string, actorId: string, id: string) => setActive(tx, orgId, actorId, id, true);

export async function addWorkCenterRate(
  tx: SqlExecutor, orgId: string, actorId: string, workCenterId: string,
  input: { machineRatePerHour: string; effectiveFrom: string; effectiveTo?: string | null },
  idempotency?: { id: string; requestId: string; match: Record<string, unknown> },
) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const center = await tx.execute<{ kind: WorkCenterKind }>(sql`select kind from mfg_work_centers where org_id=${orgId} and id=${workCenterId} and is_active for share`);
  if (!center.rows[0]) throw new ManufacturingNotFoundError();
  if (center.rows[0].kind === "labor") refused("Machine rates apply only to machine or cell work centers.", "rate_not_applicable", "workCenterId", "Choose a machine or cell work center.");
  const amount = decimalValue(input.machineRatePerHour, "machineRatePerHour", "Enter a non-negative rate with no more than four decimal places.");
  const from = isoDate(input.effectiveFrom, "effectiveFrom");
  const to = input.effectiveTo == null ? null : isoDate(input.effectiveTo, "effectiveTo");
  if (to !== null && to <= from) refused("The rate end date must be after its start date.", "invalid_rate_range", "effectiveTo", "Choose an end date after the start date.");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${orgId} || ':mfg_work_center_rates:' || ${workCenterId}, 0))`);
  const overlap = async () => tx.execute<{ id: string; effective_from: string; effective_to: string | null }>(sql`
    select id, effective_from::text, effective_to::text from mfg_work_center_rates
     where org_id=${orgId} and work_center_id=${workCenterId}
       and effective_from < coalesce(${to}::date, 'infinity'::date)
       and ${from}::date < coalesce(effective_to, 'infinity'::date) limit 1`);
  const existing = (await overlap()).rows[0];
  if (existing) refused(`The rate overlaps the existing machine rate from ${existing.effective_from} to ${existing.effective_to ?? "open-ended"}.`, "rate_overlap", "effectiveFrom", "Choose dates that do not overlap the existing rate.");
  await tx.execute(sql`savepoint mfg_work_center_rate_insert`);
  let row: Record<string, unknown> | undefined;
  try {
    const inserted = await tx.execute<Record<string, unknown>>(sql`
      insert into mfg_work_center_rates (id, org_id, work_center_id, machine_rate_per_hour, effective_from, effective_to, created_by, updated_by)
      values (coalesce(${idempotency?.id ?? null}::uuid, public.uuid_generate_v7()), ${orgId}, ${workCenterId}, ${amount}, ${from}, ${to}, ${actorId}, ${actorId})
      returning id, org_id as "orgId", work_center_id as "workCenterId", machine_rate_per_hour::text as "machineRatePerHour",
        effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo"`);
    row = inserted.rows[0];
    if (!row) throw new ManufacturingError("The machine rate was not created.", { code: "write_failed", remedy: "Retry the save." });
  } catch (error) {
    await tx.execute(sql`rollback to savepoint mfg_work_center_rate_insert`);
    await tx.execute(sql`release savepoint mfg_work_center_rate_insert`);
    if (storageCode(error) !== "23P01") throw error;
    const conflict = (await overlap()).rows[0];
    const dates = conflict ? `${conflict.effective_from} to ${conflict.effective_to ?? "open-ended"}` : "another rate period";
    refused(`The rate overlaps the existing machine rate dated ${dates}.`, "rate_overlap", "effectiveFrom", "Choose dates that do not overlap the existing rate.");
  }
  await tx.execute(sql`release savepoint mfg_work_center_rate_insert`);
  await auditChange(tx, { orgId, actorId, table: "mfg_work_center_rates", rowId: String(row.id), action: "insert", before: null, after: row, requestId: idempotency?.requestId, match: idempotency?.match });
  return row;
}

export async function endWorkCenterRate(tx: SqlExecutor, orgId: string, actorId: string, workCenterId: string, rateId: string, effectiveTo: string) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const end = isoDate(effectiveTo, "effectiveTo");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${orgId} || ':mfg_work_center_rates:' || ${workCenterId}, 0))`);
  const priorResult = await tx.execute<Record<string, unknown>>(sql`
    select id, org_id as "orgId", work_center_id as "workCenterId", machine_rate_per_hour::text as "machineRatePerHour",
      effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo"
      from mfg_work_center_rates where org_id=${orgId} and work_center_id=${workCenterId} and id=${rateId} for update`);
  const before = priorResult.rows[0];
  if (!before) throw new ManufacturingNotFoundError();
  if (end <= String(before.effectiveFrom)) refused("The rate end date must be after its start date.", "invalid_rate_range", "effectiveTo", "Choose an end date after the start date.");
  const overlap = await tx.execute<{ effective_from: string; effective_to: string | null }>(sql`
    select effective_from::text, effective_to::text from mfg_work_center_rates
     where org_id=${orgId} and work_center_id=${workCenterId} and id<>${rateId}
       and effective_from < ${end}::date and ${String(before.effectiveFrom)}::date < coalesce(effective_to, 'infinity'::date) limit 1`);
  if (overlap.rows[0]) refused(`The rate end date overlaps the existing machine rate from ${overlap.rows[0].effective_from} to ${overlap.rows[0].effective_to ?? "open-ended"}.`, "rate_overlap", "effectiveTo", "Choose an end date that does not overlap the existing rate.");
  await tx.execute(sql`savepoint mfg_work_center_rate_end`);
  let after: Record<string, unknown> | undefined;
  try {
    after = (await tx.execute<Record<string, unknown>>(sql`
      update mfg_work_center_rates set effective_to=${end}, updated_by=${actorId}, updated_at=now()
       where org_id=${orgId} and work_center_id=${workCenterId} and id=${rateId}
       returning id, org_id as "orgId", work_center_id as "workCenterId", machine_rate_per_hour::text as "machineRatePerHour",
         effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo"`)).rows[0];
  } catch (error) {
    await tx.execute(sql`rollback to savepoint mfg_work_center_rate_end`);
    await tx.execute(sql`release savepoint mfg_work_center_rate_end`);
    if (storageCode(error) !== "23P01") throw error;
    const conflict = (await tx.execute<{ effective_from: string; effective_to: string | null }>(sql`
      select effective_from::text, effective_to::text from mfg_work_center_rates
       where org_id=${orgId} and work_center_id=${workCenterId} and id<>${rateId}
         and effective_from < ${end}::date and ${String(before.effectiveFrom)}::date < coalesce(effective_to, 'infinity'::date) limit 1`)).rows[0];
    refused(`The rate end date overlaps the existing machine rate from ${conflict?.effective_from ?? "another rate"} to ${conflict?.effective_to ?? "open-ended"}.`, "rate_overlap", "effectiveTo", "Choose an end date that does not overlap the existing rate.");
  }
  await tx.execute(sql`release savepoint mfg_work_center_rate_end`);
  if (!after) throw new ManufacturingNotFoundError();
  await auditChange(tx, { orgId, actorId, table: "mfg_work_center_rates", rowId: rateId, action: "update", before, after });
  return after;
}

export async function getWorkCenterRate(tx: SqlExecutor, orgId: string, workCenterId: string, rateId: string) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const result = await tx.execute<Record<string, unknown>>(sql`
    select id, org_id as "orgId", work_center_id as "workCenterId", machine_rate_per_hour::text as "machineRatePerHour",
      effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo"
      from mfg_work_center_rates where org_id=${orgId} and work_center_id=${workCenterId} and id=${rateId}`);
  return result.rows[0] ?? null;
}
