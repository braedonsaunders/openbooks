import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { businessToday, isIsoCalendarDate } from "../platform/business-date.ts";
import { add, cmp } from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { assertAssetAccess } from "./asset-access.ts";
import { notifyAssetOperators, orgsWithAssetFeature } from "./asset-alerts.ts";
import { refuse } from "./asset-refusal.ts";
import { journalLineForDocumentLine, proposeJournalLine } from "./asset-proposals.ts";
import {
  assertMaintenanceInterval,
  maintenanceDueKey,
  maintenanceStanding,
  nextMaintenanceDue,
  type MaintenanceStanding,
} from "./maintenance-math.ts";

/**
 * Asset maintenance: schedules that recur by time and/or meter usage, meter
 * readings, and records of work done. Nothing here posts to the ledger.
 * A record links the vendor bill line that paid for the work; a betterment
 * worth capitalizing is proposed through the asset proposal queue from that
 * line, so the capitalization decision and its reclassification stay in one
 * governed place.
 */

const LIVE_ASSET_STATUSES = ["draft", "in_service", "fully_depreciated", "construction"] as const;

type AssetScope = { id: string; asset_number: string; subsidiary_id: string; status: string };

async function lockAsset(
  tx: SqlExecutor,
  orgId: string,
  assetId: string,
  allowed: readonly string[] | null | undefined,
  mode: "update" | "share" = "share",
): Promise<AssetScope> {
  const row = (
    await tx.execute<AssetScope>(
      sql`
    select id, asset_number, subsidiary_id, status from fixed_assets
     where org_id = ${orgId} and id = ${assetId}
       ${allowed ? sql`and subsidiary_id = any(${uuidArray([...allowed])}::uuid[])` : sql``}
     ${mode === "update" ? sql`for update` : sql`for share`}`,
      "objects",
    )
  )[0];
  if (!row) refuse("asset_not_found", "asset not found", { status: 404 });
  return row;
}

function exactNonNegative(value: string | null | undefined, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = canonicalDecimal(value, 4);
  if (parsed === null || cmp(parsed, "0") < 0)
    refuse("amount_invalid", `${label} must be a non-negative exact amount`);
  return parsed;
}

async function assertVendor(tx: SqlExecutor, orgId: string, partyId: string | null): Promise<void> {
  if (!partyId) return;
  const party = (
    await tx.execute(
      sql`select 1 from parties where org_id = ${orgId} and id = ${partyId}`,
      "objects",
    )
  )[0];
  if (!party) refuse("vendor_invalid", "the vendor does not exist in this organization");
}

export interface MaintenanceScheduleInput {
  assetId: string;
  name: string;
  description?: string | null;
  intervalMonths?: number | null;
  intervalUsage?: string | null;
  usageUnit?: string | null;
  startsOn: string;
  vendorPartyId?: string | null;
  estimatedCost?: string | null;
  leadDays?: number | null;
}

function normalizeSchedule(input: MaintenanceScheduleInput) {
  const name = input.name.trim();
  if (!name) refuse("name_required", "name the maintenance task");
  if (name.length > 200) refuse("name_too_long", "names are limited to 200 characters");
  if (!isIsoCalendarDate(input.startsOn))
    refuse("date_invalid", "the start date must be a calendar date (YYYY-MM-DD)");
  const intervalUsage = exactNonNegative(input.intervalUsage ?? null, "the usage interval");
  const usageUnit = input.usageUnit?.trim() || null;
  if ((intervalUsage === null) !== (usageUnit === null))
    refuse(
      "usage_unit_required",
      "a usage interval needs its meter unit (for example hours or km)",
    );
  if (usageUnit && usageUnit.length > 40)
    refuse("usage_unit_invalid", "meter units are limited to 40 characters");
  const intervalMonths = input.intervalMonths ?? null;
  assertMaintenanceInterval({ intervalMonths, intervalUsage });
  const leadDays = input.leadDays ?? 14;
  if (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > 365)
    refuse("lead_days_invalid", "lead days must be a whole number from 0 to 365");
  return {
    name,
    description: input.description?.trim() || null,
    intervalMonths,
    intervalUsage,
    usageUnit,
    startsOn: input.startsOn,
    vendorPartyId: input.vendorPartyId || null,
    estimatedCost: exactNonNegative(input.estimatedCost ?? null, "the estimated cost"),
    leadDays,
  };
}

