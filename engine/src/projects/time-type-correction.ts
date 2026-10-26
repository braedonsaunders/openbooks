import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { cmp } from "../money/money.ts";
import {
  lockSharedTimeAuthority,
  TimeWorkTargetError,
  type TimeWorkFamily,
} from "./time-work-target.ts";
import { timesheetWeekStart } from "./timesheet-weeks.ts";

export type TimeTypeCorrection = {
  employeePartyId: string;
  weekStart: string;
  entryId: string;
  expectedUpdatedAt: string;
  timeTypeId: string;
  timeTypeUpdatedAt: string;
  commandId: string;
  reason: string;
};
const revision = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

type CorrectionInput = TimeTypeCorrection & {
  orgId: string;
  actorId: string;
  requestedScope: ReadonlySet<string> | null;
  workFamily?: TimeWorkFamily;
};
/** Every caller shares one atomic tenant write and audit. Only the current
 * classification changes; source evidence, hours, lifecycle and financial
 * snapshots do not. Approval resolves rates separately. */
export async function correctUnapprovedTimeType(
  input: CorrectionInput,
): Promise<{ changed: boolean; replayed: boolean }> {
  return withOrgTransaction(input.orgId, () => correctTimeTypeInTransaction(db, input));
}

async function correctTimeTypeInTransaction(
  tx: SqlExecutor,
  input: CorrectionInput,
): Promise<{ changed: boolean; replayed: boolean }> {
  const refuse = (
    message: string,
    code = "time_type_correction_refused",
    remedy = "Reload the week and review the individual unapproved entry before correcting its time type.",
  ) => new TimeWorkTargetError(message, 409, code, remedy);
  if (
    ![input.entryId, input.employeePartyId, input.timeTypeId, input.commandId].every(isUuid) ||
    !isIsoCalendarDate(input.weekStart) ||
    timesheetWeekStart(input.weekStart) !== input.weekStart ||
    !revision.test(input.expectedUpdatedAt) ||
    !revision.test(input.timeTypeUpdatedAt) ||
    input.reason.trim().length < 10 ||
    input.reason.trim().length > 500
  ) {
    throw refuse("The time-type correction is invalid.", "time_type_correction_invalid");
  }
  const through = new Date(`${input.weekStart}T00:00:00Z`);
  through.setUTCDate(through.getUTCDate() + 6);
  await lockSharedTimeAuthority(tx, input.orgId, input.actorId, {
    employeeId: input.employeePartyId,
    from: input.weekStart,
    through: through.toISOString().slice(0, 10),
    permission: "time.manage",
    requestedScope: input.requestedScope,
    workFamily: input.workFamily,
  });
  const header = (
    await tx.execute<{ id: string; status: string }>(
      sql`
    select id, status from timesheet_weeks where org_id=${input.orgId}
      and employee_party_id=${input.employeePartyId} and week_start=${input.weekStart}::date for update
  `,
      "objects",
    )
  )[0];
  if (!header || !["draft", "rejected", "approved"].includes(header.status)) {
    throw refuse(
      "This week is awaiting a decision.",
      "time_type_week_submitted",
      "Have the approver reject the submitted time, or withdraw your pending submission, before correcting it.",
    );
  }
  const pending = (
    await tx.execute<{ blocked: boolean }>(
      sql`
    select exists(select 1 from time_entries where org_id=${input.orgId}
      and employee_party_id=${input.employeePartyId}
      and worked_on between ${input.weekStart}::date and ${input.weekStart}::date + 6
      and status='submitted') or exists(select 1 from flow_gates where org_id=${input.orgId}
      and subject_kind='timesheet_week' and subject_id=${header.id} and status in ('pending','escalated')) as blocked
  `,
      "objects",
    )
  )[0];
  if (!pending || pending.blocked)
    throw refuse("A submission or approval workflow still holds this week.");
  const source = (
    await tx.execute<{ fieldTicketId: string | null }>(
      sql`
    select field_ticket_id as "fieldTicketId" from time_entries where org_id=${input.orgId}
      and id=${input.entryId} and employee_party_id=${input.employeePartyId}
      and worked_on between ${input.weekStart}::date and ${input.weekStart}::date + 6
  `,
      "objects",
    )
  )[0];
  if (!source) throw refuse("The time entry is unavailable.");
  if (source.fieldTicketId) {
    const ticket = (
      await tx.execute<{ status: string; captured: boolean }>(
        sql`
      select d.status, exists(select 1 from field_ticket_labor_lines l
        join field_ticket_labor_snapshots s on s.org_id=l.org_id and s.id=l.snapshot_id
        where l.org_id=d.org_id and l.field_ticket_id=d.id and l.time_entry_id=${input.entryId}
          and s.field_ticket_id=d.id and s.superseded_at is null) as captured
      from documents d where d.org_id=${input.orgId} and d.id=${source.fieldTicketId}
        and d.kind='field_ticket' for share of d
    `,
        "objects",
      )
    )[0];
    if (!ticket || !["approved", "posted"].includes(ticket.status)) {
      throw refuse(
        "The source ticket has not been approved.",
        "time_type_ticket_editable",
        "Correct draft crew time on its source Field Ticket before commercial approval.",
      );
    }
    if (!ticket.captured)
      throw refuse(
        "The approved source ticket lacks retained labor evidence for this entry.",
        "time_type_ticket_evidence_missing",
        "Resolve the source ticket evidence before correcting linked time.",
      );
  }
  const entry = (
    await tx.execute<{
      id: string;
      status: string;
      updatedAt: string;
      timeTypeId: string | null;
      hours: string;
      fieldTicketId: string | null;
      raw: string;
      held: boolean;
      workOrderId: string | null;
    }>(
      sql`
    select te.id, te.status, te.hours::text as hours, te.time_type_id as "timeTypeId",
      te.field_ticket_id as "fieldTicketId", te.work_order_id as "workOrderId", to_jsonb(te)::text as raw,
      to_char(te.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt",
      (te.invoiced_by_line_id is not null or te.payroll_batch_ref is not null
       or te.cost_journal_entry_id is not null or te.overhead_journal_entry_id is not null
       or te.production_consumed_operation_id is not null or te.billing_status <> 'unbilled'
       or te.amends_entry_id is not null or te.corrects_entry_id is not null
       or te.approved_at is not null or te.approved_by is not null
       or te.cost_rate is not null or te.bill_rate is not null or te.labor_cost_rate_id is not null
       or te.wage_rate is not null or te.wage_currency is not null or te.wage_fx_rate is not null
       or te.cost_rate_currency is not null or te.cost_rate_subsidiary_id is not null
       or te.bill_rate_source_rate is not null or te.bill_rate_source_currency is not null
       or te.bill_rate_fx_rate is not null or te.bill_rate_currency is not null
       or te.bill_rate_book_id is not null or te.bill_rate_version_id is not null or te.bill_rate_line_id is not null
       or exists(select 1 from time_entries c where c.org_id=te.org_id
         and (c.amends_entry_id=te.id or c.corrects_entry_id=te.id))
       or exists(select 1 from document_lines l where l.org_id=te.org_id and l.time_entry_id=te.id)) as held
    from time_entries te where te.org_id=${input.orgId} and te.id=${input.entryId}
      and te.employee_party_id=${input.employeePartyId}
      and te.worked_on between ${input.weekStart}::date and ${input.weekStart}::date + 6 for update of te
  `,
      "objects",
    )
  )[0];
  if (
    !entry ||
    entry.fieldTicketId !== source.fieldTicketId ||
    entry.held ||
    entry.workOrderId ||
    !["draft", "rejected"].includes(entry.status) ||
    cmp(entry.hours, "0") <= 0
  ) {
    throw refuse(
      "Only unapproved, unconsumed worked time can be reclassified.",
      "time_type_entry_held",
      "Use the governed amendment for approved time; production corrections belong to their operation. Do not approve an incorrect entry to make it editable.",
    );
  }
  // A draft ticket still owns its editable crew grid. Once commercially
  // approved, its immutable labor snapshot remains the original source, while
  // this command governs the separate, unapproved time classification.
  const intent = {
    employeePartyId: input.employeePartyId,
    weekStart: input.weekStart,
    entryId: input.entryId,
    expectedUpdatedAt: input.expectedUpdatedAt,
    timeTypeId: input.timeTypeId,
    timeTypeUpdatedAt: input.timeTypeUpdatedAt,
    commandId: input.commandId,
    reason: input.reason.trim(),
    actorId: input.actorId,
  };
  const prior = await tx.execute<{ changes: { intent: unknown; after: { sourceRow: string } } }>(
    sql`
    select changes from audit_log where org_id=${input.orgId} and table_name='time_entries' and row_id=${entry.id}
      and changes->>'event'='time_type_corrected' and changes->>'commandId'=${input.commandId}
  `,
    "objects",
  );
  if (prior.length) {
    if (
      prior.length !== 1 ||
      canonicalJson(prior[0]!.changes.intent) !== canonicalJson(intent) ||
      prior[0]!.changes.after.sourceRow !== entry.raw
    ) {
      throw refuse(
        "This correction identity was used for different or subsequently changed time.",
        "time_type_replay_changed",
      );
    }
    return { changed: false, replayed: true };
  }
  if (entry.updatedAt !== input.expectedUpdatedAt)
    throw refuse("The reviewed time entry changed.", "time_type_revision_changed");
  const types = await tx.execute<{
    id: string;
    name: string;
    classification: string;
    costMultiplier: string;
    billMultiplier: string;
    excludeFromWages: boolean;
    active: boolean;
    updatedAt: string;
  }>(
    sql`
    select id, name, classification, cost_multiplier::text as "costMultiplier", bill_multiplier::text as "billMultiplier",
      exclude_from_wages as "excludeFromWages", is_active as active,
      to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
    from time_types where org_id=${input.orgId} and id in (${input.timeTypeId}, ${entry.timeTypeId}) order by id for share
  `,
    "objects",
  );
  const chosen = types.find((type) => type.id === input.timeTypeId);
  const previous = types.find((type) => type.id === entry.timeTypeId) ?? null;
  if (
    !chosen?.active ||
    chosen.excludeFromWages ||
    previous?.excludeFromWages ||
    chosen.updatedAt !== input.timeTypeUpdatedAt
  ) {
    throw refuse(
      "The reviewed worked-time type is unavailable or changed.",
      "time_type_definition_changed",
      "Reload the active worked-time types and review their cost and billing rules. Non-wage events must be recorded separately.",
    );
  }
  if (entry.timeTypeId === chosen.id) return { changed: false, replayed: false };
  const updated = await tx.execute<{ raw: string }>(
    sql`
    update time_entries te set time_type_id=${chosen.id}, updated_at=clock_timestamp(), updated_by=${input.actorId}
      where te.org_id=${input.orgId} and te.id=${entry.id} and te.status=${entry.status}
      returning to_jsonb(te)::text as raw
  `,
    "objects",
  );
  if (updated.length !== 1) throw refuse("The time entry could not be corrected.");
  const audited = await tx.execute<{ id: string }>(
    sql`
    insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
    values(${input.orgId},'time_entries',${entry.id},'update',${JSON.stringify({
      event: "time_type_corrected",
      commandId: input.commandId,
      intent,
      // Retain PostgreSQL's exact numeric serialization, not JavaScript number coercion.
      before: { timeTypeId: entry.timeTypeId, sourceRow: entry.raw },
      after: { timeTypeId: chosen.id, sourceRow: updated[0]!.raw },
      beforeType: previous,
      afterType: chosen,
      sourceTicketSnapshotUnchanged: true,
    })}::jsonb,${input.actorId}) returning id
  `,
    "objects",
  );
  if (audited.length !== 1) throw new Error("The time-type correction audit was not recorded.");
  return { changed: true, replayed: false };
}
