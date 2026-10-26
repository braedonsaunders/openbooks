import "server-only";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  businessToday,
  isIsoCalendarDate,
  parseIsoDate,
} from "@openbooks/engine/platform/business-date/module";
import { db } from "@openbooks/engine/platform/db";
import { pinInternalPerson } from "@openbooks/engine/organization/internal-person";
import { add } from "@openbooks/engine/money/money";
import { ensureTimesheetWeeks, timesheetWeekKey } from "@openbooks/engine/projects/timesheet-weeks";
import { subsidiaryScopeAllows } from "../../../lib/authz";
import { isFeatureEnabled } from "../../../lib/features";
import { TimeApprovalRefusal } from "../../../lib/time-approval-refusal";
import { loadPlannedWeek, type PlannedRow } from "../../../lib/resourcing/timesheet-prefill";
import { scheduledWork, type ScheduledWork } from "@openbooks/engine/schedule-boards/prefill";
import { subsidiaryVisibleFilter } from "../../../lib/subsidiaries";
import {
  lockReasonsFor,
  weekLockReasons,
  type EntryProvenance,
  type LockReason,
} from "../../../lib/time-lifecycle";

/**
 * Weekly-timesheet server helpers. A "timesheet" is not a table — it's the set
 * of `time_entries` for one employee across one Sunday→Saturday week. These
 * helpers turn that flat set of per-day rows into the grid shape the editor
 * wants (one line per distinct project+item+timeType+department+memo+billable,
 * with seven day columns) and back, plus the pickers the editor needs.
 */

/** True for a well-formed ISO date string (YYYY-MM-DD). */
export function isIsoDate(v: unknown): v is string {
  return isIsoCalendarDate(v);
}

/** Format a UTC-noon Date as an ISO date string (YYYY-MM-DD). */
function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Parse an ISO date as a UTC-noon Date (noon avoids any TZ day-shift). */
function parseIso(iso: string): Date {
  const date = parseIsoDate(iso);
  date.setUTCHours(12);
  return date;
}

/**
 * Normalize any ISO date to the Sunday that starts its week. Weeks run
 * Sunday→Saturday. Given a non-Sunday, walk back to Sunday.
 */
export function weekStart(iso: string): string {
  const d = parseIso(iso);
  const dow = d.getUTCDay(); // 0 = Sunday
  d.setUTCDate(d.getUTCDate() - dow);
  return toIso(d);
}

/** The current week's Sunday on the org business calendar. */
export async function currentWeekStart(orgId: string): Promise<string> {
  return weekStart(await businessToday(orgId));
}

/**
 * The week's content revision: a stable hash over the week identity, its
 * header status and the full aggregated grid content. Any save, submit,
 * approval, rejection or amendment through any route moves something it
 * covers, so the hash moves whenever the week does — and two readers of
 * identical content always agree. The weekly PUT sends it back as
 * expectedRevision; a mismatch is a lost update refused with a named 409
 * instead of a silent overwrite.
 */
export function computeWeekRevision(payload: {
  weekId: string;
  status: string;
  rows: unknown;
}): string {
  return createHash("md5")
    .update(JSON.stringify({ week: [payload.weekId, payload.status], rows: payload.rows }))
    .digest("hex");
}

/** The seven ISO dates Sun…Sat for the week that `sundayIso` starts. */
export function weekWindow(sundayIso: string): string[] {
  const sunday = weekStart(sundayIso);
  const base = parseIso(sunday);
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(toIso(d));
  }
  return out;
}

export type WeekStatus = "draft" | "submitted" | "approved" | "rejected" | "empty";

/** A single grid line: a distinct time key + its seven day-hour cells. */
/** Stable key for a line's custom values — key order must not split a row. */
export function customKey(custom: Record<string, unknown> | null | undefined): string {
  if (!custom) return "";
  const keys = Object.keys(custom)
    .filter((k) => custom[k] !== null && custom[k] !== "")
    .sort();
  if (keys.length === 0) return "";
  return JSON.stringify(keys.map((k) => [k, custom[k]]));
}