/** Create a maintenance schedule; its first due point counts from the start date. */
export async function createMaintenanceSchedule(
  orgId: string,
  input: MaintenanceScheduleInput,
  options: { actorId: string; allowedSubsidiaryIds?: readonly string[] | null },
): Promise<{ id: string; nextDueOn: string | null; nextDueUsage: string | null }> {
  const schedule = normalizeSchedule(input);
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    const asset = await lockAsset(tx, orgId, input.assetId, options.allowedSubsidiaryIds);
    await assertAssetAccess(tx, {
      orgId,
      actorId: options.actorId,
      permission: "assets.maintain",
      feature: "assetMaintenance",
      subsidiaryIds: [asset.subsidiary_id],
    });
    if (!(LIVE_ASSET_STATUSES as readonly string[]).includes(asset.status))
      refuse("asset_not_live", `asset ${asset.asset_number} is ${asset.status}`);
    await assertVendor(tx, orgId, schedule.vendorPartyId);
    const due = nextMaintenanceDue({
      ...schedule,
      lastPerformedOn: null,
      lastPerformedUsage: null,
    });
    const row = (
      await tx.execute<{ id: string }>(
        sql`
      insert into asset_maintenance_schedules
        (org_id, asset_id, name, description, interval_months, interval_usage, usage_unit, starts_on,
         next_due_on, next_due_usage, vendor_party_id, estimated_cost, lead_days, created_by, updated_by)
      values
        (${orgId}, ${asset.id}, ${schedule.name}, ${schedule.description}, ${schedule.intervalMonths}, ${schedule.intervalUsage},
         ${schedule.usageUnit}, ${schedule.startsOn}, ${due.nextDueOn}, ${due.nextDueUsage}, ${schedule.vendorPartyId},
         ${schedule.estimatedCost}, ${schedule.leadDays}, ${options.actorId}, ${options.actorId})
      returning id`,
        "objects",
      )
    )[0];
    if (!row) throw new Error("the maintenance schedule was not stored");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'asset_maintenance_schedules', ${row.id}, 'insert',
              ${JSON.stringify({ before: null, after: { ...schedule, assetId: asset.id, ...due } })}::jsonb, ${options.actorId})`);
    return { id: row.id, ...due };
  });
}

/** Change a schedule's terms or switch it off; the next due point is recomputed. */
export async function updateMaintenanceSchedule(
  orgId: string,
  scheduleId: string,
  input: Omit<MaintenanceScheduleInput, "assetId"> & { isActive: boolean },
  options: { actorId: string; allowedSubsidiaryIds?: readonly string[] | null },
): Promise<{ id: string; nextDueOn: string | null; nextDueUsage: string | null }> {
  const schedule = normalizeSchedule({ ...input, assetId: "" });
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    const before = (
      await tx.execute<
        Record<string, unknown> & {
          asset_id: string;
          last_performed_on: string | null;
          last_performed_usage: string | null;
        }
      >(
        sql`
      select *, last_performed_on::text as last_performed_on, last_performed_usage::text as last_performed_usage
        from asset_maintenance_schedules where org_id = ${orgId} and id = ${scheduleId} for update`,
        "objects",
      )
    )[0];
    if (!before) refuse("schedule_not_found", "maintenance schedule not found", { status: 404 });
    const asset = await lockAsset(tx, orgId, before.asset_id, options.allowedSubsidiaryIds);
    await assertAssetAccess(tx, {
      orgId,
      actorId: options.actorId,
      permission: "assets.maintain",
      feature: "assetMaintenance",
      subsidiaryIds: [asset.subsidiary_id],
    });
    await assertVendor(tx, orgId, schedule.vendorPartyId);
    const due = nextMaintenanceDue({
      ...schedule,
      lastPerformedOn: before.last_performed_on,
      lastPerformedUsage: before.last_performed_usage,
    });
    const after = (
      await tx.execute<Record<string, unknown>>(
        sql`
      update asset_maintenance_schedules
         set name = ${schedule.name}, description = ${schedule.description}, interval_months = ${schedule.intervalMonths},
             interval_usage = ${schedule.intervalUsage}, usage_unit = ${schedule.usageUnit}, starts_on = ${schedule.startsOn},
             next_due_on = ${due.nextDueOn}, next_due_usage = ${due.nextDueUsage}, vendor_party_id = ${schedule.vendorPartyId},
             estimated_cost = ${schedule.estimatedCost}, lead_days = ${schedule.leadDays}, is_active = ${input.isActive},
             updated_at = clock_timestamp(), updated_by = ${options.actorId}
       where org_id = ${orgId} and id = ${scheduleId}
       returning *`,
        "objects",
      )
    )[0];
    if (!after) throw new Error("the maintenance schedule was not updated; no row changed");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'asset_maintenance_schedules', ${scheduleId}, 'update',
              ${JSON.stringify({ before, after })}::jsonb, ${options.actorId})`);
    return { id: scheduleId, ...due };
  });
}

