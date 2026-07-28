/**
 * Deterministically link imported atomic time lines to Field Tickets.
 *
 * The input is connector-neutral source evidence:
 *   [{ "id": "<source time-entry id>", "ticket_number": "FT-123" }]
 *
 * `time_entries.custom.nsId` is only the default source-id field; another
 * connector may pass `--source-key=<custom JSON key>`. Every target line is
 * still one project/job and may reference at most one Field Ticket. This tool
 * never allocates a line across tickets and never changes hours or money.
 *
 * Dry-run is the default. Production writes require all of:
 *   --apply --production --reason="..." --org=<uuid>
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../db.ts";
import { resolveTargetOrg } from "./target-org.ts";

interface SourceLink {
  sourceRef: string;
  ticketNumber: string;
}

interface ResolvedLink extends SourceLink {
  timeEntryId: string | null;
  currentTicketId: string | null;
  currentTicketNumber: string | null;
  targetTicketId: string | null;
  entryProjectId: string | null;
  ticketProjectId: string | null;
  protectedEvidence: boolean;
}

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, ...value] = arg.slice(2).split("=");
      return [key!, value.length ? value.join("=") : "true"];
    }),
);
const orgId = args.get("org");
if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) {
  throw new Error("--org=<uuid> is required");
}
const inputPath = args.get("input") ?? "/tmp/ns-time-ticket.json";
const sourceKey = args.get("source-key") ?? "nsId";
const outputPath =
  args.get("out") ??
  `/tmp/openbooks-field-ticket-source-links-${orgId}-${Date.now()}.json`;
const apply = args.get("apply") === "true";
const excludeProjectConflicts =
  args.get("exclude-project-conflicts") === "true";
const reason = args.get("reason")?.trim() ?? "";
if (!existsSync(inputPath)) throw new Error(`input not found: ${inputPath}`);
if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(sourceKey)) {
  throw new Error("--source-key must be a safe JSON object key");
}
if (apply && (reason.length < 10 || reason.length > 500)) {
  throw new Error("--reason must be 10-500 characters when applying");
}
const target = await resolveTargetOrg(orgId);
if (apply && target.isProduction && !process.argv.includes("--production")) {
  throw new Error("--production is required for a live tenant");
}

const raw = JSON.parse(readFileSync(inputPath, "utf8")) as Array<
  Record<string, unknown>
>;
const links: SourceLink[] = raw.map((row) => ({
  sourceRef: String(row.id ?? row.source_ref ?? row.sourceRef ?? "").trim(),
  ticketNumber: String(
    row.ticket_number ?? row.ticketNumber ?? "",
  ).trim(),
}));
const uniqueLinks = new Map<string, SourceLink>();
for (const link of links) {
  if (!link.sourceRef || !link.ticketNumber) {
    throw new Error("every input row requires a source id and ticket number");
  }
  const prior = uniqueLinks.get(link.sourceRef);
  if (prior && prior.ticketNumber !== link.ticketNumber) {
    throw new Error(
      `source time entry ${link.sourceRef} maps to both ${prior.ticketNumber} and ${link.ticketNumber}`,
    );
  }
  uniqueLinks.set(link.sourceRef, link);
}

const resolved: ResolvedLink[] = [];
const BATCH = 1_000;
for (let offset = 0; offset < uniqueLinks.size; offset += BATCH) {
  const batch = [...uniqueLinks.values()].slice(offset, offset + BATCH);
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

if (resolved.length !== uniqueLinks.size) {
  throw new Error(
    `source-link cardinality changed: ${uniqueLinks.size} inputs produced ${resolved.length} rows; duplicate source IDs or ticket numbers exist in the target`,
  );
}
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
const summary = {
  sourceRows: links.length,
  uniqueSourceLinks: uniqueLinks.size,
  exactCurrentLinks:
    resolved.length - missingTimeEntries.length - missingTickets.length - changes.length,
  requiredChanges: changes.length,
  applicableChanges: applicableChanges.length,
  protectedChanges: protectedChanges.length,
  missingTimeEntries: missingTimeEntries.length,
  missingTickets: missingTickets.length,
  projectConflicts: projectConflicts.length,
  applied: false,
};

if (apply) {
  if (
    missingTimeEntries.length ||
    missingTickets.length ||
    (projectConflicts.length && !excludeProjectConflicts) ||
    protectedChanges.length
  ) {
    throw new Error(
      "refusing apply: every source line and Field Ticket must resolve; project conflicts require explicit --exclude-project-conflicts; changed lines must have no invoice/GL provenance",
    );
  }
  const runId = randomUUID();
  const inputSha256 = createHash("sha256")
    .update(readFileSync(inputPath))
    .digest("hex");
  for (let offset = 0; offset < applicableChanges.length; offset += BATCH) {
    const batch = applicableChanges.slice(offset, offset + BATCH).map((row) => ({
      timeEntryId: row.timeEntryId!,
      sourceRef: row.sourceRef,
      ticketNumber: row.ticketNumber,
      fromTicketId: row.currentTicketId,
      fromTicketNumber: row.currentTicketNumber,
      toTicketId: row.targetTicketId!,
    }));
    await withOrg(orgId, async () => {
      await db.execute(sql`
        with change as (
          select *
            from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
                 as x("timeEntryId" uuid, "sourceRef" text,
                      "ticketNumber" text, "fromTicketId" uuid,
                      "fromTicketNumber" text, "toTicketId" uuid)
        )
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        select ${orgId}, 'time_entries', change."timeEntryId", 'update',
               jsonb_build_object(
                 'mode', 'source_lineage_correction',
                 'reason', ${reason}::text,
                 'sourceRef', change."sourceRef",
                 'inputSha256', ${inputSha256}::text,
                 'before', jsonb_build_object(
                   'fieldTicketId', change."fromTicketId",
                   'fieldTicketNumber', change."fromTicketNumber"
                 ),
                 'after', jsonb_build_object(
                   'fieldTicketId', change."toTicketId",
                   'fieldTicketNumber', change."ticketNumber"
                 )
               ),
               null, ${runId}
          from change
      `);
      await db.execute(sql`
        with change as (
          select *
            from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
                 as x("timeEntryId" uuid, "ticketNumber" text, "toTicketId" uuid)
        )
        update time_entries te
           set field_ticket_id = change."toTicketId",
               custom = te.custom || jsonb_build_object(
                 'sourceFieldTicketNumber', change."ticketNumber"
               ),
               updated_at = now()
          from change
         where te.org_id = ${orgId}
           and te.id = change."timeEntryId"
           and te.field_ticket_id is distinct from change."toTicketId"
      `);
    });
  }
  summary.applied = true;
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  orgId,
  sourceKey,
  sourceArtifact: {
    path: inputPath,
    sha256: createHash("sha256").update(readFileSync(inputPath)).digest("hex"),
  },
  reason: apply ? reason : null,
  summary,
  unresolved: {
    missingTimeEntries,
    missingTickets,
    projectConflicts,
    protectedChanges,
  },
  changes,
};
writeFileSync(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`report: ${outputPath}`);