export interface WeekRow {
  projectId: string | null;
  workOrderId?: string | null;
  woOperationId?: string | null;
  itemId: string | null;
  timeTypeId: string | null;
  departmentId: string | null;
  isBillable: boolean;
  memo: string | null;
  /** hours[0]=Sunday … hours[6]=Saturday, as decimal strings ('' = none). */
  hours: string[];
  productionEntryIds?: string[][];
  /** The most locked status among this line's entries (blocks editing). */
  entryStatuses: string[];
  /** Org-defined line field values (time_entries.custom). Part of the row's
   * identity: two entries alike but for a custom value are different lines. */
  custom: Record<string, unknown>;
  /** Set when this line is an offset of a consumed original. */
  amendsEntryId: string | null;
  /** Approved, submitted, or amendment lines must not be rewritten by save. */
  immutable: boolean;
}

/**
 * Pin a timekeeper to the known tenant. Returns the owned id, or null.
 * Delegates to the shared internal-person pin: a week belongs to an active
 * person party, or an active employee party holding an active
 * `employee_roles` row. Partners and contractors log billable time as
 * people; payroll admits only employments, so their hours never reach a
 * pay run. Reads fail closed the same way — a former employee's stored
 * entries remain in the ledger and reports, but no week can be opened for
 * them until the employment is restored.
 */