/**
 * Record a meter reading. Readings never run backwards: a reading must be
 * at least every earlier reading of the same unit and at most every later one.
 */
async function insertReading(
  tx: SqlExecutor,
  args: {
    orgId: string;
    assetId: string;
    readOn: string;
    reading: string;
    unit: string;
    memo: string | null;
    actorId: string;
  },
): Promise<string> {
  const bounds = (
    await tx.execute<{ before: string | null; after: string | null }>(
      sql`
    select (select max(reading)::text from asset_usage_readings
             where org_id = ${args.orgId} and asset_id = ${args.assetId} and lower(unit) = lower(${args.unit}) and read_on <= ${args.readOn}) as before,
           (select min(reading)::text from asset_usage_readings
             where org_id = ${args.orgId} and asset_id = ${args.assetId} and lower(unit) = lower(${args.unit}) and read_on > ${args.readOn}) as after`,
      "objects",
    )
  )[0];
  if (bounds?.before && cmp(args.reading, bounds.before) < 0) {
    refuse(
      "reading_decreases",
      `the reading ${args.reading} is below an earlier reading of ${bounds.before} ${args.unit}`,
    );
  }
  if (bounds?.after && cmp(args.reading, bounds.after) > 0) {
    refuse(
      "reading_exceeds_later",
      `the reading ${args.reading} is above a later reading of ${bounds.after} ${args.unit}`,
    );
  }
  const row = (
    await tx.execute<{ id: string }>(
      sql`
    insert into asset_usage_readings (org_id, asset_id, read_on, reading, unit, memo, created_by)
    values (${args.orgId}, ${args.assetId}, ${args.readOn}, ${args.reading}, ${args.unit}, ${args.memo}, ${args.actorId})
    returning id`,
      "objects",
    )
  )[0];
  if (!row) throw new Error("the meter reading was not stored");
  return row.id;
}

export async function recordUsageReading(
  orgId: string,
  input: { assetId: string; readOn: string; reading: string; unit: string; memo?: string | null },
  options: { actorId: string; allowedSubsidiaryIds?: readonly string[] | null },
): Promise<{ id: string }> {
  if (!isIsoCalendarDate(input.readOn))
    refuse("date_invalid", "the reading date must be a calendar date (YYYY-MM-DD)");
  const reading = exactNonNegative(input.reading, "the reading");
  if (reading === null) refuse("reading_required", "enter the meter reading");
  const unit = input.unit.trim();
  if (!unit || unit.length > 40)
    refuse("usage_unit_invalid", "name the meter unit (up to 40 characters)");
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    const asset = await lockAsset(tx, orgId, input.assetId, options.allowedSubsidiaryIds, "update");
    await assertAssetAccess(tx, {
      orgId,
      actorId: options.actorId,
      permission: "assets.maintain",
      feature: "assetMaintenance",
      subsidiaryIds: [asset.subsidiary_id],
    });
    const id = await insertReading(tx, {
      orgId,
      assetId: asset.id,
      readOn: input.readOn,
      reading,
      unit,
      memo: input.memo?.trim() || null,
      actorId: options.actorId,
    });
    return { id };
  });
}

