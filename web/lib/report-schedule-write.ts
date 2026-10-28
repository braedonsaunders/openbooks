import "server-only";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import {
  computeNextRunAt,
  normalizeReportRecipientEmails,
  validateCadenceInput,
} from "@openbooks/reports";
import { can, type Authz } from "./authz";
import {
  canAccessReportDefinition,
  reportArtifactAccessDetail,
  snapshotReportAuthorization,
} from "./report-execution-context";
import { loadReportDefinition } from "./custom-reports";
import {
  ApplicationError,
  conflict,
  forbidden,
  invalidInput,
  notFound,
} from "./application/errors";

export type CreateReportScheduleInput = {
  definitionId: string;
  cadence: "daily" | "weekly" | "monthly";
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  hour?: number;
  minute?: number;
  timezone: string;
  recipientEmails: string[];
  active?: boolean;
  statementParams?: Record<string, unknown>;
};

/** Create a delivery schedule with the same policy, authorization snapshot and audit as the schedule form. */
export async function createReportSchedule(
  authz: Authz,
  input: CreateReportScheduleInput,
  requestId: string | null,
) {
  if (!can(authz, "reports.schedule")) throw forbidden("reports.schedule");
  const orgId = authz.user.orgId;
  const definition = await loadReportDefinition(orgId, input.definitionId);
  if (!definition) throw notFound("report");
  if (!(await canAccessReportDefinition(authz, definition))) throw forbidden("reports.read");
  let cadence;
  let recipients: string[];
  try {
    cadence = validateCadenceInput(input);
    recipients = normalizeReportRecipientEmails(input.recipientEmails);
  } catch (error) {
    throw invalidInput(
      error instanceof Error ? error.message : "Invalid report schedule cadence or recipients.",
    );
  }
  if (input.active !== false && recipients.length === 0) {
    throw invalidInput("At least one recipient is required for an active schedule.");
  }
  let filters: Record<string, unknown> | null = null;
  if (input.statementParams !== undefined) {
    if (definition.report_type !== "statement")
      throw invalidInput("statementParams only apply to statement reports.");
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.statementParams)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/.test(key))
        throw invalidInput(`invalid statement param ${key}`);
      if (typeof value !== "string" || value.length > 256)
        throw invalidInput(`invalid value for statement param ${key}`);
      if (value) clean[key] = value;
    }
    if (Object.keys(clean).length > 0) filters = { statementParams: clean };
  }
  const nextRunAt = computeNextRunAt(cadence);
  const authorization = snapshotReportAuthorization(authz, definition);
  return withOrgTransaction(orgId, async () => {
    const inserted = await db.execute<Record<string, unknown>>(
      sql`
      insert into report_schedules (org_id, definition_id, cadence, day_of_week, day_of_month,
                                    hour, minute, timezone, recipient_emails, filters, next_run_at, active,
                                    created_by, updated_by, authorization_snapshot)
      values (${orgId}, ${definition.id}, ${cadence.cadence}, ${cadence.dayOfWeek}, ${cadence.dayOfMonth},
              ${cadence.hour}, ${cadence.minute}, ${cadence.timezone}, ${JSON.stringify(recipients)}::jsonb,
              ${filters ? JSON.stringify(filters) : null}::jsonb,
              ${nextRunAt.toISOString()}, ${input.active !== false}, ${authz.user.id}, ${authz.user.id}, ${JSON.stringify(authorization)}::jsonb)
      returning id, definition_id, cadence, day_of_week, day_of_month, hour, minute,
                timezone, recipient_emails, next_run_at, active
    `,
      "objects",
    );
    const created = inserted[0];
    if (!created)
      throw conflict("The report schedule was not created; retry from the current definition.");
    const audit = await db.execute(
      sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, at, request_id)
      values (${orgId}, 'report_schedules', ${created.id}, 'insert',
        ${JSON.stringify({ reason: "report schedule created", before: null, after: { ...created, authorization_snapshot: authorization } })}::jsonb,
        ${authz.user.id}, now(), ${requestId})
      returning row_id
    `,
      "objects",
    );
    if (!audit[0]) throw conflict("The report schedule audit record was not written.");
    return created;
  });
}

type ScheduleRow = {
  id: string;
  definition_id: string;
  cadence: "daily" | "weekly" | "monthly";
  day_of_week: number | null;
  day_of_month: number | null;
  hour: number;
  minute: number;
  timezone: string;
  recipient_emails: string[];
  next_run_at: string;
  active: boolean;
  authorization_snapshot: unknown;
  [key: string]: unknown;
};

function scheduleReason(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 500) : fallback;
}

async function loadAuthorizedSchedule(authz: Authz, id: string) {
  const existing = (
    await db.execute<ScheduleRow>(
      sql`select * from report_schedules where id = ${id} and org_id = ${authz.user.orgId} for update`,
      "objects",
    )
  )[0];
  if (!existing) throw notFound("record");
  const definition = await loadReportDefinition(authz.user.orgId, existing.definition_id);
  if (!definition || !(await canAccessReportDefinition(authz, definition))) {
    throw new ApplicationError("forbidden", "report access denied", 403);
  }
  if (existing.authorization_snapshot != null) {
    const access = await reportArtifactAccessDetail(authz, existing.authorization_snapshot);
    if (!access.ok) {
      throw new ApplicationError(
        "forbidden",
        access.missingPermissions.length > 0
          ? `this schedule's authorized report content requires ${access.missingPermissions.join(", ")}`
          : "original report scope access denied",
        403,
      );
    }
  }
  return existing;
}

