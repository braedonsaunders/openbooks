/**
 * Source-identity reconciliation for imported atomic time lines.
 *
 * Every target line is one project/job and may reference at most one Field
 * Ticket; this module resolves source (id -> ticket number) links against
 * the tenant and applies them. Planning is a stale read by nature, so the
 * apply re-reads and locks every entry inside its own transaction, verifies
 * the ticket, project, billing and GL provenance still match the plan, and
 * derives the audit before-state from the locked row — never from the plan.
 * A write that matches zero rows is a failure, not a success.
 */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

export interface SourceLink {
  sourceRef: string;
  ticketNumber: string;
}

export interface ResolvedLink extends SourceLink {
  timeEntryId: string | null;
  currentTicketId: string | null;
  currentTicketNumber: string | null;
  targetTicketId: string | null;
  entryProjectId: string | null;
  ticketProjectId: string | null;
  protectedEvidence: boolean;
}

export interface LinkClassification {
  missingTimeEntries: ResolvedLink[];
  missingTickets: ResolvedLink[];
  projectConflicts: ResolvedLink[];
  changes: ResolvedLink[];
  applicableChanges: ResolvedLink[];
  protectedChanges: ResolvedLink[];
  summary: {
    sourceRows: number;
    uniqueSourceLinks: number;
    exactCurrentLinks: number;
    requiredChanges: number;
    applicableChanges: number;
    protectedChanges: number;
    missingTimeEntries: number;
    missingTickets: number;
    projectConflicts: number;
    applied: boolean;
  };
}

/** One planned change, verified against locked rows before it is applied. */
export interface ApplyPlanRow {
  timeEntryId: string;
  sourceRef: string;
  ticketNumber: string;
  fromTicketId: string | null;
  fromTicketNumber: string | null;
  toTicketId: string;
  entryProjectId: string | null;
  ticketProjectId: string | null;
}

/**
 * Resolve source links against the tenant: the plan-time read. The result
 * is stale the moment it returns; applyTimeTicketLinks re-verifies it under
 * lock before writing anything.
 */
export async function resolveTimeTicketLinks(
  orgId: string,
  sourceKey: string,
  links: readonly SourceLink[],
): Promise<ResolvedLink[]> {
  const resolved: ResolvedLink[] = [];
  const BATCH = 1_000;
  for (let offset = 0; offset < links.length; offset += BATCH) {
    const batch = links.slice(offset, offset + BATCH);
    const result = await db.execute(sql`
      with source as (
        select *
          from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
               as x("sourceRef" text, "ticketNumber" text)
      )
      select source."sourceRef" as source_ref,
             source."ticketNumber" as ticket_number,
             te.id as time_entry_id,
             te.project_id as entry_project_id,
             te.field_ticket_id as current_ticket_id,
             current_ticket.document_number as current_ticket_number,
             target_ticket.id as target_ticket_id,
             target_ticket.project_id as ticket_project_id,
             (te.billing_status = 'billed'
               or te.invoiced_by_line_id is not null
               or te.cost_journal_entry_id is not null
               or te.overhead_journal_entry_id is not null) as protected_evidence
        from source
        left join time_entries te
          on te.org_id = ${orgId}
         and te.custom ->> ${sourceKey} = source."sourceRef"
        left join documents current_ticket
          on current_ticket.org_id = te.org_id
         and current_ticket.id = te.field_ticket_id
        left join documents target_ticket
          on target_ticket.org_id = ${orgId}
         and target_ticket.kind = 'field_ticket'
         and target_ticket.document_number = source."ticketNumber"
    `);
    for (const row of result.rows as Array<Record<string, unknown>>) {
      resolved.push({
        sourceRef: String(row.source_ref),
        ticketNumber: String(row.ticket_number),
        timeEntryId: row.time_entry_id ? String(row.time_entry_id) : null,
        currentTicketId: row.current_ticket_id
          ? String(row.current_ticket_id)
          : null,
        currentTicketNumber: row.current_ticket_number
          ? String(row.current_ticket_number)
          : null,
        targetTicketId: row.target_ticket_id
          ? String(row.target_ticket_id)
          : null,
        entryProjectId: row.entry_project_id
          ? String(row.entry_project_id)
          : null,
        ticketProjectId: row.ticket_project_id
          ? String(row.ticket_project_id)
          : null,
        protectedEvidence: Boolean(row.protected_evidence),
      });
    }
  }
  return resolved;
}