/** Recompute a schedule's last-performed point and next due from its live records. */
async function refreshScheduleFromRecords(
  tx: SqlExecutor,
  orgId: string,
  scheduleId: string,
  actorId: string,
): Promise<void> {
  const schedule = (
    await tx.execute<{
      interval_months: number | null;
      interval_usage: string | null;
      starts_on: string;
    }>(
      sql`
    select interval_months, interval_usage::text as interval_usage, starts_on::text as starts_on
      from asset_maintenance_schedules where org_id = ${orgId} and id = ${scheduleId} for update`,
      "objects",
    )
  )[0];
  if (!schedule) return;
  const last = (
    await tx.execute<{ performed_on: string; usage_reading: string | null }>(
      sql`
    select performed_on::text as performed_on, usage_reading::text as usage_reading
      from asset_maintenance_records
     where org_id = ${orgId} and schedule_id = ${scheduleId} and status = 'recorded'
     order by performed_on desc, created_at desc limit 1`,
      "objects",
    )
  )[0];
  const lastUsage =
    (
      await tx.execute<{ usage: string | null }>(
        sql`
    select max(usage_reading)::text as usage from asset_maintenance_records
     where org_id = ${orgId} and schedule_id = ${scheduleId} and status = 'recorded'`,
        "objects",
      )
    )[0]?.usage ?? null;
  const due = nextMaintenanceDue({
    intervalMonths: schedule.interval_months,
    intervalUsage: schedule.interval_usage,
    startsOn: schedule.starts_on,
    lastPerformedOn: last?.performed_on ?? null,
    lastPerformedUsage: lastUsage,
  });
  const updated = (
    await tx.execute<{ id: string }>(
      sql`
    update asset_maintenance_schedules
       set last_performed_on = ${last?.performed_on ?? null}, last_performed_usage = ${lastUsage},
           next_due_on = ${due.nextDueOn}, next_due_usage = ${due.nextDueUsage},
           updated_at = clock_timestamp(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${scheduleId}
     returning id`,
      "objects",
    )
  )[0];
  if (!updated) throw new Error("the maintenance schedule was not refreshed; no row changed");
}

export interface MaintenanceRecordInput {
  assetId: string;
  scheduleId?: string | null;
  performedOn: string;
  usageReading?: string | null;
  description: string;
  vendorPartyId?: string | null;
  cost?: string | null;
  treatment: "expense" | "betterment";
  sourceDocumentLineId?: string | null;
}

/**
 * Record maintenance work. A record may link the vendor bill (or expense
 * report) line that paid for it. A betterment requires that line: the line
 * is proposed for capitalization through the asset proposal queue, where it
 * is accepted as a component of this asset or otherwise decided.
 */
