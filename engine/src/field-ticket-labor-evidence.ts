import { sql } from "drizzle-orm";
import { db, withOrg } from "./db.ts";

export type FieldTicketLaborEvidenceBasis =
  | "operational_time"
  | "source_import"
  | "controlled_amendment";

export interface FieldTicketLaborEvidenceLine {
  employeePartyId: string;
  employeeName: string;
  itemId?: string | null;
  itemName?: string | null;
  timeTypeId?: string | null;
  timeTypeName: string;
  projectTaskId?: string | null;
  projectTaskName?: string | null;
  workedOn: string;
  hours: string;
  timeEntryId?: string | null;
  timeEntryStatus?: string | null;
  costRate?: string | null;
  costRateCurrency?: string | null;
  billRate?: string | null;
  billRateCurrency?: string | null;
  costAmount?: string | null;
  billAmount?: string | null;
  sourceSystem?: string | null;
  sourceLineRef?: string | null;
  sourcePayloadHash?: string | null;
}

export interface CaptureFieldTicketLaborEvidenceArgs {
  orgId: string;
  fieldTicketId: string;
  actorId: string;
  evidenceBasis: FieldTicketLaborEvidenceBasis;
  reason: string;
  currency: string;
  sourceSystem?: string | null;
  sourcePayloadHash?: string | null;
  lines: FieldTicketLaborEvidenceLine[];
  /**
   * A source re-import or controlled amendment may append a revision. Ordinary
   * approval capture is idempotent but may not overwrite existing evidence.
   */
  supersedeCurrent?: boolean;
}

export interface FieldTicketLaborEvidenceResult {
  id: string;
  revision: number;
  lineCount: number;
  unchanged: boolean;
}

export class FieldTicketLaborEvidenceError extends Error {}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HASH = /^[0-9a-f]{64}$/i;

function validateInput(args: CaptureFieldTicketLaborEvidenceArgs): void {
  if (!UUID.test(args.orgId) || !UUID.test(args.fieldTicketId) || !UUID.test(args.actorId)) {
    throw new FieldTicketLaborEvidenceError("invalid Field Ticket evidence identity");
  }
  if (!args.reason.trim()) {
    throw new FieldTicketLaborEvidenceError("a labor-evidence reason is required");
  }
  if (!/^[A-Z]{3}$/.test(args.currency)) {
    throw new FieldTicketLaborEvidenceError("labor-evidence currency must be an ISO 4217 code");
  }
  if (args.evidenceBasis === "source_import" && !args.sourceSystem?.trim()) {
    throw new FieldTicketLaborEvidenceError("source-import evidence requires a source system");
  }
  if (args.evidenceBasis === "operational_time" && args.supersedeCurrent) {
    throw new FieldTicketLaborEvidenceError(
      "ordinary approval capture cannot supersede commercial evidence",
    );
  }
  if (args.sourcePayloadHash && !HASH.test(args.sourcePayloadHash)) {
    throw new FieldTicketLaborEvidenceError("source payload hash must be SHA-256");
  }
  const timeEntryIds = new Set<string>();
  const sourceRefs = new Set<string>();
  for (const [index, line] of args.lines.entries()) {
    if (!UUID.test(line.employeePartyId) || !line.employeeName.trim()) {
      throw new FieldTicketLaborEvidenceError(`labor line ${index + 1} needs an employee`);
    }
    for (const value of [line.itemId, line.timeTypeId, line.projectTaskId, line.timeEntryId]) {
      if (value != null && !UUID.test(value)) {
        throw new FieldTicketLaborEvidenceError(`labor line ${index + 1} has an invalid reference`);
      }
    }
    if (!line.timeTypeName.trim()) {
      throw new FieldTicketLaborEvidenceError(`labor line ${index + 1} needs a time-type label`);
    }
    if (
      !ISO_DATE.test(line.workedOn) ||
      !DECIMAL.test(line.hours) ||
      /^-?0(?:\.0+)?$/.test(line.hours)
    ) {
      throw new FieldTicketLaborEvidenceError(`labor line ${index + 1} needs non-zero decimal hours and an ISO date`);
    }
    for (const value of [line.costRate, line.billRate, line.costAmount, line.billAmount]) {
      if (value != null && !DECIMAL.test(value)) {
        throw new FieldTicketLaborEvidenceError(`labor line ${index + 1} has an invalid decimal`);
      }
    }
    for (const value of [line.costRateCurrency, line.billRateCurrency]) {
      if (value != null && !/^[A-Z]{3}$/.test(value)) {
        throw new FieldTicketLaborEvidenceError(`labor line ${index + 1} has an invalid rate currency`);
      }
    }
    if (line.sourcePayloadHash && !HASH.test(line.sourcePayloadHash)) {
      throw new FieldTicketLaborEvidenceError(`labor line ${index + 1} has an invalid source hash`);
    }
    if (line.timeEntryId) {
      if (timeEntryIds.has(line.timeEntryId)) {
        throw new FieldTicketLaborEvidenceError("a time entry may appear only once in a labor snapshot");
      }
      timeEntryIds.add(line.timeEntryId);
    }
    if (line.sourceSystem && line.sourceLineRef) {
      const key = `${line.sourceSystem}\0${line.sourceLineRef}`;
      if (sourceRefs.has(key)) {
        throw new FieldTicketLaborEvidenceError("a source line may appear only once in a labor snapshot");
      }
      sourceRefs.add(key);
    }
  }
}

