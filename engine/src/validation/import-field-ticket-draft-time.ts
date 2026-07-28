/**
 * Restore editable Field Ticket draft labor from a source grid when the rows
 * have not yet reached the tenant's operational time ledger.
 *
 * This is intentionally narrower than a generic time import:
 * - only source and target tickets that are both draft are eligible;
 * - an existing cell must either match exactly or the run fails closed;
 * - only wholly missing cells are inserted;
 * - inserted entries remain draft and therefore create no approval, payroll,
 *   billing, cost, overhead, or GL effects;
 * - every inserted atom carries source provenance and an audit event.
 *
 * Dry-run by default. Live writes require --apply --production --reason.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../db.ts";
import { toUnits } from "../money.ts";
import { resolveTargetOrg } from "./target-org.ts";

type HourKind = "regular" | "overtime" | "double_time";

interface SourceTicket {
  legacyId: string;
  number: string;
  projectRef: string;
  periodStart: string;
  periodEnd: string;
  approved: boolean;
}

interface SourceCell {
  sourceRef: string;
  ticketLegacyId: string;
  employeeRef: string;
  itemRef: string;
  shortform: string;
  workedOn: string;
  kind: HourKind;
  hours: string;
  payloadHash: string;
}

interface TargetRef {
  id: string;
  name: string;
}

interface TargetTicket {
  id: string;
  legacyId: string;
  number: string;
  status: string;
  projectId: string;
  projectRef: string;
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
const requestedOrgId =
  args.get("org") ??
  process.env.TARGET_ORG ??
  process.env.SANDBOX_ORG;
if (!requestedOrgId || !/^[0-9a-f-]{36}$/i.test(requestedOrgId)) {
  throw new Error("--org=<uuid> is required");
}
const orgId: string = requestedOrgId;
const headerPath = args.get("headers") ?? "/tmp/ft-head.tsv";
const rowPath = args.get("rows") ?? "/tmp/ft-rows.tsv";
const outputPath =
  args.get("out") ??
  `/tmp/openbooks-field-ticket-draft-time-${orgId}-${Date.now()}.json`;
const apply = args.get("apply") === "true";
const reason = args.get("reason")?.trim() ?? "";
if (!existsSync(headerPath) || !existsSync(rowPath)) {
  throw new Error("both --headers and --rows source artifacts are required");
}
if (apply && (reason.length < 10 || reason.length > 500)) {
  throw new Error("--reason must be 10-500 characters when applying");
}

const TYPE_SOURCE_REF: Record<HourKind, string> = {
  regular: process.env.ADMINAPP2_REGULAR_TIME_TYPE_REF ?? "1",
  overtime: process.env.ADMINAPP2_OVERTIME_TIME_TYPE_REF ?? "2",
  double_time: process.env.ADMINAPP2_DOUBLE_TIME_TYPE_REF ?? "3",
};
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

function canonicalDecimal(value: string): string {
  const trimmed = value.trim();
  if (!DECIMAL.test(trimmed)) {
    throw new Error(`invalid non-negative decimal in source export: ${value}`);
  }
  const [whole, fraction = ""] = trimmed.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction
    ? `${normalizedWhole}.${normalizedFraction}`
    : normalizedWhole;
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const stableHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const cellKey = (cell: {
  ticketLegacyId: string;
  employeeRef: string;
  itemRef: string;
  workedOn: string;
  kind: string;
}): string =>
  [
    cell.ticketLegacyId,
    cell.employeeRef,
    cell.itemRef,
    cell.workedOn,
    cell.kind,
  ].join("|");

function parseSource(): {
  tickets: SourceTicket[];
  cells: SourceCell[];
  duplicateCellKeys: string[];
} {
  const tickets = readFileSync(headerPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .filter((columns) => columns.length >= 13 && /^\d+$/.test(columns[0] ?? ""))
    .map((columns) => ({
      legacyId: columns[0]!,
      number: columns[1]!,
      projectRef: columns[2]!,
      periodStart: columns[5]!,
      periodEnd: columns[6]!,
      approved: columns[9] === "Yes",
    }));
  const ticketById = new Map(tickets.map((ticket) => [ticket.legacyId, ticket]));
  if (ticketById.size !== tickets.length) {
    throw new Error("source ticket export contains duplicate header identities");
  }

  const cells: SourceCell[] = [];
  const seen = new Set<string>();
  const duplicateCellKeys: string[] = [];
  for (const columns of readFileSync(rowPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .filter((candidate) =>
      candidate.length >= 25 && /^\d+$/.test(candidate[0] ?? "")
    )) {
    const ticket = ticketById.get(columns[0]!);
    if (!ticket || ticket.approved) continue;
    for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
      for (const [offset, kind] of [
        [0, "regular"],
        [1, "overtime"],
        [2, "double_time"],
      ] as const) {
        const hours = canonicalDecimal(
          columns[4 + dayOffset * 3 + offset] ?? "0",
        );
        if (hours === "0") continue;
        const workedOn = addDays(ticket.periodStart, dayOffset);
        const source = {
          ticketLegacyId: ticket.legacyId,
          employeeRef: columns[1]!,
          itemRef: columns[2]!,
          shortform: columns[3]?.trim() ?? "",
          workedOn,
          kind,
          hours,
        };
        const key = cellKey(source);
        if (seen.has(key)) duplicateCellKeys.push(key);
        seen.add(key);
        cells.push({
          ...source,
          sourceRef: [
            "billable_timesheetrow_cell",
            ticket.legacyId,
            columns[1],
            columns[2],
            workedOn,
            kind,
          ].join(":"),
          payloadHash: stableHash(source),
        });
      }
    }
  }
  return { tickets, cells, duplicateCellKeys };
}

async function uniqueSourceMap(
  table: "parties" | "items" | "time_types",
): Promise<{ values: Map<string, TargetRef>; duplicates: string[] }> {
  const result = await db.execute(sql.raw(`
    select custom->>'nsId' as source_ref,
           min(id::text) as id,
           min(${table === "parties" ? "display_name" : "name"}) as name,
           count(*)::int as matches
      from ${table}
     where org_id = '${orgId}'
       and custom->>'nsId' is not null
     group by custom->>'nsId'
  `));
  const rows = result.rows as Array<{
    source_ref: string;
    id: string;
    name: string;
    matches: number;
  }>;
  return {
    values: new Map(
      rows
        .filter((row) => Number(row.matches) === 1)
        .map((row) => [
          row.source_ref,
          { id: row.id, name: row.name },
        ]),
    ),
    duplicates: rows
      .filter((row) => Number(row.matches) !== 1)
      .map((row) => row.source_ref)
      .sort(),
  };
}

async function main(): Promise<void> {
  const target = await resolveTargetOrg(orgId);
  if (apply && target.isProduction && !process.argv.includes("--production")) {
    throw new Error("--production is required for a live tenant");
  }
  const source = parseSource();
  const draftTickets = source.tickets.filter((ticket) => !ticket.approved);
  const draftIds = new Set(draftTickets.map((ticket) => ticket.legacyId));

  const [partyMap, itemMap, typeMap, targetResult, existingResult, actorResult] =
    await Promise.all([
      uniqueSourceMap("parties"),
      uniqueSourceMap("items"),
      uniqueSourceMap("time_types"),
      db.execute(sql`
        select d.id, d.custom #>> '{legacy,id}' as legacy_id,
               d.document_number, d.status, d.project_id,
               project.custom->>'nsId' as project_ref
          from documents d
          join projects project
            on project.id = d.project_id and project.org_id = d.org_id
         where d.org_id = ${orgId}
           and d.kind = 'field_ticket'
           and d.custom #>> '{legacy,id}' is not null
      `),
      db.execute(sql`
        select ticket.custom #>> '{legacy,id}' as ticket_legacy_id,
               employee.custom->>'nsId' as employee_ref,
               item.custom->>'nsId' as item_ref,
               te.worked_on::text as worked_on,
               type.classification,
               te.hours::text as hours,
               te.status,
               te.cost_journal_entry_id,
               te.overhead_journal_entry_id,
               te.invoiced_by_line_id
          from time_entries te
          join documents ticket
            on ticket.id = te.field_ticket_id and ticket.org_id = te.org_id
          join parties employee
            on employee.id = te.employee_party_id and employee.org_id = te.org_id
          join items item
            on item.id = te.item_id and item.org_id = te.org_id
          join time_types type
            on type.id = te.time_type_id and type.org_id = te.org_id
         where te.org_id = ${orgId}
           and ticket.kind = 'field_ticket'
           and ticket.custom #>> '{legacy,id}' is not null
      `),
      db.execute(sql`
        select id
          from users
         where org_id = ${orgId}
         order by case when email ilike '%verify%' then 0 else 1 end, created_at
         limit 1
      `),
    ]);

  const targetRows = targetResult.rows as Array<{
    id: string;
    legacy_id: string;
    document_number: string;
    status: string;
    project_id: string;
    project_ref: string;
  }>;
  const duplicateTargetTicketRefs = [...new Set(
    targetRows
      .filter((row, index, all) =>
        all.findIndex((candidate) => candidate.legacy_id === row.legacy_id) !==
          index
      )
      .map((row) => row.legacy_id),
  )].sort();
  const targetByLegacyId = new Map(
    targetRows
      .filter((row) => !duplicateTargetTicketRefs.includes(row.legacy_id))
      .map((row) => [
        row.legacy_id,
        {
          id: row.id,
          legacyId: row.legacy_id,
          number: row.document_number,
          status: row.status,
          projectId: row.project_id,
          projectRef: row.project_ref,
        } satisfies TargetTicket,
      ]),
  );

  const actualByCell = new Map<string, bigint>();
  const protectedExistingEntries: string[] = [];
  for (const row of existingResult.rows as Array<Record<string, unknown>>) {
    const legacyId = String(row.ticket_legacy_id ?? "");
    if (!draftIds.has(legacyId)) continue;
    const key = cellKey({
      ticketLegacyId: legacyId,
      employeeRef: String(row.employee_ref ?? ""),
      itemRef: String(row.item_ref ?? ""),
      workedOn: String(row.worked_on ?? ""),
      kind: String(row.classification ?? ""),
    });
    actualByCell.set(
      key,
      (actualByCell.get(key) ?? 0n) + toUnits(String(row.hours ?? "0")),
    );
    if (
      row.status !== "draft" ||
      row.cost_journal_entry_id ||
      row.overhead_journal_entry_id ||
      row.invoiced_by_line_id
    ) {
      protectedExistingEntries.push(key);
    }
  }

  const sourceByCell = new Map(
    source.cells.map((cell) => [cellKey(cell), cell]),
  );
  const missingCells: SourceCell[] = [];
  const mismatchedCells: Array<{
    key: string;
    sourceHours: string;
    targetHours: string;
  }> = [];
  const extraCells: Array<{ key: string; targetHours: string }> = [];
  for (const [key, cell] of sourceByCell) {
    const actual = actualByCell.get(key);
    if (actual == null) {
      missingCells.push(cell);
    } else if (actual !== toUnits(cell.hours)) {
      mismatchedCells.push({
        key,
        sourceHours: cell.hours,
        targetHours: (Number(actual) / 10_000).toFixed(4),
      });
    }
  }
  for (const [key, hours] of actualByCell) {
    if (!sourceByCell.has(key)) {
      extraCells.push({
        key,
        targetHours: (Number(hours) / 10_000).toFixed(4),
      });
    }
  }

  const missingTicketRefs = draftTickets
    .filter((ticket) => !targetByLegacyId.has(ticket.legacyId))
    .map((ticket) => ticket.legacyId);
  const targetTicketMismatches = draftTickets
    .flatMap((ticket) => {
      const targetTicket = targetByLegacyId.get(ticket.legacyId);
      if (!targetTicket) return [];
      return targetTicket.status !== "draft" ||
          targetTicket.number !== ticket.number ||
          targetTicket.projectRef !== ticket.projectRef
        ? [{
            legacyId: ticket.legacyId,
            sourceNumber: ticket.number,
            targetNumber: targetTicket.number,
            sourceProjectRef: ticket.projectRef,
            targetProjectRef: targetTicket.projectRef,
            targetStatus: targetTicket.status,
          }]
        : [];
    });
  const missingEmployeeRefs = [...new Set(
    source.cells
      .filter((cell) => !partyMap.values.has(cell.employeeRef))
      .map((cell) => cell.employeeRef),
  )].sort();
  const missingItemRefs = [...new Set(
    source.cells
      .filter((cell) => !itemMap.values.has(cell.itemRef))
      .map((cell) => cell.itemRef),
  )].sort();
  const missingTimeTypeRefs = [...new Set(
    source.cells
      .filter((cell) => !typeMap.values.has(TYPE_SOURCE_REF[cell.kind]))
      .map((cell) => TYPE_SOURCE_REF[cell.kind]),
  )].sort();

  const blocking = {
    duplicateSourceCellKeys: [...new Set(source.duplicateCellKeys)].sort(),
    duplicatePartySourceRefs: partyMap.duplicates,
    duplicateItemSourceRefs: itemMap.duplicates,
    duplicateTimeTypeSourceRefs: typeMap.duplicates,
    duplicateTargetTicketRefs,
    missingTicketRefs,
    targetTicketMismatches,
    missingEmployeeRefs,
    missingItemRefs,
    missingTimeTypeRefs,
    mismatchedCells,
    extraCells,
  };
  const blockingCount = Object.values(blocking).reduce(
    (total, values) => total + values.length,
    0,
  );

  let inserted = 0;
  if (apply) {
    if (blockingCount > 0) {
      throw new Error(
        `refusing draft-time import: ${blockingCount} conflicts or ambiguous mappings`,
      );
    }
    const actorId = String(
      (actorResult.rows[0] as { id?: unknown } | undefined)?.id ?? "",
    );
    if (!actorId) throw new Error("target organization has no audit actor");
    const sourceRowsSha256 = createHash("sha256")
      .update(readFileSync(rowPath))
      .digest("hex");
    const runId = randomUUID();
    const planned = missingCells.map((cell) => {
      const ticket = targetByLegacyId.get(cell.ticketLegacyId)!;
      return {
        ticketId: ticket.id,
        projectId: ticket.projectId,
        employeePartyId: partyMap.values.get(cell.employeeRef)!.id,
        itemId: itemMap.values.get(cell.itemRef)!.id,
        timeTypeId:
          typeMap.values.get(TYPE_SOURCE_REF[cell.kind])!.id,
        workedOn: cell.workedOn,
        hours: cell.hours,
        sourceRef: cell.sourceRef,
        sourcePayloadHash: cell.payloadHash,
      };
    });
    await withOrg(orgId, async () => {
      await db.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended(${`field-ticket-draft-time:${orgId}`}, 0)
        )
      `);
      const result = await db.execute(sql`
        with source as (
          select *
            from jsonb_to_recordset(${JSON.stringify(planned)}::jsonb)
                 as x(
                   "ticketId" uuid,
                   "projectId" uuid,
                   "employeePartyId" uuid,
                   "itemId" uuid,
                   "timeTypeId" uuid,
                   "workedOn" date,
                   hours numeric,
                   "sourceRef" text,
                   "sourcePayloadHash" text
                 )
        ),
        inserted as (
          insert into time_entries
            (org_id, employee_party_id, worked_on, hours, time_type_id,
             item_id, project_id, is_billable, status, field_ticket_id,
             custom, created_by, updated_by)
          select ${orgId}, source."employeePartyId", source."workedOn",
                 source.hours, source."timeTypeId", source."itemId",
                 source."projectId", true, 'draft', source."ticketId",
                 jsonb_build_object(
                   'sourceImport',
                   jsonb_build_object(
                     'system', 'adminapp2',
                     'entity', 'billable_timesheetrow_cell',
                     'ref', source."sourceRef",
                     'payloadSha256', source."sourcePayloadHash",
                     'sourceArtifactSha256', ${sourceRowsSha256}::text
                   )
                 ),
                 ${actorId}, ${actorId}
            from source
           where not exists (
             select 1
               from time_entries existing
              where existing.org_id = ${orgId}
                and existing.custom #>> '{sourceImport,ref}' =
                    source."sourceRef"
           )
          returning id, custom #>> '{sourceImport,ref}' as source_ref
        )
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        select ${orgId}, 'time_entries', inserted.id, 'insert',
               jsonb_build_object(
                 'mode', 'source_draft_field_ticket_time_import',
                 'reason', ${reason}::text,
                 'sourceRef', inserted.source_ref,
                 'sourceArtifactSha256', ${sourceRowsSha256}::text,
                 'status', 'draft',
                 'financialEffects', false
               ),
               ${actorId}, ${runId}
          from inserted
        returning row_id
      `);
      inserted = result.rows.length;
    });
    if (inserted !== planned.length) {
      throw new Error(
        `idempotency conflict: planned ${planned.length} inserts but wrote ${inserted}`,
      );
    }
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: {
      orgId: target.id,
      name: target.name,
      environment: target.envKind,
    },
    mode: apply ? "apply" : "plan",
    sourceArtifacts: {
      headers: {
        path: headerPath,
        sha256: createHash("sha256")
          .update(readFileSync(headerPath))
          .digest("hex"),
      },
      rows: {
        path: rowPath,
        sha256: createHash("sha256")
          .update(readFileSync(rowPath))
          .digest("hex"),
      },
    },
    population: {
      draftTickets: draftTickets.length,
      draftCells: source.cells.length,
      exactCells: source.cells.length - missingCells.length,
      missingCells: missingCells.length,
      insertedDraftTimeEntries: inserted,
      protectedExistingEntriesPreserved:
        new Set(protectedExistingEntries).size,
      approvalEffects: 0,
      postingEffects: 0,
      invoiceEffects: 0,
    },
    blocking,
    blockingCount,
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    ...report,
    blocking: Object.fromEntries(
      Object.entries(blocking).map(([key, values]) => [
        key,
        { count: values.length, sample: values.slice(0, 10) },
      ]),
    ),
  }, null, 2));
  console.log(`report: ${outputPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