/** Split resolved links into the report's unchanged shape. */
export function classifyTimeTicketLinks(
  resolved: readonly ResolvedLink[],
  sourceRows: number,
  uniqueSourceLinks: number,
): LinkClassification {
  const missingTimeEntries = resolved.filter((row) => !row.timeEntryId);
  const missingTickets = resolved.filter((row) => !row.targetTicketId);
  const projectConflicts = resolved.filter(
    (row) =>
      row.timeEntryId &&
      row.targetTicketId &&
      row.entryProjectId !== row.ticketProjectId,
  );
  const changes = resolved.filter(
    (row) =>
      row.timeEntryId &&
      row.targetTicketId &&
      row.currentTicketId !== row.targetTicketId,
  );
  const applicableChanges = changes.filter(
    (row) => row.entryProjectId === row.ticketProjectId,
  );
  const protectedChanges = applicableChanges.filter(
    (row) => row.protectedEvidence,
  );
  return {
    missingTimeEntries,
    missingTickets,
    projectConflicts,
    changes,
    applicableChanges,
    protectedChanges,
    summary: {
      sourceRows,
      uniqueSourceLinks,
      exactCurrentLinks:
        resolved.length -
        missingTimeEntries.length -
        missingTickets.length -
        changes.length,
      requiredChanges: changes.length,
      applicableChanges: applicableChanges.length,
      protectedChanges: protectedChanges.length,
      missingTimeEntries: missingTimeEntries.length,
      missingTickets: missingTickets.length,
      projectConflicts: projectConflicts.length,
      applied: false,
    },
  };
}

/**
 * Apply one batch of planned changes. The caller must hold the tenant
 * transaction (withOrg): every entry is re-read FOR UPDATE, the locked
 * ticket/project/billing/GL provenance is verified against the plan, and
 * any entry that is now protected or has drifted refuses by name with its
 * entry id. The audit before-state comes from the locked row; the UPDATE
 * carries the same guards and its affected row count must equal the batch.
 */