/** Update one schedule through the same locked, audited path used by its route. */
export async function updateReportSchedule(
  authz: Authz,
  id: string,
  input: {
    cadence?: "daily" | "weekly" | "monthly";
    dayOfWeek?: number | null;
    dayOfMonth?: number | null;
    hour?: number;
    minute?: number;
    timezone?: string;
    recipientEmails?: string[];
    active?: boolean;
    reason?: string;
  },
  requestId: string | null,
) {
  if (!can(authz, "reports.schedule")) throw forbidden("reports.schedule");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("record");
  return withOrgTransaction(authz.user.orgId, async () => {
    const existing = await loadAuthorizedSchedule(authz, id);
    let cadence;
    let recipients: string[];
    try {
      cadence = validateCadenceInput({
        cadence: input.cadence ?? existing.cadence,
        dayOfWeek: input.dayOfWeek ?? existing.day_of_week,
        dayOfMonth: input.dayOfMonth ?? existing.day_of_month,
        hour: input.hour ?? existing.hour,
        minute: input.minute ?? existing.minute,
        timezone: input.timezone ?? existing.timezone,
      });
      recipients = normalizeReportRecipientEmails(
        input.recipientEmails ?? existing.recipient_emails,
      );
    } catch (error) {
      throw invalidInput(
        error instanceof Error ? error.message : "Invalid report schedule cadence or recipients.",
      );
    }
    const active = input.active ?? existing.active;
    if (active && recipients.length === 0)
      throw invalidInput("At least one recipient is required for an active schedule");
    const nextRunAt = computeNextRunAt(cadence);
    const updated = (
      await db.execute<ScheduleRow>(
        sql`
          update report_schedules set
            cadence = ${cadence.cadence}, day_of_week = ${cadence.dayOfWeek}, day_of_month = ${cadence.dayOfMonth},
            hour = ${cadence.hour}, minute = ${cadence.minute}, timezone = ${cadence.timezone},
            recipient_emails = ${JSON.stringify(recipients)}::jsonb,
            next_run_at = ${nextRunAt.toISOString()}, active = ${active},
            updated_at = now(), updated_by = ${authz.user.id}
          where id = ${id} and org_id = ${authz.user.orgId}
          returning *
        `,
        "objects",
      )
    )[0];
    if (!updated) throw notFound("record");
    const audit = await db.execute(
      sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, at, request_id)
        values
          (${authz.user.orgId}, 'report_schedules', ${id}, 'update',
           ${JSON.stringify({ reason: scheduleReason(input.reason, "report schedule updated"), before: existing, after: updated })}::jsonb,
           ${authz.user.id}, now(), ${requestId})
        returning row_id
      `,
      "objects",
    );
    if (!audit[0]) throw conflict("The report schedule audit record was not written.");
    return updated;
  });
}

/** Delete one schedule through the same locked, audited path used by its route. */
export async function deleteReportSchedule(
  authz: Authz,
  id: string,
  reason: string | undefined,
  requestId: string | null,
) {
  if (!can(authz, "reports.schedule")) throw forbidden("reports.schedule");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("record");
  return withOrgTransaction(authz.user.orgId, async () => {
    const existing = await loadAuthorizedSchedule(authz, id);
    const removed = await db.execute<{ id: string }>(
      sql`delete from report_schedules where id = ${id} and org_id = ${authz.user.orgId} returning id`,
      "objects",
    );
    if (!removed[0]) throw notFound("record");
    const audit = await db.execute(
      sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, at, request_id)
        values
          (${authz.user.orgId}, 'report_schedules', ${id}, 'delete',
           ${JSON.stringify({ reason: scheduleReason(reason, "report schedule deleted"), before: existing, after: null })}::jsonb,
           ${authz.user.id}, now(), ${requestId})
        returning row_id
      `,
      "objects",
    );
    if (!audit[0]) throw conflict("The report schedule audit record was not written.");
    return { id };
  });
}