/**
 * Append a complete, versioned commercial labor snapshot.
 *
 * This service never writes `time_entries`, changes time approval, or posts a
 * journal. The ticket row is locked so concurrent approvals/imports cannot
 * create competing current revisions. Supersession and the new snapshot share
 * one tenant-scoped transaction and one audit boundary.
 */
export async function captureFieldTicketLaborEvidence(
  args: CaptureFieldTicketLaborEvidenceArgs,
): Promise<FieldTicketLaborEvidenceResult> {
  validateInput(args);
  return withOrg(args.orgId, async () => {
    const ticket = (await db.execute(sql`
      select d.id, d.status
        from documents d
        join field_tickets ft
          on ft.document_id = d.id
         and ft.org_id = d.org_id
       where d.id = ${args.fieldTicketId}
         and d.org_id = ${args.orgId}
         and d.kind = 'field_ticket'
       for update of d, ft
    `)) as unknown as { rows: { id: string; status: string }[] };
    if (!ticket.rows[0]) {
      throw new FieldTicketLaborEvidenceError("Field Ticket not found");
    }
    if (
      args.evidenceBasis === "operational_time" &&
      !["draft", "pending_approval"].includes(ticket.rows[0].status)
    ) {
      throw new FieldTicketLaborEvidenceError(
        "operational-time evidence is captured only while releasing a draft or submitted ticket",
      );
    }
    if (
      args.evidenceBasis !== "operational_time" &&
      !["approved", "voided"].includes(ticket.rows[0].status)
    ) {
      throw new FieldTicketLaborEvidenceError(
        "source imports and controlled amendments require approved retained evidence",
      );
    }

    const current = (await db.execute(sql`
      select snapshot.id, snapshot.revision, snapshot.source_system,
             snapshot.source_payload_hash,
             (select count(*)::int
                from field_ticket_labor_lines line
               where line.org_id = snapshot.org_id
                 and line.snapshot_id = snapshot.id) as line_count
        from field_ticket_labor_snapshots snapshot
       where snapshot.org_id = ${args.orgId}
         and snapshot.field_ticket_id = ${args.fieldTicketId}
         and snapshot.superseded_at is null
       for update
    `)) as unknown as {
      rows: Array<{
        id: string;
        revision: number;
        source_system: string | null;
        source_payload_hash: string | null;
        line_count: number;
      }>;
    };
    const existing = current.rows[0] ?? null;
    if (
      existing &&
      args.sourcePayloadHash &&
      existing.source_system === (args.sourceSystem ?? null) &&
      existing.source_payload_hash === args.sourcePayloadHash
    ) {
      return {
        id: existing.id,
        revision: Number(existing.revision),
        lineCount: Number(existing.line_count),
        unchanged: true,
      };
    }
    if (existing && !args.supersedeCurrent) {
      if (args.evidenceBasis === "operational_time") {
        return {
          id: existing.id,
          revision: Number(existing.revision),
          lineCount: Number(existing.line_count),
          unchanged: true,
        };
      }
      throw new FieldTicketLaborEvidenceError(
        "existing commercial labor evidence requires an explicit controlled supersession",
      );
    }

    if (existing) {
      await db.execute(sql`
        update field_ticket_labor_snapshots
           set superseded_at = now(), superseded_by = ${args.actorId}
         where id = ${existing.id}
           and org_id = ${args.orgId}
           and superseded_at is null
      `);
      await db.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id)
        values
          (${args.orgId}, 'field_ticket_labor_snapshots', ${existing.id}, 'update',
           ${JSON.stringify({
             source: "field_ticket_labor_evidence",
             event: "superseded",
             fieldTicketId: args.fieldTicketId,
             priorRevision: Number(existing.revision),
             reason: args.reason.trim(),
             priorLineCount: Number(existing.line_count),
           })}::jsonb,
           ${args.actorId})
      `);
    }

    const inserted = (await db.execute(sql`
      insert into field_ticket_labor_snapshots
        (org_id, field_ticket_id, revision, evidence_basis, reason,
         source_system, source_payload_hash, currency, captured_by)
      select ${args.orgId}, ${args.fieldTicketId}, coalesce(max(revision), 0) + 1,
             ${args.evidenceBasis}, ${args.reason.trim()},
             ${args.sourceSystem?.trim() || null}, ${args.sourcePayloadHash ?? null},
             ${args.currency}, ${args.actorId}
        from field_ticket_labor_snapshots
       where org_id = ${args.orgId}
         and field_ticket_id = ${args.fieldTicketId}
      returning id, revision
    `)) as unknown as { rows: { id: string; revision: number }[] };
    const snapshot = inserted.rows[0];

    let sequence = 0;
    for (const line of args.lines) {
      sequence += 1;
      await db.execute(sql`
        insert into field_ticket_labor_lines
          (org_id, snapshot_id, field_ticket_id, sequence,
           employee_party_id, employee_name, item_id, item_name,
           time_type_id, time_type_name, project_task_id, project_task_name,
           worked_on, hours, time_entry_id, time_entry_status,
           cost_rate, cost_rate_currency, bill_rate, bill_rate_currency,
           cost_amount, bill_amount, source_system, source_line_ref,
           source_payload_hash, created_by)
        values
          (${args.orgId}, ${snapshot.id}, ${args.fieldTicketId}, ${sequence},
           ${line.employeePartyId}, ${line.employeeName.trim()},
           ${line.itemId ?? null}, ${line.itemName?.trim() || null},
           ${line.timeTypeId ?? null}, ${line.timeTypeName.trim()},
           ${line.projectTaskId ?? null}, ${line.projectTaskName?.trim() || null},
           ${line.workedOn}, ${line.hours},
           ${line.timeEntryId ?? null}, ${line.timeEntryStatus ?? null},
           ${line.costRate ?? null}, ${line.costRateCurrency ?? null},
           ${line.billRate ?? null}, ${line.billRateCurrency ?? null},
           ${line.costAmount ?? null}, ${line.billAmount ?? null},
           ${line.sourceSystem?.trim() || args.sourceSystem?.trim() || null},
           ${line.sourceLineRef ?? null}, ${line.sourcePayloadHash ?? null},
           ${args.actorId})
      `);
    }
    await db.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${args.orgId}, 'field_ticket_labor_snapshots', ${snapshot.id}, 'insert',
         ${JSON.stringify({
           source: "field_ticket_labor_evidence",
           fieldTicketId: args.fieldTicketId,
           evidenceBasis: args.evidenceBasis,
           sourceSystem: args.sourceSystem ?? null,
           sourcePayloadHash: args.sourcePayloadHash ?? null,
           reason: args.reason.trim(),
           lineCount: args.lines.length,
           supersededSnapshotId: existing?.id ?? null,
           operationalTimeStatusUnchanged: true,
         })}::jsonb,
         ${args.actorId})
    `);
    return {
      id: snapshot.id,
      revision: Number(snapshot.revision),
      lineCount: args.lines.length,
      unchanged: false,
    };
  });
}