export async function applyTimeTicketLinks(
  orgId: string,
  batch: readonly ApplyPlanRow[],
  opts: {
    reason: string;
    inputSha256: string;
    runId: string;
    actorId: string | null;
  },
): Promise<number> {
  if (batch.length === 0) return 0;
  // Lock first on an inner join: FOR UPDATE cannot name the nullable side
  // of an outer join, and the lock — not the later read — is what excludes
  // concurrent writers for the rest of this transaction.
  const lockedIds = (await db.execute(
    sql`
      with plan as (
        select *
          from jsonb_to_recordset(${JSON.stringify(batch.map((row) => ({ timeEntryId: row.timeEntryId })))}::jsonb)
               as x("timeEntryId" uuid)
      )
      select te.id as locked_entry_id
        from time_entries te
        join plan on plan."timeEntryId" = te.id
       where te.org_id = ${orgId}
       for update of te
    `,
  )) as { rows: Array<{ locked_entry_id: string }> };
  const lockedIdSet = new Set(lockedIds.rows.map((row) => String(row.locked_entry_id)));
  for (const row of batch) {
    if (!lockedIdSet.has(row.timeEntryId)) {
      throw new Error(
        `refusing apply: time entry ${row.timeEntryId} (source ${row.sourceRef}) no longer exists; re-run the plan`,
      );
    }
  }
  // The locks above are held to commit, so this verification read cannot
  // observe a row a concurrent bill or post is about to change.
  const locked = (await db.execute(
    sql`
      with plan as (
        select *
          from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
               as x("timeEntryId" uuid, "sourceRef" text,
                    "ticketNumber" text, "fromTicketId" uuid,
                    "fromTicketNumber" text, "toTicketId" uuid,
                    "entryProjectId" uuid, "ticketProjectId" uuid)
      )
      select plan."timeEntryId" as time_entry_id,
             plan."sourceRef" as source_ref,
             plan."ticketNumber" as ticket_number,
             plan."fromTicketId" as planned_from_ticket_id,
             plan."entryProjectId" as planned_entry_project_id,
             plan."toTicketId" as planned_to_ticket_id,
             plan."ticketProjectId" as planned_ticket_project_id,
             te.id as locked_entry_id,
             te.project_id as entry_project_id,
             te.field_ticket_id as current_ticket_id,
             current_ticket.document_number as current_ticket_number,
             target_ticket.id as target_ticket_id,
             target_ticket.project_id as ticket_project_id,
             (te.billing_status = 'billed'
               or te.invoiced_by_line_id is not null
               or te.cost_journal_entry_id is not null
               or te.overhead_journal_entry_id is not null) as protected_evidence
        from plan
        left join time_entries te
          on te.org_id = ${orgId}
         and te.id = plan."timeEntryId"
        left join documents current_ticket
          on current_ticket.org_id = te.org_id
         and current_ticket.id = te.field_ticket_id
        left join documents target_ticket
          on target_ticket.org_id = ${orgId}
         and target_ticket.kind = 'field_ticket'
         and target_ticket.document_number = plan."ticketNumber"
    `,
  )) as { rows: Array<Record<string, unknown>> };
  if (locked.rows.length !== batch.length) {
    throw new Error(
      `refusing apply: locked ${locked.rows.length} of ${batch.length} planned time entries; re-run the plan`,
    );
  }
  const uuidOrNull = (value: unknown): string | null =>
    value ? String(value) : null;
  for (const row of locked.rows) {
    const entryId = String(row.time_entry_id);
    const sourceRef = String(row.source_ref);
    if (row.protected_evidence) {
      throw new Error(
        `refusing apply: time entry ${entryId} (source ${sourceRef}) is now protected (billed, invoiced, or GL-linked); re-run the plan`,
      );
    }
    const currentTicketId = uuidOrNull(row.current_ticket_id);
    const plannedFrom = uuidOrNull(row.planned_from_ticket_id);
    if (currentTicketId !== plannedFrom) {
      throw new Error(
        `refusing apply: time entry ${entryId} (source ${sourceRef}) moved from ticket ${plannedFrom ?? "unlinked"} to ${currentTicketId ?? "unlinked"} after the plan; re-run the plan`,
      );
    }
    if (
      uuidOrNull(row.entry_project_id) !==
      uuidOrNull(row.planned_entry_project_id)
    ) {
      throw new Error(
        `refusing apply: time entry ${entryId} (source ${sourceRef}) changed project after the plan; re-run the plan`,
      );
    }
    if (uuidOrNull(row.target_ticket_id) !== String(row.planned_to_ticket_id)) {
      throw new Error(
        `refusing apply: time entry ${entryId} (source ${sourceRef}) target ticket ${String(row.ticket_number)} no longer resolves after the plan; re-run the plan`,
      );
    }
    if (
      uuidOrNull(row.ticket_project_id) !==
      uuidOrNull(row.planned_ticket_project_id)
    ) {
      throw new Error(
        `refusing apply: time entry ${entryId} (source ${sourceRef}) target ticket changed project after the plan; re-run the plan`,
      );
    }
  }
  const audit = await db.execute(sql`
    with plan as (
      select *
        from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
             as x("timeEntryId" uuid, "sourceRef" text,
                  "ticketNumber" text, "toTicketId" uuid)
    ),
    locked as (
      select plan."timeEntryId" as time_entry_id,
             plan."sourceRef" as source_ref,
             plan."ticketNumber" as ticket_number,
             plan."toTicketId" as to_ticket_id,
             te.field_ticket_id as current_ticket_id,
             current_ticket.document_number as current_ticket_number
        from plan
        join time_entries te
          on te.org_id = ${orgId}
         and te.id = plan."timeEntryId"
        left join documents current_ticket
          on current_ticket.org_id = te.org_id
         and current_ticket.id = te.field_ticket_id
    )
    insert into audit_log
      (org_id, table_name, row_id, action, changes, actor_id, request_id)
    select ${orgId}, 'time_entries', locked.time_entry_id, 'update',
           jsonb_build_object(
             'mode', 'source_lineage_correction',
             'reason', ${opts.reason}::text,
             'sourceRef', locked.source_ref,
             'inputSha256', ${opts.inputSha256}::text,
             'before', jsonb_build_object(
               'fieldTicketId', locked.current_ticket_id,
               'fieldTicketNumber', locked.current_ticket_number
             ),
             'after', jsonb_build_object(
               'fieldTicketId', locked.to_ticket_id,
               'fieldTicketNumber', locked.ticket_number
             )
           ),
           ${opts.actorId}, ${opts.runId}
      from locked
  `);
  if ((audit.rowCount ?? 0) !== batch.length) {
    throw new Error(
      `refusing apply: recorded audit for ${audit.rowCount ?? 0} of ${batch.length} planned time entries; re-run the plan`,
    );
  }
  const updated = await db.execute(sql`
    with plan as (
      select *
        from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
             as x("timeEntryId" uuid, "ticketNumber" text, "toTicketId" uuid,
                  "fromTicketId" uuid)
    )
    update time_entries te
       set field_ticket_id = plan."toTicketId",
           custom = te.custom || jsonb_build_object(
             'sourceFieldTicketNumber', plan."ticketNumber"
           ),
           updated_at = now()
      from plan
     where te.org_id = ${orgId}
       and te.id = plan."timeEntryId"
       and te.billing_status <> 'billed'
       and te.invoiced_by_line_id is null
       and te.cost_journal_entry_id is null
       and te.overhead_journal_entry_id is null
       and te.field_ticket_id is not distinct from plan."fromTicketId"
  `);
  if ((updated.rowCount ?? 0) !== batch.length) {
    throw new Error(
      `refusing apply: wrote ${updated.rowCount ?? 0} of ${batch.length} planned time entries; a concurrent bill, post, or ticket edit moved one after the lock check — re-run the plan`,
    );
  }
  return batch.length;
}
