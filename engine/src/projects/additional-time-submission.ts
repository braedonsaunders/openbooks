import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import {
  lockSharedTimeAuthority,
  TimeWorkTargetError,
  type TimeWorkFamily,
} from "./time-work-target.ts";
import { timesheetWeekStart } from "./timesheet-weeks.ts";

export type AdditionalTimeSelection = { id: string; updatedAt: string };
export type PreparedAdditionalTimeSubmission = {
  headerId: string;
  headerStatus: string;
  priorApproval: { actorId: string | null; approvedAt: string | null };
  entries: {
    id: string;
    status: string;
    updatedAt: string;
    workedOn: string;
    hours: string;
    fieldTicketId: string | null;
  }[];
};

/** Pin an explicitly reviewed selection in the same transaction as its
 * submission and workflow dispatch. Previously approved time is untouched. */
export async function prepareAdditionalTimeSubmission(
  tx: SqlExecutor,
  input: {
    orgId: string;
    actorId: string;
    employeePartyId: string;
    weekStart: string;
    selections: readonly AdditionalTimeSelection[];
    requestedScope: ReadonlySet<string> | null;
    workFamily?: TimeWorkFamily;
  },
): Promise<PreparedAdditionalTimeSubmission> {
  const refuse = (message: string, code: string) =>
    new TimeWorkTargetError(
      message,
      409,
      code,
      "Reload the week, review its pending entries, and submit the intended selection.",
    );
  if (
    !isIsoCalendarDate(input.weekStart) ||
    timesheetWeekStart(input.weekStart) !== input.weekStart ||
    input.selections.length === 0 ||
    input.selections.length > 250 ||
    input.selections.some(
      (row) =>
        !isUuid(row.id) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.updatedAt),
    ) ||
    new Set(input.selections.map((row) => row.id)).size !== input.selections.length
  ) {
    throw refuse("The additional-time selection is invalid.", "additional_time_selection_invalid");
  }
  const through = new Date(`${input.weekStart}T00:00:00Z`);
  through.setUTCDate(through.getUTCDate() + 6);
  await lockSharedTimeAuthority(tx, input.orgId, input.actorId, {
    employeeId: input.employeePartyId,
    from: input.weekStart,
    through: through.toISOString().slice(0, 10),
    requestedScope: input.requestedScope,
    permission: "time.manage",
    workFamily: input.workFamily,
  });
  const header = (
    await tx.execute<{
      id: string;
      status: string;
      approvedBy: string | null;
      approvedAt: string | null;
    }>(
      sql`
    select id, status, approved_by as "approvedBy", approved_at::text as "approvedAt"
      from timesheet_weeks where org_id = ${input.orgId}
       and employee_party_id = ${input.employeePartyId} and week_start = ${input.weekStart}::date
     for update
  `,
      "objects",
    )
  )[0];
  if (!header || !["approved", "draft", "rejected"].includes(header.status)) {
    throw refuse(
      "Selected time can be submitted only from a draft, returned or approved week.",
      "additional_time_week_changed",
    );
  }
  const waiting = (
    await tx.execute<{ count: number }>(
      sql`
    select count(*)::int as count from time_entries
     where org_id = ${input.orgId} and employee_party_id = ${input.employeePartyId}
       and worked_on between ${input.weekStart}::date and ${input.weekStart}::date + 6
       and status = 'submitted'
  `,
      "objects",
    )
  )[0];
  const gates = (
    await tx.execute<{ count: number }>(
      sql`
    select count(*)::int as count from flow_gates where org_id = ${input.orgId}
      and subject_kind = 'timesheet_week' and subject_id = ${header.id}
      and status in ('pending', 'escalated')
  `,
      "objects",
    )
  )[0];
  if (!waiting || !gates || waiting.count > 0 || gates.count > 0) {
    throw refuse(
      "This week already has a submission awaiting a decision.",
      "additional_time_review_pending",
    );
  }
  type SelectedRow = {
    id: string;
    status: string;
    updatedAt: string;
    workedOn: string;
    hours: string;
    fieldTicketId: string | null;
    consumed: boolean;
  };
  const ids = input.selections.map((row) => row.id);
  const selected = await tx.execute<SelectedRow>(
    sql`
    select id, status, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt",
           worked_on::text as "workedOn", hours::text as hours, field_ticket_id as "fieldTicketId",
           (invoiced_by_line_id is not null or payroll_batch_ref is not null or cost_journal_entry_id is not null
            or overhead_journal_entry_id is not null or production_consumed_operation_id is not null
            or billing_status <> 'unbilled' or amends_entry_id is not null or corrects_entry_id is not null) as consumed
      from time_entries where org_id = ${input.orgId} and employee_party_id = ${input.employeePartyId}
       and worked_on between ${input.weekStart}::date and ${input.weekStart}::date + 6
       and id = any(${`{${ids.join(",")}}`}::uuid[])
     order by id for update
  `,
    "objects",
  );
  if (
    selected.length !== ids.length ||
    selected.some(
      (row) =>
        row.consumed ||
        !["draft", "rejected"].includes(row.status) ||
        input.selections.find((selection) => selection.id === row.id)?.updatedAt !== row.updatedAt,
    )
  ) {
    throw refuse(
      "The selected time changed or is no longer available for submission.",
      "additional_time_selection_changed",
    );
  }
  return {
    headerId: header.id,
    headerStatus: header.status,
    priorApproval: { actorId: header.approvedBy, approvedAt: header.approvedAt },
    entries: selected.map(({ id, status, updatedAt, workedOn, hours, fieldTicketId }) => ({
      id,
      status,
      updatedAt,
      workedOn,
      hours,
      fieldTicketId,
    })),
  };
}