export async function recordMaintenance(
  orgId: string,
  input: MaintenanceRecordInput,
  options: { actorId: string; allowedSubsidiaryIds?: readonly string[] | null },
): Promise<{ id: string; proposalId: string | null }> {
  if (!isIsoCalendarDate(input.performedOn))
    refuse("date_invalid", "the work date must be a calendar date (YYYY-MM-DD)");
  const description = input.description.trim();
  if (!description) refuse("description_required", "describe the work performed");
  if (description.length > 2000)
    refuse("description_too_long", "descriptions are limited to 2,000 characters");
  if (input.treatment !== "expense" && input.treatment !== "betterment")
    refuse("treatment_invalid", "choose expense or betterment");
  const cost = exactNonNegative(input.cost ?? "0", "the cost") ?? "0";
  const usage = exactNonNegative(input.usageReading ?? null, "the meter reading");
  if (input.treatment === "betterment" && !input.sourceDocumentLineId) {
    refuse(
      "betterment_source_required",
      "a betterment is capitalized from the bill line that paid for it",
      {
        remedy: "Link the posted vendor bill line, then record the betterment.",
      },
    );
  }
  return withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    const asset = await lockAsset(tx, orgId, input.assetId, options.allowedSubsidiaryIds, "update");
    await assertAssetAccess(tx, {
      orgId,
      actorId: options.actorId,
      permission: "assets.maintain",
      feature: "assetMaintenance",
      subsidiaryIds: [asset.subsidiary_id],
    });
    if (!(LIVE_ASSET_STATUSES as readonly string[]).includes(asset.status))
      refuse("asset_not_live", `asset ${asset.asset_number} is ${asset.status}`);
    await assertVendor(tx, orgId, input.vendorPartyId ?? null);
    let schedule: { id: string; usage_unit: string | null } | null = null;
    if (input.scheduleId) {
      schedule =
        (
          await tx.execute<{ id: string; usage_unit: string | null }>(
            sql`
        select id, usage_unit from asset_maintenance_schedules
         where org_id = ${orgId} and id = ${input.scheduleId} and asset_id = ${asset.id} for update`,
            "objects",
          )
        )[0] ?? null;
      if (!schedule)
        refuse("schedule_not_found", "the maintenance schedule does not belong to this asset", {
          status: 404,
        });
    }
    let sourceDocumentId: string | null = null;
    let proposalId: string | null = null;
    if (input.sourceDocumentLineId) {
      const source = (
        await tx.execute<{
          document_id: string;
          kind: string;
          status: string;
          subsidiary_id: string | null;
        }>(
          sql`
        select d.id as document_id, d.kind, d.status, d.subsidiary_id
          from document_lines dl join documents d on d.org_id = dl.org_id and d.id = dl.document_id
         where dl.org_id = ${orgId} and dl.id = ${input.sourceDocumentLineId}`,
          "objects",
        )
      )[0];
      if (!source) refuse("source_line_not_found", "the bill line was not found", { status: 404 });
      if (source.status !== "posted")
        refuse("source_not_posted", "link a line of a posted bill or expense report");
      if (source.subsidiary_id !== null && source.subsidiary_id !== asset.subsidiary_id) {
        refuse(
          "source_wrong_subsidiary",
          "the bill belongs to a different legal entity than the asset",
        );
      }
      sourceDocumentId = source.document_id;
      if (input.treatment === "betterment") {
        if (!(await lockAndCheckOrgFeature(tx, orgId, "assetProposals"))) {
          refuse(
            "feature_disabled",
            "betterments are capitalized through asset proposals, which are switched off",
            {
              status: 409,
              remedy:
                "Turn on Asset proposals under Fixed Assets in Company Settings → Features, or record the work as an expense.",
            },
          );
        }
        const journalLineId = await journalLineForDocumentLine(
          tx,
          orgId,
          input.sourceDocumentLineId,
        );
        if (!journalLineId)
          refuse(
            "source_line_not_proposable",
            "the bill line has no posted debit that can be capitalized",
          );
        proposalId = (
          await proposeJournalLine(orgId, {
            journalLineId,
            actorId: options.actorId,
            allowedSubsidiaryIds: options.allowedSubsidiaryIds,
          })
        ).proposalId;
      }
    }
    if (usage !== null && schedule?.usage_unit) {
      await insertReading(tx, {
        orgId,
        assetId: asset.id,
        readOn: input.performedOn,
        reading: usage,
        unit: schedule.usage_unit,
        memo: description.slice(0, 200),
        actorId: options.actorId,
      });
    }
    const row = (
      await tx.execute<{ id: string }>(
        sql`
      insert into asset_maintenance_records
        (org_id, asset_id, schedule_id, performed_on, usage_reading, description, vendor_party_id, cost, treatment,
         source_document_id, source_document_line_id, proposal_id, created_by)
      values
        (${orgId}, ${asset.id}, ${schedule?.id ?? null}, ${input.performedOn}, ${usage}, ${description},
         ${input.vendorPartyId || null}, ${cost}, ${input.treatment}, ${sourceDocumentId}, ${input.sourceDocumentLineId ?? null},
         ${proposalId}, ${options.actorId})
      returning id`,
        "objects",
      )
    )[0];
    if (!row) throw new Error("the maintenance record was not stored");
    if (schedule) await refreshScheduleFromRecords(tx, orgId, schedule.id, options.actorId);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'asset_maintenance_records', ${row.id}, 'insert',
              ${JSON.stringify({ before: null, after: { ...input, cost, usageReading: usage, sourceDocumentId, proposalId } })}::jsonb, ${options.actorId})`);
    return { id: row.id, proposalId };
  });
}

/** Cancel a record entered in error; its schedule's due point is recomputed. */
export async function cancelMaintenanceRecord(
  orgId: string,
  args: {
    recordId: string;
    reason: string;
    actorId: string;
    allowedSubsidiaryIds?: readonly string[] | null;
  },
): Promise<void> {
  const reason = args.reason.trim();
  if (!reason) refuse("reason_required", "state why the record is cancelled");
  await withOrgTransaction(orgId, async () => {
    const tx: SqlExecutor = db;
    const record = (
      await tx.execute<{ asset_id: string; schedule_id: string | null; status: string }>(
        sql`
      select asset_id, schedule_id, status from asset_maintenance_records
       where org_id = ${orgId} and id = ${args.recordId} for update`,
        "objects",
      )
    )[0];
    if (!record) refuse("record_not_found", "maintenance record not found", { status: 404 });
    const asset = await lockAsset(tx, orgId, record.asset_id, args.allowedSubsidiaryIds);
    await assertAssetAccess(tx, {
      orgId,
      actorId: args.actorId,
      permission: "assets.maintain",
      feature: "assetMaintenance",
      subsidiaryIds: [asset.subsidiary_id],
    });
    if (record.status !== "recorded")
      refuse("record_cancelled", "the record is already cancelled", { status: 409 });
    const updated = (
      await tx.execute<{ id: string }>(
        sql`
      update asset_maintenance_records
         set status = 'cancelled', cancelled_at = clock_timestamp(), cancelled_by = ${args.actorId}, cancel_reason = ${reason}
       where org_id = ${orgId} and id = ${args.recordId} and status = 'recorded'
       returning id`,
        "objects",
      )
    )[0];
    if (!updated) throw new Error("the maintenance record was not cancelled; no row changed");
    if (record.schedule_id)
      await refreshScheduleFromRecords(tx, orgId, record.schedule_id, args.actorId);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'asset_maintenance_records', ${args.recordId}, 'update',
              ${JSON.stringify({ before: { status: "recorded" }, after: { status: "cancelled" }, reason })}::jsonb, ${args.actorId})`);
  });
}

