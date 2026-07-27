/**
 * Normalize imported Field Ticket documents into the product's native shape
 * and retain approved source-only archival tickets.
 *
 * Inputs are immutable source artifacts, not tenant-specific code:
 *   --headers  legacy ticket headers (TSV; see import-field-tickets.ts)
 *   --time     source time lines with ticket_number/project/status (JSON)
 *
 * Existing ticket documents receive a one-to-one native `field_tickets` row.
 * A ticket present only in exported approved source time is retained as an
 * archival approved ticket when every atomic line proves the same project and
 * approval state. `documents.custom` retains source-only provenance; no native
 * Field Ticket state is written there.
 *
 * Dry-run by default. Live writes require --apply --production --reason.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../db.ts";
import { resolveTargetOrg } from "./target-org.ts";

interface Header {
  legacyId: string;
  number: string;
  projectRef: string;
  begin: string;
  end: string;
  foremanRef: string;
}

interface TimeLine {
  id: string;
  ticketNumber: string;
  projectRef: string;
  workedOn: string;
  approvalStatus: string;
  supervisorApproval: string;
  billingStatus: string;
}

async function retry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const messages: string[] = [];
      for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
        messages.push(String((current as { message?: unknown }).message ?? ""));
      }
      if (!/timeout|terminated|ECONN|ETIMEDOUT|EHOSTUNREACH|Connection/i.test(messages.join(" "))) {
        throw error;
      }
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }
  throw last;
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
const headerPath = args.get("headers") ?? "/tmp/ft-head.tsv";
const timePath = args.get("time") ?? "/tmp/ns-time-ticket-detail.json";
const outputPath =
  args.get("out") ??
  `/tmp/openbooks-normalize-field-tickets-${orgId}-${Date.now()}.json`;
const apply = args.get("apply") === "true";
const reason = args.get("reason")?.trim() ?? "";
if (!existsSync(headerPath) || !existsSync(timePath)) {
  throw new Error("both --headers and --time source artifacts are required");
}
if (apply && (reason.length < 10 || reason.length > 500)) {
  throw new Error("--reason must be 10-500 characters when applying");
}
const target = await resolveTargetOrg(orgId);
if (apply && target.isProduction && !process.argv.includes("--production")) {
  throw new Error("--production is required for a live tenant");
}

const headers: Header[] = readFileSync(headerPath, "utf8")
  .split(/\r?\n/)
  .map((line) => line.split("\t"))
  .filter((columns) => columns.length >= 13 && /^\d+$/.test(columns[0] ?? ""))
  .map((columns) => ({
    legacyId: columns[0]!,
    number: columns[1]!,
    projectRef: columns[2]!,
    begin: columns[5]!,
    end: columns[6]!,
    foremanRef: columns[10]!,
  }));
const headerByNumber = new Map<string, Header>();
for (const header of headers) {
  if (headerByNumber.has(header.number)) {
    throw new Error(`duplicate source ticket number ${header.number}`);
  }
  headerByNumber.set(header.number, header);
}

const isoDate = (value: unknown): string => {
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) throw new Error(`invalid source date ${text}`);
  return `${match[3]}-${match[1]}-${match[2]}`;
};
const timeLines: TimeLine[] = (
  JSON.parse(readFileSync(timePath, "utf8")) as Array<Record<string, unknown>>
).map((row) => ({
  id: String(row.id ?? ""),
  ticketNumber: String(row.ticket_number ?? row.ticketNumber ?? "").trim(),
  projectRef: String(row.customer ?? row.projectRef ?? "").trim(),
  workedOn: isoDate(row.trandate ?? row.workedOn),
  approvalStatus: String(
    row.approvalstatus ?? row.approvalStatus ?? "",
  ).trim(),
  supervisorApproval: String(
    row.supervisorapproval ?? row.supervisorApproval ?? "",
  ).trim(),
  billingStatus: String(row.status ?? row.billingStatus ?? "").trim(),
}));
if (
  timeLines.some(
    (row) => !row.id || !row.ticketNumber || !row.projectRef || !row.workedOn,
  )
) {
  throw new Error("source time rows require id, ticket number, project, and date");
}

const targetRows = await retry(() => db.execute(sql`
  select d.id, d.document_number, d.project_id,
         d.document_date::text as document_date,
         project.custom->>'nsId' as project_ref,
         ft.document_id as native_document_id
    from documents d
    left join field_tickets ft
      on ft.document_id = d.id and ft.org_id = d.org_id
    left join projects project
      on project.id = d.project_id and project.org_id = d.org_id
   where d.org_id = ${orgId} and d.kind = 'field_ticket'
`));
const targetByNumber = new Map<string, Record<string, unknown>>();
for (const row of targetRows.rows as Array<Record<string, unknown>>) {
  const number = String(row.document_number);
  if (targetByNumber.has(number)) {
    throw new Error(`duplicate target Field Ticket number ${number}`);
  }
  targetByNumber.set(number, row);
}
const partyRows = await retry(() => db.execute(sql`
  select id, custom->>'nsId' as source_ref
    from parties
   where org_id = ${orgId} and custom->>'nsId' is not null
`));
const partyBySourceRef = new Map(
  (partyRows.rows as Array<Record<string, unknown>>).map((row) => [
    String(row.source_ref),
    String(row.id),
  ]),
);

const headerNormalizations = headers.flatMap((header) => {
  const targetRow = targetByNumber.get(header.number);
  if (!targetRow) return [];
  if (targetRow.native_document_id) return [];
  if (String(targetRow.project_ref ?? "") !== header.projectRef) {
    throw new Error(
      `ticket ${header.number} source project ${header.projectRef} does not match target project ${targetRow.project_ref}`,
    );
  }
  return [{
    id: String(targetRow.id),
    number: header.number,
    period: "weekly",
    periodStart: header.begin,
    periodEnd: header.end,
    foremanPartyId: partyBySourceRef.get(header.foremanRef) ?? null,
  }];
});
const missingSourceHeaders = [...targetByNumber.values()]
  .filter(
    (targetRow) =>
      !targetRow.native_document_id
      && !headerByNumber.has(String(targetRow.document_number)),
  )
  .map((targetRow) => String(targetRow.document_number));
if (missingSourceHeaders.length > 0) {
  throw new Error(
    `${missingSourceHeaders.length} non-native Field Tickets lack an authoritative source header: `
      + missingSourceHeaders.slice(0, 10).join(", "),
  );
}
const normalizations = headerNormalizations;

const sourceLinesByTicket = new Map<string, TimeLine[]>();
for (const line of timeLines) {
  const rows = sourceLinesByTicket.get(line.ticketNumber) ?? [];
  rows.push(line);
  sourceLinesByTicket.set(line.ticketNumber, rows);
}
const archivalPlans: Array<{
  number: string;
  projectRef: string;
  periodStart: string;
  periodEnd: string;
  lineCount: number;
  billingStatuses: string[];
  sourceTimeSha256: string;
}> = [];
for (const [number, lines] of sourceLinesByTicket) {
  if (headerByNumber.has(number) || targetByNumber.has(number)) continue;
  const projects = [...new Set(lines.map((line) => line.projectRef))];
  if (projects.length !== 1) {
    throw new Error(
      `archival ticket ${number} spans ${projects.length} source projects`,
    );
  }
  if (
    lines.some(
      (line) =>
        line.approvalStatus !== "3" ||
        !["T", "true", "1"].includes(line.supervisorApproval),
    )
  ) {
    throw new Error(
      `archival ticket ${number} is not uniformly approved in source time`,
    );
  }
  const dates = lines.map((line) => line.workedOn).sort();
  const anchor = new Date(`${dates[0]}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() - anchor.getUTCDay());
  const periodStart = anchor.toISOString().slice(0, 10);
  anchor.setUTCDate(anchor.getUTCDate() + 6);
  const periodEnd = anchor.toISOString().slice(0, 10);
  if (dates.some((date) => date < periodStart || date > periodEnd)) {
    throw new Error(`archival ticket ${number} spans more than one week`);
  }
  archivalPlans.push({
    number,
    projectRef: projects[0]!,
    periodStart,
    periodEnd,
    lineCount: lines.length,
    billingStatuses: [
      ...new Set(lines.map((line) => line.billingStatus)),
    ].sort(),
    sourceTimeSha256: createHash("sha256")
      .update(
        JSON.stringify(
          [...lines]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((line) => ({
              id: line.id,
              projectRef: line.projectRef,
              workedOn: line.workedOn,
              approvalStatus: line.approvalStatus,
              supervisorApproval: line.supervisorApproval,
              billingStatus: line.billingStatus,
            })),
        ),
      )
      .digest("hex"),
  });
}

const projectRefs = [...new Set(archivalPlans.map((plan) => plan.projectRef))];
const projectRows = projectRefs.length
  ? await retry(() => db.execute(sql`
      select project.id, project.custom->>'nsId' as source_ref,
             project.customer_id, project.subsidiary_id,
             coalesce(type.billing_method, 'time_and_materials') as billing_method
        from projects project
        left join project_types type
          on type.id = project.project_type_id and type.org_id = project.org_id
       where project.org_id = ${orgId}
         and project.custom->>'nsId' = any(${`{${projectRefs.join(",")}}`}::text[])
    `))
  : { rows: [] };
const projectBySourceRef = new Map(
  (projectRows.rows as Array<Record<string, unknown>>).map((row) => [
    String(row.source_ref),
    row,
  ]),
);
const missingArchiveProjects = archivalPlans.filter(
  (plan) => !projectBySourceRef.has(plan.projectRef),
);
if (missingArchiveProjects.length) {
  throw new Error(
    `${missingArchiveProjects.length} archival tickets have no target project`,
  );
}

const summary = {
  sourceHeaders: headers.length,
  sourceTimeLines: timeLines.length,
  existingTargetTickets: targetByNumber.size,
  nativeHeaderBackfills: normalizations.length,
  archivalCreates: archivalPlans.length,
  applied: false,
};

if (apply) {
  const runId = randomUUID();
  const headerSha256 = createHash("sha256")
    .update(readFileSync(headerPath))
    .digest("hex");
  const timeSha256 = createHash("sha256")
    .update(readFileSync(timePath))
    .digest("hex");
  const BATCH = 100;
  for (let offset = 0; offset < normalizations.length; offset += BATCH) {
    const batch = normalizations.slice(offset, offset + BATCH);
    await retry(() => withOrg(orgId, async () => {
      await db.execute(sql`
        with change as (
          select *
            from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
                 as x(id uuid, number text, period text,
                      "periodStart" date, "periodEnd" date,
                      "foremanPartyId" uuid)
        )
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        select ${orgId}, 'field_tickets', change.id, 'insert',
               jsonb_build_object(
                 'mode', 'native_field_ticket_backfill',
                 'reason', ${reason}::text,
                 'sourceHeadersSha256', ${headerSha256}::text,
                 'before', null,
                 'after', jsonb_build_object(
                   'period', change.period,
                   'periodStart', change."periodStart",
                   'periodEnd', change."periodEnd",
                   'foremanPartyId', change."foremanPartyId"
                 )
               ),
               null, ${runId}
          from change
      `);
      await db.execute(sql`
        with change as (
          select *
            from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
                 as x(id uuid, period text, "periodStart" date,
                      "periodEnd" date, "foremanPartyId" uuid)
        )
        insert into field_tickets
          (document_id, org_id, period, period_start, period_end,
           foreman_party_id, created_at, updated_at)
        select change.id, ${orgId}, change.period, change."periodStart",
               change."periodEnd", change."foremanPartyId", now(), now()
          from change
        on conflict (document_id) do nothing
      `);
    }));
  }

  for (const plan of archivalPlans) {
    const project = projectBySourceRef.get(plan.projectRef)!;
    await retry(() => withOrg(orgId, async () => {
      const custom = {
        sourceArchive: {
          system: "source_import",
          disposition: "source_header_missing",
          sourceProjectRef: plan.projectRef,
          sourceTimeLineCount: plan.lineCount,
          sourceTimeSha256: plan.sourceTimeSha256,
          approvalStatus: "3",
          supervisorApproval: true,
          billingStatuses: plan.billingStatuses,
          sourceArtifactSha256: timeSha256,
        },
      };
      const inserted = await db.execute(sql`
        insert into documents
          (org_id, kind, document_number, document_date, currency, status,
           party_id, project_id, subsidiary_id, billing_method,
           subtotal, tax_total, total, custom)
        select ${orgId}, 'field_ticket', ${plan.number}, ${plan.periodEnd},
               org.base_currency, 'approved',
               ${project.customer_id ?? null}, ${String(project.id)},
               ${project.subsidiary_id ?? null},
               ${project.billing_method ?? "time_and_materials"},
               '0', '0', '0', ${JSON.stringify(custom)}::jsonb
          from orgs org
         where org.id = ${orgId}
           and not exists (
             select 1 from documents existing
              where existing.org_id = ${orgId}
                and existing.kind = 'field_ticket'
                and existing.document_number = ${plan.number}
           )
        returning id
      `);
      const id = (inserted.rows[0] as { id?: string } | undefined)?.id;
      if (!id) return;
      await db.execute(sql`
        insert into field_tickets
          (document_id, org_id, period, period_start, period_end,
           foreman_party_id, created_at, updated_at)
        values (${id}, ${orgId}, 'weekly', ${plan.periodStart},
                ${plan.periodEnd}, null, now(), now())
      `);
      await db.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (
          ${orgId}, 'documents', ${id}, 'insert',
          ${JSON.stringify({
            mode: "source_archival_reconstruction",
            reason,
            sourceTimeSha256: timeSha256,
            after: {
              documentNumber: plan.number,
              projectRef: plan.projectRef,
              periodStart: plan.periodStart,
              periodEnd: plan.periodEnd,
              status: "approved",
              sourceProvenance: custom,
            },
          })}::jsonb,
          null, ${runId}
        )
      `);
    }));
  }
  summary.applied = true;
}

const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  orgId,
  sourceArtifacts: {
    headers: {
      path: headerPath,
      sha256: createHash("sha256")
        .update(readFileSync(headerPath))
        .digest("hex"),
    },
    time: {
      path: timePath,
      sha256: createHash("sha256")
        .update(readFileSync(timePath))
        .digest("hex"),
    },
  },
  reason: apply ? reason : null,
  summary,
  archivalPlans,
};
writeFileSync(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`report: ${outputPath}`);