export async function pinTimekeeper(
  orgId: string,
  employeeId: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<string | null> {
  const pinned = await pinInternalPerson(db, orgId, employeeId, allowedSubsidiaryIds);
  return pinned?.id ?? null;
}

/**
 * Resolve an amendment's source timekeeper without exposing an out-of-scope
 * entry to the mutation service. The timekeeper party and source entry are
 * both tenant-pinned; the subsidiary decision happens before any amendment
 * read or write can proceed.
 */
export async function pinTimekeeperEntry(
  orgId: string,
  entryId: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<string | null> {
  const source = (
    await db.execute<{
      employee_party_id: string;
      subsidiary_id: string | null;
    }>(
      sql`
    select te.employee_party_id, p.subsidiary_id
      from time_entries te
      join parties p on p.org_id = te.org_id and p.id = te.employee_party_id
     where te.org_id = ${orgId} and te.id = ${entryId}
     limit 1`,
      "objects",
    )
  )[0];
  if (!source) return null;
  if (
    allowedSubsidiaryIds !== undefined &&
    !subsidiaryScopeAllows(allowedSubsidiaryIds, source.subsidiary_id)
  ) {
    return null;
  }
  return pinTimekeeper(orgId, source.employee_party_id, allowedSubsidiaryIds);
}

export interface TimesheetLineRefs {
  projectId: string | null;
  itemId: string | null;
  timeTypeId: string | null;
  departmentId: string | null;
}

/**
 * Re-select line FKs against the known tenant and bind the owned ids.
 * Missing optional refs stay null; a leftover UUID that is not in this org
 * refuses the write instead of copying a foreign key across tenants.
 */
export async function pinTimesheetLineRefs(
  orgId: string,
  refs: TimesheetLineRefs,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<TimesheetLineRefs | null> {
  const pinOne = async (
    table: "projects" | "items" | "time_types" | "departments",
    id: string | null,
  ): Promise<string | null | "missing"> => {
    if (id == null) return null;
    const owned =
      table === "projects"
        ? await db.execute<{ id: string; subsidiary_id: string | null }>(
            sql`
          select id, subsidiary_id from projects where org_id = ${orgId} and id = ${id} limit 1`,
            "objects",
          )
        : table === "items"
          ? await db.execute<{ id: string }>(
              sql`
            select id from items where org_id = ${orgId} and id = ${id} limit 1`,
              "objects",
            )
          : table === "time_types"
            ? await db.execute<{ id: string }>(
                sql`
              select id from time_types where org_id = ${orgId} and id = ${id} limit 1`,
                "objects",
              )
            : await db.execute<{ id: string; subsidiary_id: string | null }>(
                sql`
              select id, subsidiary_id from departments where org_id = ${orgId} and id = ${id} limit 1`,
                "objects",
              );
    const row = owned[0] as { id: string; subsidiary_id?: string | null } | undefined;
    if (!row) return "missing";
    if (allowedSubsidiaryIds !== undefined && (table === "projects" || table === "departments")) {
      const orgWideNull = table === "departments";
      if (!subsidiaryScopeAllows(allowedSubsidiaryIds, row.subsidiary_id, { orgWideNull })) {
        return "missing";
      }
    }
    return row.id;
  };
  const projectId = await pinOne("projects", refs.projectId);
  const itemId = await pinOne("items", refs.itemId);
  const timeTypeId = await pinOne("time_types", refs.timeTypeId);
  const departmentId = await pinOne("departments", refs.departmentId);
  if (
    projectId === "missing" ||
    itemId === "missing" ||
    timeTypeId === "missing" ||
    departmentId === "missing"
  ) {
    return null;
  }
  return { projectId, itemId, timeTypeId, departmentId };
}

export type WeekLeaveCover = {
  requestId: string;
  leaveType: string;
  from: string;
  to: string;
};

/**
 * Approved leave overlapping a date window, newest first. Scoped to the
 * employee's own employments: another person's approved absence must never
 * surface as this week's cover story. Shared by the week loader (so the
 * declaration can name it) and the no-hours submit (so the audit records it).
 */
export async function weekLeaveCover(
  orgId: string,
  employeePartyId: string,
  fromIso: string,
  throughIso: string,
): Promise<WeekLeaveCover[]> {
  return await db.execute<WeekLeaveCover>(
    sql`
    select r.id as "requestId",
           (t.code || ' — ' || t.name) as "leaveType",
           r.starts_on::text as "from", r.ends_on::text as "to"
      from hrm_leave_requests r
      join worker_employments e on e.id = r.employment_id and e.org_id = r.org_id
      join hrm_leave_types t on t.id = r.leave_type_id and t.org_id = r.org_id
     where r.org_id = ${orgId}
       and e.worker_party_id = ${employeePartyId}
       and r.status = 'approved'
       and r.starts_on <= ${throughIso} and r.ends_on >= ${fromIso}
     order by r.starts_on desc, r.id desc
  `,
    "objects",
  );
}

export type PendingWeekEntry = {
  id: string;
  updatedAt: string;
  workedOn: string;
  hours: string;
  status: string;
  projectId: string | null;
  itemId: string | null;
  fieldTicketId: string | null;
  fieldTicketNumber: string | null;
  fieldTicketStatus: string | null;
  timeTypeId?: string | null;
  workOrderId?: string | null;
};

export interface WeekPayload {
  employeeId: string | null;
  week: string;
  days: string[];
  rows: WeekRow[];
  /** Saved pending entries are selected individually; aggregate grid rows
   * never identify which additional time an operator intends to submit. */
  pendingEntries?: PendingWeekEntry[];
  planned: PlannedRow[];
  /** Published bookings from boards that pre-fill timesheets, for one-click entry while the week is editable. */
  scheduled: ScheduledWork[];
  /** Approved leave overlapping the week, so a no-hours declaration can name
   * the absence it records instead of standing alone. */
  leaveCover: WeekLeaveCover[];
  status: WeekStatus;
  /** True when any entry in the week is approved (those must not be overwritten). */
  hasApproved: boolean;
  /** Downstream consumers pinning this week (empty when nothing holds it). */
  lockReasons: LockReason[];
  /** How many entries are pinned — drives "3 of 12 entries" style messages. */
  lockedCount: number;
  /** The approver's note when the week was bounced back. */
  rejectionReason: string | null;
  /** The header row's id — what an approval flow names as its subject. */
  weekId: string | null;
  /** Content revision of the whole week. The weekly PUT sends it back as
   *  expectedRevision; a mismatch is refused with a named 409. */
  revision: string;
}

/**
 * Load one employee's week as grid rows. Groups the flat entries by the time
 * key (project+item+timeType+department+memo+billable) and spreads each entry's
 * hours into the matching day column.
 */
export async function loadWeek(
  orgId: string,
  employeeId: string,
  sundayIso: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<WeekPayload> {
  const ownedEmployee = await pinTimekeeper(orgId, employeeId, allowedSubsidiaryIds);
  if (!ownedEmployee) throw new Error("employee not found");
  const days = weekWindow(sundayIso);
  const week = days[0]!;
  // The header owns the week's lifecycle. It is created on demand so a week
  // that has never been touched still reads consistently.
  const header = await ensureTimesheetWeek(orgId, ownedEmployee, week, null, allowedSubsidiaryIds);
  const dayIndex = new Map(days.map((d, i) => [d, i]));

  const res = await db.execute<{
    id: string;
    worked_on: string;
    hours: string;
    time_type_id: string | null;
    item_id: string | null;
    project_id: string | null;
    work_order_id: string | null;
    wo_operation_id: string | null;
    department_id: string | null;
    memo: string | null;
    is_billable: boolean;
    status: string;
    custom: Record<string, unknown> | null;
    rejection_reason: string | null;
    invoiced_by_line_id: string | null;
    payroll_batch_ref: string | null;
    cost_journal_entry_id: string | null;
    production_consumed_operation_id: string | null;
    overhead_journal_entry_id: string | null;
    field_ticket_id: string | null;
    service_visit_id: string | null;
    billing_status: "unbilled" | "billed";
    amends_entry_id: string | null;
    corrects_entry_id: string | null;
    entry_updated_at: string;
    field_ticket_number: string | null;
    field_ticket_status: string | null;
  }>(
    sql`
    select te.id, te.worked_on, te.hours, te.time_type_id, te.item_id, te.project_id, te.work_order_id, te.wo_operation_id,
           te.department_id, te.memo, te.is_billable, te.status, te.custom, te.rejection_reason,
           te.invoiced_by_line_id, te.payroll_batch_ref, te.cost_journal_entry_id,
           te.overhead_journal_entry_id, te.production_consumed_operation_id, te.field_ticket_id, te.service_visit_id, te.billing_status,
           te.amends_entry_id, te.corrects_entry_id,
           to_char(te.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as entry_updated_at,
           ticket.document_number as field_ticket_number, ticket.status as field_ticket_status
      from time_entries te
      left join documents ticket on ticket.org_id = te.org_id and ticket.id = te.field_ticket_id
     where te.org_id = ${orgId}
       and te.employee_party_id = ${ownedEmployee}
       and te.worked_on >= ${days[0]} and te.worked_on <= ${days[6]}
     order by te.created_at, te.id
  `,
    "objects",
  );
  const provenance: EntryProvenance[] = res.map((r) => ({
    invoicedByLineId: r.invoiced_by_line_id,
    payrollBatchRef: r.payroll_batch_ref,
    costJournalEntryId: r.cost_journal_entry_id,
    productionConsumedOperationId: r.production_consumed_operation_id,
    overheadJournalEntryId: r.overhead_journal_entry_id,
    fieldTicketId: r.field_ticket_id,
    billingStatus: r.billing_status,
  }));

  const byKey = new Map<string, WeekRow>();
  const allStatuses: string[] = [];
  for (const r of res) {
    allStatuses.push(r.status);
    const key = [
      r.project_id ?? "",
      r.work_order_id ?? "",
      r.wo_operation_id ?? "",
      r.item_id ?? "",
      r.time_type_id ?? "",
      r.department_id ?? "",
      r.is_billable ? "1" : "0",
      r.memo ?? "",
      customKey(r.custom),
      r.amends_entry_id ?? "",
      r.corrects_entry_id ?? "",
      r.service_visit_id ?? "",
    ].join("|");
    let row = byKey.get(key);
    if (!row) {
      row = {
        projectId: r.project_id,
        workOrderId: r.work_order_id,
        woOperationId: r.wo_operation_id,
        itemId: r.item_id,
        timeTypeId: r.time_type_id,
        departmentId: r.department_id,
        isBillable: r.is_billable,
        memo: r.memo,
        hours: ["", "", "", "", "", "", ""],
        productionEntryIds: Array.from({ length: 7 }, () => []),
        entryStatuses: [],
        custom: r.custom ?? {},
        amendsEntryId: r.amends_entry_id,
        immutable:
          r.status === "approved" ||
          r.status === "submitted" ||
          r.field_ticket_id != null ||
          r.service_visit_id != null ||
          r.amends_entry_id != null ||
          r.corrects_entry_id != null,
      };
      byKey.set(key, row);
    }
    const idx = dayIndex.get(r.worked_on);
    if (idx != null) {
      if (r.production_consumed_operation_id && !r.amends_entry_id)
        row.productionEntryIds![idx]!.push(r.id);
      row.hours[idx] = add(row.hours[idx] === "" ? "0" : row.hours[idx]!, String(r.hours));
    }
    row.entryStatuses.push(r.status);
    if (
      r.status === "approved" ||
      r.status === "submitted" ||
      r.field_ticket_id != null ||
      r.service_visit_id != null ||
      r.amends_entry_id != null ||
      r.corrects_entry_id != null
    ) {
      row.immutable = true;
    }
  }

  const rows = Array.from(byKey.values());
  const leaveCover = await weekLeaveCover(orgId, ownedEmployee, days[0]!, days[6]!);
  const status: WeekStatus =
    allStatuses.length === 0 && header.status === "draft" ? "empty" : header.status;
  const editable = status === "draft" || status === "empty" || status === "rejected";
  const nothing: [PlannedRow[], ScheduledWork[]] = [[], []];
  const [planned, scheduled]: [PlannedRow[], ScheduledWork[]] =
    editable && ownedEmployee
      ? await Promise.all([
          status === "rejected"
            ? Promise.resolve<PlannedRow[]>([])
            : loadPlannedWeek(orgId, ownedEmployee, week, allowedSubsidiaryIds ?? null),
          scheduledWork({
            orgId,
            use: "timesheets",
            workerPartyId: ownedEmployee,
            from: days[0]!,
            through: days[6]!,
          }),
        ])
      : nothing;
  return {
    employeeId: ownedEmployee,
    week,
    days,
    rows,
    pendingEntries: res
      .filter((entry) => entry.status === "draft" || entry.status === "rejected")
      .map((entry) => ({
        id: entry.id,
        updatedAt: entry.entry_updated_at,
        workedOn: entry.worked_on,
        hours: String(entry.hours),
        status: entry.status,
        projectId: entry.project_id,
        itemId: entry.item_id,
        fieldTicketId: entry.field_ticket_id,
        fieldTicketNumber: entry.field_ticket_number,
        fieldTicketStatus: entry.field_ticket_status,
        timeTypeId: entry.time_type_id,
        workOrderId: entry.work_order_id,
      })),
    planned,
    scheduled,
    leaveCover,
    // Status is the header's, not a fold over the entries: a week with no
    // hours yet is 'draft' (a real, submittable record), and 'empty' is
    // reserved for describing that it carries nothing.
    status,
    hasApproved: allStatuses.some((s) => s === "approved"),
    lockReasons: weekLockReasons(provenance),
    lockedCount: provenance.filter((e) => lockReasonsFor(e).length > 0).length,
    rejectionReason: header.rejectionReason,
    weekId: header.id,
    // Sent back by the weekly PUT as expectedRevision — see computeWeekRevision.
    revision: computeWeekRevision({ weekId: header.id, status, rows }),
  };
}

/**
 * The week's header row for a timekeeper the caller may act for, created on
 * demand with the state of the hours it covers (see ensureTimesheetWeeks).
 */
export async function ensureTimesheetWeek(
  orgId: string,
  employeePartyId: string,
  weekStartIso: string,
  actorId?: string | null,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<{ id: string; status: WeekStatus; rejectionReason: string | null }> {
  const ownedEmployee = await pinTimekeeper(orgId, employeePartyId, allowedSubsidiaryIds);
  if (!ownedEmployee) throw new Error("employee not found");
  const week = weekStart(weekStartIso);
  const headers = await ensureTimesheetWeeks(
    orgId,
    [{ employeePartyId: ownedEmployee, weekStart: week }],
    actorId ?? null,
  );
  const row = headers.get(timesheetWeekKey({ employeePartyId: ownedEmployee, weekStart: week }))!;
  return { id: row.id, status: row.status, rejectionReason: row.rejectionReason };
}

/**
 * Refuse a submission that must not dispatch. Called inside the submit
 * transaction after the header is known and the draft/rejected entries have
 * been flipped (the flip's row count rides along), before the header stamp
 * and the flow dispatch — throwing rolls all of it back.
 *
 * Two closes in one: a week whose gates are still open stays owned by its
 * approval workflow (a second submit would raise a duplicate set of gates
 * beside the live ones), and a week with no movable entries has nothing to
 * submit (an empty or already-submitted week must not raise runs and gates
 * for nothing). The header lock serializes concurrent submits so the loser
 * observes the winner's gates, or zero remaining rows, and fails closed.
 */
export async function assertWeekSubmittable(
  orgId: string,
  headerId: string,
  movedEntryCount: number,
  options: { declaredNoHours?: boolean } = {},
): Promise<void> {
  await db.execute(sql`
    select id from timesheet_weeks
     where org_id = ${orgId} and id = ${headerId}
     for update
  `);
  const openGates =
    (
      await db.execute<{ n: number }>(
        sql`
    select count(*)::int as n from flow_gates
     where org_id = ${orgId}
       and subject_kind = 'timesheet_week'
       and subject_id = ${headerId}
       and status in ('pending', 'escalated')
  `,
        "objects",
      )
    )[0]?.n ?? 0;
  if (openGates > 0) {
    throw new TimeApprovalRefusal(
      "this week is owned by a pending approval workflow — its gates must resolve first",
      "week_owned_by_workflow",
      409,
      "Decide the week through its approval flow instead of changing it directly.",
    );
  }
  if (options.declaredNoHours) {
    // An explicit "no hours" week submits a week with nothing recorded in it
    // at all, and only from draft or rejected — never over a submitted or
    // approved week, and never as a way to skip hours that were recorded.
    // Saved zero-hour declaration lines are not recorded hours: they carry
    // the week's memo and flip with the declaration instead of blocking it.
    const header = (
      await db.execute<{ status: string; entries: number }>(
        sql`
      select w.status,
             (select count(*)::int from time_entries te
               where te.org_id = w.org_id and te.employee_party_id = w.employee_party_id
                 and te.worked_on >= w.week_start and te.worked_on <= w.week_start + 6
                 and te.hours <> 0) as entries
        from timesheet_weeks w where w.org_id = ${orgId} and w.id = ${headerId}
    `,
        "objects",
      )
    )[0];
    if (!header || (header.status !== "draft" && header.status !== "rejected")) {
      throw new Error("nothing to submit — the week is already submitted or approved");
    }
    if (header.entries > 0) {
      throw new Error(
        "nothing to submit as a no-hours week — this week has recorded hours; submit them instead",
      );
    }
    return;
  }
  if (movedEntryCount === 0) {
    throw new Error(
      "nothing to submit — the week has no draft or rejected entries; if you worked no hours, declare a no-hours week with a reason",
    );
  }
}

/** Move a week's header to a new status, stamping the matching audit columns. */
export async function setTimesheetWeekStatus(
  orgId: string,
  employeePartyId: string,
  weekStartIso: string,
  status: WeekStatus,
  actorId: string,
  rejectionReason?: string | null,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<void> {
  const ownedEmployee = await pinTimekeeper(orgId, employeePartyId, allowedSubsidiaryIds);
  if (!ownedEmployee) throw new Error("employee not found");
  const week = weekStart(weekStartIso);
  // Explicit casts: an untyped `null` in a CASE makes postgres infer text for
  // the whole expression, which a uuid column rejects.
  const updated = await db.execute<{ id: string }>(
    sql`
    update timesheet_weeks
       set status = ${status},
           submitted_by = case when ${status} = 'submitted'
                               then ${actorId}::uuid else submitted_by end,
           submitted_at = case when ${status} = 'submitted'
                               then now() else submitted_at end,
           approved_by = case when ${status} = 'approved'
                              then ${actorId}::uuid else null::uuid end,
           approved_at = case when ${status} = 'approved'
                              then now() else null::timestamptz end,
           rejection_reason = ${rejectionReason ?? null}::text,
           updated_by = ${actorId}::uuid, updated_at = now()
     where org_id = ${orgId} and employee_party_id = ${ownedEmployee}
       and week_start = ${week}::date
     returning id`,
    "objects",
  );
  if (updated.length !== 1) {
    throw new Error("timesheet week not found");
  }
}

export interface PickerOption {
  value: string;
  label: string;
}
export interface TimeTypeOption extends PickerOption {
  costMultiplier: string;
  /** Present in current native picker responses; older cached pickers cannot authorize corrections. */
  billMultiplier?: string;
  excludeFromWages?: boolean;
  updatedAt?: string;
  isBillableDefault: boolean;
  /** Semantic class (regular, overtime, …); the grid default is the standard type, never list position. */
  classification: string;
  /** The org's standard time type. Exactly one list entry carries this. */
  isDefault: boolean;
}

/**
 * Flag the org's standard time type: the first regular-classification entry
 * in list order. New grid lines default to the flagged entry, never to list
 * position. With no regular type nothing is flagged and callers fall back to
 * the list head — an explicit absence of a standard type, not a guess.
 */
function flagStandardTimeType(options: TimeTypeOption[]): TimeTypeOption[] {
  const standard = options.find((option) => option.classification === "regular");
  if (standard) standard.isDefault = true;
  return options;
}

export interface TimesheetPickers {
  employees: PickerOption[];
  projects: PickerOption[];
  /** Internal (shop/overhead) project ids: non-billable by policy, so lines
   * targeting them never pre-check billable. */
  internalProjectIds: string[];
  items: PickerOption[];
  timeTypes: TimeTypeOption[];
  departments: PickerOption[];
}

/**
 * Load every picker the weekly editor needs, for one org.
 *
 * `includeEmployeeId` keeps a specific timekeeper in the list even when they
 * are inactive or no longer hold an employee role, so the picker still names
 * the timesheet's own timekeeper instead of rendering blank. Opening the
 * week still requires a timekeeper (see pinTimekeeper): historical entries
 * remain in the ledger and reports, but no week loads for a former employee
 * until the employment is restored.
 */
export async function loadPickers(
  orgId: string,
  includeEmployeeId?: string | null,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<TimesheetPickers> {
  const equipmentEnabled = await isFeatureEnabled(orgId, "equipment");
  // Equipment stays on stored week entries. The picker only omits the kind
  // once the Features switch is off so a draft cannot add a new one.
  const catalogItemKinds = [
    "service",
    "labor",
    "other_charge",
    ...(equipmentEnabled ? ["equipment_charge"] : []),
  ];
  const [employees, projects, items, timeTypes, departments] = await Promise.all([
    db.execute<Record<string, unknown>>(
      sql`
      select p.id, coalesce(p.display_name, '') as label,
             (p.is_active and p.kind in ('person', 'employee') and (
               p.kind = 'person'
               or exists (
                 select 1 from employee_roles r
                  where r.party_id = p.id and r.org_id = p.org_id and r.is_active
               )
             )) as currently_active
            from parties p
           where p.org_id = ${orgId}
             ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds ?? null)}
             and (
           (p.is_active and p.kind in ('person', 'employee') and (
             p.kind = 'person'
             or exists (
               select 1 from employee_roles r
                where r.party_id = p.id and r.org_id = p.org_id and r.is_active
             )
           ))
           or p.id = ${includeEmployeeId ?? null}
         )
       order by p.display_name`,
      "objects",
    ),
    db.execute<Record<string, unknown>>(
      sql`
          select p.id, p.code, p.name, p.is_internal from projects p
           where p.org_id = ${orgId} and p.is_active
             ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds ?? null)}
           order by p.name`,
      "objects",
    ),
    db.execute<Record<string, unknown>>(
      sql`
      select id, code, name from items
       where org_id = ${orgId} and is_active
         and kind in (${sql.join(
           catalogItemKinds.map((kind) => sql`${kind}`),
           sql`, `,
         )})
       order by name`,
      "objects",
    ),
    db.execute<Record<string, unknown>>(
      sql`
      select id, name, classification, cost_multiplier, bill_multiplier, exclude_from_wages, is_billable_default,
        to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at from time_types
       where org_id = ${orgId} and is_active order by cost_multiplier`,
      "objects",
    ),
    db.execute<Record<string, unknown>>(
      sql`
          select d.id, d.code, d.name from departments d
           where d.org_id = ${orgId} and d.is_active
             ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds ?? null, { orgWideNull: true })}
           order by d.name`,
      "objects",
    ),
  ]);

  const withCode = (r: Record<string, unknown>): PickerOption => ({
    value: String(r.id),
    label: r.code ? `${r.code} · ${r.name as string}` : (r.name as string),
  });

  return {
    employees: employees.map((r) => ({
      value: String(r.id),
      label: ((r.label as string) || "(unnamed)") + (r.currently_active ? "" : " (inactive)"),
    })),
    projects: projects.map(withCode),
    internalProjectIds: projects.filter((r) => r.is_internal === true).map((r) => String(r.id)),
    items: items.map(withCode),
    timeTypes: flagStandardTimeType(
      timeTypes.map((r) => ({
        value: String(r.id),
        label: r.name as string,
        classification: String(r.classification ?? "regular"),
        costMultiplier: String(r.cost_multiplier),
        billMultiplier: String(r.bill_multiplier),
        excludeFromWages: r.exclude_from_wages === true,
        updatedAt: String(r.updated_at),
        isBillableDefault: r.is_billable_default === true,
        isDefault: false,
      })),
    ),
    departments: departments.map(withCode),
  };
}

/** Resolve the person party a user should default to, if any (users.party_id). */
export async function userEmployeeId(orgId: string, userId: string): Promise<string | null> {
  const r = await db.execute<{ party_id: string | null }>(
    sql`
    select party_id from users where id = ${userId} and org_id = ${orgId}
  `,
    "objects",
  );
  return r[0]?.party_id ?? null;
}