export interface MaintenanceQueueRow {
  scheduleId: string;
  assetId: string;
  assetNumber: string;
  assetName: string;
  subsidiaryId: string;
  name: string;
  nextDueOn: string | null;
  nextDueUsage: string | null;
  usageUnit: string | null;
  currentUsage: string | null;
  leadDays: number;
  standing: MaintenanceStanding;
}

/** Active schedules of live assets with where each stands today. */
export async function maintenanceQueue(
  tx: SqlExecutor,
  orgId: string,
  args: {
    today: string;
    allowedSubsidiaryIds?: readonly string[] | null;
    scheduleIds?: readonly string[];
  },
): Promise<MaintenanceQueueRow[]> {
  const rows = await tx.execute<{
    id: string;
    asset_id: string;
    asset_number: string;
    asset_name: string;
    subsidiary_id: string;
    name: string;
    next_due_on: string | null;
    next_due_usage: string | null;
    usage_unit: string | null;
    current_usage: string | null;
    lead_days: number;
  }>(
    sql`
    select s.id, s.asset_id, a.asset_number, a.name as asset_name, a.subsidiary_id, s.name,
           s.next_due_on::text as next_due_on, s.next_due_usage::text as next_due_usage, s.usage_unit, s.lead_days,
           (select max(r.reading)::text from asset_usage_readings r
             where r.org_id = s.org_id and r.asset_id = s.asset_id and lower(r.unit) = lower(s.usage_unit)) as current_usage
      from asset_maintenance_schedules s
      join fixed_assets a on a.org_id = s.org_id and a.id = s.asset_id
     where s.org_id = ${orgId} and s.is_active
       and a.status = any(${`{${LIVE_ASSET_STATUSES.join(",")}}`}::text[])
       ${args.allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${uuidArray([...args.allowedSubsidiaryIds])}::uuid[])` : sql``}
       ${args.scheduleIds ? sql`and s.id = any(${uuidArray([...args.scheduleIds])}::uuid[])` : sql``}
     order by s.next_due_on nulls last, a.asset_number`,
    "objects",
  );
  return rows.map((row) => ({
    scheduleId: row.id,
    assetId: row.asset_id,
    assetNumber: row.asset_number,
    assetName: row.asset_name,
    subsidiaryId: row.subsidiary_id,
    name: row.name,
    nextDueOn: row.next_due_on,
    nextDueUsage: row.next_due_usage === null ? null : add(row.next_due_usage, "0"),
    usageUnit: row.usage_unit,
    currentUsage: row.current_usage === null ? null : add(row.current_usage, "0"),
    leadDays: row.lead_days,
    standing: maintenanceStanding({
      today: args.today,
      nextDueOn: row.next_due_on,
      nextDueUsage: row.next_due_usage,
      currentUsage: row.current_usage,
      leadDays: row.lead_days,
    }),
  }));
}

/**
 * Daily scan: notify maintainers once per schedule, due point and stage
 * (due, then overdue). Re-running the scan changes nothing.
 */
export async function runMaintenanceAlertScan(
  _now: Date,
): Promise<{ orgId: string; notified: number }[]> {
  const results: { orgId: string; notified: number }[] = [];
  for (const orgId of await orgsWithAssetFeature("assetMaintenance")) {
    const notified = await withOrgTransaction(orgId, async () => {
      const tx: SqlExecutor = db;
      if (!(await lockAndCheckOrgFeature(tx, orgId, "assetMaintenance"))) return 0;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"asset-maintenance-alerts:" + orgId}, 0))`,
      );
      const today = await businessToday(orgId);
      let count = 0;
      for (const row of await maintenanceQueue(tx, orgId, { today })) {
        if (row.standing === "scheduled") continue;
        const inserted = (
          await tx.execute<{ id: string }>(
            sql`
          insert into asset_maintenance_alerts (org_id, schedule_id, due_key, stage)
          values (${orgId}, ${row.scheduleId}, ${maintenanceDueKey(row.nextDueOn, row.nextDueUsage)}, ${row.standing})
          -- Each due point notifies once per stage; a repeat scan finds the row and stays quiet.
          on conflict (org_id, schedule_id, due_key, stage) do nothing
          returning id`,
            "objects",
          )
        )[0];
        if (!inserted) continue;
        const when = [
          row.nextDueOn,
          row.nextDueUsage && row.usageUnit ? `${row.nextDueUsage} ${row.usageUnit}` : null,
        ]
          .filter(Boolean)
          .join(" / ");
        count += await notifyAssetOperators(tx, {
          orgId,
          subsidiaryId: row.subsidiaryId,
          permission: "assets.maintain",
          kind: "asset_maintenance_due",
          title: `${row.standing === "overdue" ? "Overdue" : "Due"}: ${row.name} — ${row.assetNumber}`,
          body: `${row.assetName}: ${row.name} is ${row.standing}${when ? ` (${when})` : ""}.`,
          href: `/assets/maintenance?schedule=${row.scheduleId}`,
        });
      }
      return count;
    });
    results.push({ orgId, notified });
  }
  return results;
}
