/**
 * Reconcile source labor rows whose Field Ticket headers are no longer present
 * with approved archival tickets reconstructed from independently sourced,
 * line-level time provenance.
 *
 * A mapping is accepted only when the complete aggregate labor grid
 * (employee, item, weekday, explicit time classification, exact hours) has one
 * and only one target ticket match. Partial, nearest, chronological, or
 * by-elimination matches are never accepted. Exact matches may be captured as
 * immutable commercial evidence; conflicts remain reported and untouched.
 *
 * Dry-run by default. --apply-exact writes only uniquely proven matches and
 * requires --production --reason for a live tenant.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import {
  captureFieldTicketLaborEvidence,
  type FieldTicketLaborEvidenceLine,
} from "../field-ticket-labor-evidence.ts";
import { db } from "../db.ts";
import { toUnits } from "../money.ts";
import { resolveTargetOrg } from "./target-org.ts";

type HourKind = "regular" | "overtime" | "double_time";

interface SourceCell {
  ticketLegacyId: string;
  employeeRef: string;
  itemRef: string;
  shortform: string;
  dayOffset: number;
  kind: HourKind;
  hours: string;
}

interface TargetTicket {
  id: string;
  number: string;
  status: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  projectRef: string;
  sourceArtifactSha256: string;
}

interface TargetTime {
  ticketId: string;
  ticketNumber: string;
  timeEntryId: string;
  timeSourceRef: string;
  employeeRef: string;
  itemRef: string;
  workedOn: string;
  classification: HourKind | "other";
  hours: string;
}

interface TargetRef {
  id: string;
  name: string;
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
const timePath = args.get("source-time") ?? "/tmp/ns-time-ticket-detail.json";
const outputPath =
  args.get("out") ??
  `/tmp/openbooks-archival-field-ticket-labor-${orgId}-${Date.now()}.json`;
const applyExact = args.get("apply-exact") === "true";
const reason = args.get("reason")?.trim() ?? "";
if (
  !existsSync(headerPath) ||
  !existsSync(rowPath) ||
  !existsSync(timePath)
) {
  throw new Error("--headers, --rows, and --source-time artifacts are required");
}
if (applyExact && (reason.length < 10 || reason.length > 500)) {
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

function utcWeekday(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

const hashBytes = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const stableHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function aggregateSignature(
  rows: Array<{
    employeeRef: string;
    itemRef: string;
    dayOffset: number;
    kind: string;
    hours: string;
  }>,
): string {
  const aggregate = new Map<string, bigint>();
  for (const row of rows) {
    const key = [
      row.employeeRef,
      row.itemRef,
      row.dayOffset,
      row.kind,
    ].join("|");
    aggregate.set(
      key,
      (aggregate.get(key) ?? 0n) + toUnits(row.hours),
    );
  }
  return [...aggregate]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, hours]) => `${key}|${hours}`)
    .join("\n");
}

function parseOrphanCells(): {
  cellsByTicket: Map<string, SourceCell[]>;
  sourceHeaderIds: Set<string>;
} {
  const sourceHeaderIds = new Set(
    readFileSync(headerPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.split("\t"))
      .filter((columns) =>
        columns.length >= 13 && /^\d+$/.test(columns[0] ?? "")
      )
      .map((columns) => columns[0]!),
  );
  const cellsByTicket = new Map<string, SourceCell[]>();
  for (const columns of readFileSync(rowPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .filter((candidate) =>
      candidate.length >= 25 && /^\d+$/.test(candidate[0] ?? "")
    )) {
    const ticketLegacyId = columns[0]!;
    if (sourceHeaderIds.has(ticketLegacyId)) continue;
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
        const current = cellsByTicket.get(ticketLegacyId) ?? [];
        current.push({
          ticketLegacyId,
          employeeRef: columns[1]!,
          itemRef: columns[2]!,
          shortform: columns[3]?.trim() ?? "",
          dayOffset,
          kind,
          hours,
        });
        cellsByTicket.set(ticketLegacyId, current);
      }
    }
  }
  return { cellsByTicket, sourceHeaderIds };
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
  if (
    applyExact &&
    target.isProduction &&
    !process.argv.includes("--production")
  ) {
    throw new Error("--production is required for a live tenant");
  }
  const source = parseOrphanCells();
  const sourceTimeSha256 = hashBytes(timePath);
  const sourceTime = JSON.parse(
    readFileSync(timePath, "utf8"),
  ) as Array<Record<string, unknown>>;
  const sourceTimeIds = new Set(
    sourceTime.map((row) => String(row.id ?? "")).filter(Boolean),
  );
  if (sourceTimeIds.size !== sourceTime.length) {
    throw new Error("source time artifact has duplicate or empty identities");
  }

  const [
    targetTicketResult,
    targetTimeResult,
    partyMap,
    itemMap,
    typeMap,
    actorResult,
  ] = await Promise.all([
    db.execute(sql`
      select d.id, d.document_number, d.status, d.currency,
             ft.period_start::text as period_start,
             ft.period_end::text as period_end,
             project.custom->>'nsId' as project_ref,
             d.custom #>> '{sourceArchive,sourceArtifactSha256}' as
               source_artifact_sha256
        from documents d
        join field_tickets ft
          on ft.document_id = d.id and ft.org_id = d.org_id
        join projects project
          on project.id = d.project_id and project.org_id = d.org_id
       where d.org_id = ${orgId}
         and d.kind = 'field_ticket'
         and d.custom #>> '{sourceArchive,disposition}' =
             'source_header_missing'
    `),
    db.execute(sql`
      select ticket.id as ticket_id,
             ticket.document_number as ticket_number,
             te.id as time_entry_id,
             te.custom->>'nsId' as time_source_ref,
             employee.custom->>'nsId' as employee_ref,
             item.custom->>'nsId' as item_ref,
             te.worked_on::text as worked_on,
             type.classification,
             te.hours::text as hours
        from documents ticket
        join time_entries te
          on te.field_ticket_id = ticket.id and te.org_id = ticket.org_id
        join parties employee
          on employee.id = te.employee_party_id and employee.org_id = te.org_id
        join items item
          on item.id = te.item_id and item.org_id = te.org_id
        left join time_types type
          on type.id = te.time_type_id and type.org_id = te.org_id
       where ticket.org_id = ${orgId}
         and ticket.kind = 'field_ticket'
         and ticket.custom #>> '{sourceArchive,disposition}' =
             'source_header_missing'
    `),
    uniqueSourceMap("parties"),
    uniqueSourceMap("items"),
    uniqueSourceMap("time_types"),
    db.execute(sql`
      select id
        from users
       where org_id = ${orgId}
       order by case when email ilike '%verify%' then 0 else 1 end, created_at
       limit 1
    `),
  ]);

  const targetTickets = new Map(
    (targetTicketResult.rows as Array<Record<string, unknown>>).map((row) => [
      String(row.id),
      {
        id: String(row.id),
        number: String(row.document_number),
        status: String(row.status),
        currency: String(row.currency),
        periodStart: String(row.period_start),
        periodEnd: String(row.period_end),
        projectRef: String(row.project_ref),
        sourceArtifactSha256: String(row.source_artifact_sha256 ?? ""),
      } satisfies TargetTicket,
    ]),
  );
  const targetTimes = (targetTimeResult.rows as Array<Record<string, unknown>>)
    .map<TargetTime>((row) => ({
      ticketId: String(row.ticket_id),
      ticketNumber: String(row.ticket_number),
      timeEntryId: String(row.time_entry_id),
      timeSourceRef: String(row.time_source_ref ?? ""),
      employeeRef: String(row.employee_ref ?? ""),
      itemRef: String(row.item_ref ?? ""),
      workedOn: String(row.worked_on),
      classification: String(
        row.classification ?? "other",
      ) as TargetTime["classification"],
      hours: canonicalDecimal(String(row.hours)),
    }));

  const targetTimesByTicket = new Map<string, TargetTime[]>();
  for (const row of targetTimes) {
    const current = targetTimesByTicket.get(row.ticketId) ?? [];
    current.push(row);
    targetTimesByTicket.set(row.ticketId, current);
  }
  const targetSignatureToTickets = new Map<string, string[]>();
  for (const [ticketId, rows] of targetTimesByTicket) {
    const signature = aggregateSignature(
      rows.map((row) => ({
        employeeRef: row.employeeRef,
        itemRef: row.itemRef,
        dayOffset: utcWeekday(row.workedOn),
        kind: row.classification,
        hours: row.hours,
      })),
    );
    const current = targetSignatureToTickets.get(signature) ?? [];
    current.push(ticketId);
    targetSignatureToTickets.set(signature, current);
  }

  const exactMappings: Array<{
    sourceLegacyId: string;
    targetTicketId: string;
    targetTicketNumber: string;
    sourceCells: number;
    sourceHours: string;
    signatureSha256: string;
  }> = [];
  const ambiguousMappings: Array<{
    sourceLegacyId: string;
    candidateTicketNumbers: string[];
  }> = [];
  const unmatchedSourceLegacyIds: string[] = [];
  for (const [sourceLegacyId, cells] of source.cellsByTicket) {
    const signature = aggregateSignature(cells);
    const candidateIds = targetSignatureToTickets.get(signature) ?? [];
    if (candidateIds.length === 1) {
      const ticket = targetTickets.get(candidateIds[0]!)!;
      exactMappings.push({
        sourceLegacyId,
        targetTicketId: ticket.id,
        targetTicketNumber: ticket.number,
        sourceCells: cells.length,
        sourceHours: (
          Number(cells.reduce(
            (sum, cell) => sum + toUnits(cell.hours),
            0n,
          )) / 10_000
        ).toFixed(4),
        signatureSha256: stableHash(signature),
      });
    } else if (candidateIds.length > 1) {
      ambiguousMappings.push({
        sourceLegacyId,
        candidateTicketNumbers: candidateIds
          .map((id) => targetTickets.get(id)!.number)
          .sort(),
      });
    } else {
      unmatchedSourceLegacyIds.push(sourceLegacyId);
    }
  }
  exactMappings.sort((a, b) =>
    Number(a.sourceLegacyId) - Number(b.sourceLegacyId)
  );
  ambiguousMappings.sort((a, b) =>
    Number(a.sourceLegacyId) - Number(b.sourceLegacyId)
  );
  unmatchedSourceLegacyIds.sort((a, b) => Number(a) - Number(b));
  const matchedTargetIds = new Set(
    exactMappings.map((mapping) => mapping.targetTicketId),
  );
  const unmatchedTargetTickets = [...targetTickets.values()]
    .filter((ticket) => !matchedTargetIds.has(ticket.id))
    .map((ticket) => ticket.number)
    .sort();

  const missingEmployeeRefs = [...new Set(
    exactMappings.flatMap((mapping) =>
      (source.cellsByTicket.get(mapping.sourceLegacyId) ?? [])
        .filter((cell) => !partyMap.values.has(cell.employeeRef))
        .map((cell) => cell.employeeRef)
    ),
  )].sort();
  const missingItemRefs = [...new Set(
    exactMappings.flatMap((mapping) =>
      (source.cellsByTicket.get(mapping.sourceLegacyId) ?? [])
        .filter((cell) => !itemMap.values.has(cell.itemRef))
        .map((cell) => cell.itemRef)
    ),
  )].sort();
  const missingTimeTypeRefs = [...new Set(
    exactMappings.flatMap((mapping) =>
      (source.cellsByTicket.get(mapping.sourceLegacyId) ?? [])
        .filter((cell) => !typeMap.values.has(TYPE_SOURCE_REF[cell.kind]))
        .map((cell) => TYPE_SOURCE_REF[cell.kind])
    ),
  )].sort();
  const invalidTargetTickets = [...targetTickets.values()]
    .filter((ticket) => ticket.status !== "approved")
    .map((ticket) => ({
      ticketNumber: ticket.number,
      status: ticket.status,
    }));
  const wrongSourceArtifactTickets = [...targetTickets.values()]
    .filter((ticket) => ticket.sourceArtifactSha256 !== sourceTimeSha256)
    .map((ticket) => ({
      ticketNumber: ticket.number,
      expectedSha256: sourceTimeSha256,
      retainedSha256: ticket.sourceArtifactSha256,
    }));
  const sourceRefsByTicketNumber = new Map<string, Set<string>>();
  for (const row of sourceTime) {
    const ticketNumber = String(
      row.ticket_number ?? row.ticketNumber ?? "",
    ).trim();
    const sourceRef = String(row.id ?? "");
    if (!ticketNumber || !sourceRef) continue;
    const current = sourceRefsByTicketNumber.get(ticketNumber) ?? new Set();
    current.add(sourceRef);
    sourceRefsByTicketNumber.set(ticketNumber, current);
  }
  const targetRefsByTicketNumber = new Map<string, Set<string>>();
  for (const row of targetTimes) {
    const current =
      targetRefsByTicketNumber.get(row.ticketNumber) ?? new Set();
    if (row.timeSourceRef) current.add(row.timeSourceRef);
    targetRefsByTicketNumber.set(row.ticketNumber, current);
  }
  const sourceTimeLinkDifferences = [...targetTickets.values()]
    .flatMap((ticket) => {
      const expected = sourceRefsByTicketNumber.get(ticket.number) ?? new Set();
      const actual =
        targetRefsByTicketNumber.get(ticket.number) ?? new Set();
      const missing = [...expected].filter((ref) => !actual.has(ref)).sort();
      const extra = [...actual].filter((ref) => !expected.has(ref)).sort();
      return missing.length || extra.length
        ? [{ ticketNumber: ticket.number, missing, extra }]
        : [];
    });
  const targetTimesWithoutExactSource = targetTimes
    .filter((row) =>
      !row.timeSourceRef || !sourceTimeIds.has(row.timeSourceRef)
    )
    .map((row) => ({
      ticketNumber: row.ticketNumber,
      timeEntryId: row.timeEntryId,
      sourceRef: row.timeSourceRef,
    }));
  const blocking = {
    ambiguousMappings,
    missingEmployeeRefs,
    missingItemRefs,
    missingTimeTypeRefs,
    invalidTargetTickets,
    wrongSourceArtifactTickets,
    sourceTimeLinkDifferences,
    targetTimesWithoutExactSource,
    duplicatePartySourceRefs: partyMap.duplicates,
    duplicateItemSourceRefs: itemMap.duplicates,
    duplicateTimeTypeSourceRefs: typeMap.duplicates,
  };
  const blockingCount = Object.values(blocking).reduce(
    (total, values) => total + values.length,
    0,
  );

  let snapshotsCreated = 0;
  let snapshotsSuperseded = 0;
  let snapshotsUnchanged = 0;
  let linesCaptured = 0;
  if (applyExact) {
    if (blockingCount > 0) {
      throw new Error(
        `refusing exact archival capture: ${blockingCount} blocking integrity failures`,
      );
    }
    const actorId = String(
      (actorResult.rows[0] as { id?: unknown } | undefined)?.id ?? "",
    );
    if (!actorId) throw new Error("target organization has no audit actor");
    const sourceRowsSha256 = hashBytes(rowPath);
    for (const [index, mapping] of exactMappings.entries()) {
      const ticket = targetTickets.get(mapping.targetTicketId)!;
      const sourceCells = (source.cellsByTicket.get(
        mapping.sourceLegacyId,
      ) ?? [])
        .slice()
        .sort((a, b) =>
          a.employeeRef.localeCompare(b.employeeRef) ||
          a.itemRef.localeCompare(b.itemRef) ||
          a.dayOffset - b.dayOffset ||
          a.kind.localeCompare(b.kind)
        );
      const canonicalPayload = {
        sourceSystem: "adminapp2",
        sourceEntity: "orphan_billable_timesheetrow_grid",
        ticketLegacyId: mapping.sourceLegacyId,
        ticketNumber: ticket.number,
        periodStart: ticket.periodStart,
        periodEnd: ticket.periodEnd,
        mappingMethod: "unique_complete_atomic_grid_signature",
        mappingSignatureSha256: mapping.signatureSha256,
        independentTimeArtifactSha256: sourceTimeSha256,
        lines: sourceCells,
      };
      const lines: FieldTicketLaborEvidenceLine[] = sourceCells.map((cell) => {
        const employee = partyMap.values.get(cell.employeeRef)!;
        const item = itemMap.values.get(cell.itemRef)!;
        const timeType = typeMap.values.get(TYPE_SOURCE_REF[cell.kind])!;
        const sourceLine = {
          ticketLegacyId: cell.ticketLegacyId,
          employeeRef: cell.employeeRef,
          itemRef: cell.itemRef,
          shortform: cell.shortform,
          dayOffset: cell.dayOffset,
          kind: cell.kind,
          hours: cell.hours,
        };
        return {
          employeePartyId: employee.id,
          employeeName: employee.name,
          itemId: item.id,
          itemName: item.name,
          timeTypeId: timeType.id,
          timeTypeName: timeType.name,
          timeClassification: cell.kind,
          workedOn: addDays(ticket.periodStart, cell.dayOffset),
          hours: cell.hours,
          sourceSystem: "adminapp2",
          sourceLineRef: [
            "orphan",
            mapping.sourceLegacyId,
            cell.employeeRef,
            cell.itemRef,
            cell.dayOffset,
            cell.kind,
          ].join(":"),
          sourcePayloadHash: stableHash(sourceLine),
        };
      });
      const result = await captureFieldTicketLaborEvidence({
        orgId,
        fieldTicketId: ticket.id,
        actorId,
        evidenceBasis: "source_import",
        reason,
        currency: ticket.currency,
        sourceSystem: "adminapp2",
        sourcePayloadHash: stableHash(canonicalPayload),
        lines,
        supersedeCurrent: true,
      });
      if (result.unchanged) snapshotsUnchanged += 1;
      else {
        snapshotsCreated += 1;
        if (result.revision > 1) snapshotsSuperseded += 1;
      }
      linesCaptured += result.lineCount;
      if ((index + 1) % 25 === 0 || index + 1 === exactMappings.length) {
        console.log(
          `captured ${index + 1}/${exactMappings.length} exact archival mappings`,
        );
      }
    }
    if (
      linesCaptured !==
        exactMappings.reduce((total, mapping) => total + mapping.sourceCells, 0)
    ) {
      throw new Error("captured line count does not equal the proven source population");
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
    mode: applyExact ? "apply_exact" : "plan",
    sourceArtifacts: {
      headers: { path: headerPath, sha256: hashBytes(headerPath) },
      rows: { path: rowPath, sha256: hashBytes(rowPath) },
      independentTime: { path: timePath, sha256: sourceTimeSha256 },
    },
    population: {
      orphanSourceTickets: source.cellsByTicket.size,
      orphanSourceCells: [...source.cellsByTicket.values()].reduce(
        (total, cells) => total + cells.length,
        0,
      ),
      archivalTargetTickets: targetTickets.size,
      archivalTargetTimeRows: targetTimes.length,
      exactMappedTickets: exactMappings.length,
      exactMappedCells: exactMappings.reduce(
        (total, mapping) => total + mapping.sourceCells,
        0,
      ),
      unmatchedSourceTickets: unmatchedSourceLegacyIds.length,
      unmatchedTargetTickets: unmatchedTargetTickets.length,
    },
    exactMappings,
    conflicts: {
      unmatchedSourceLegacyIds,
      unmatchedTargetTickets,
    },
    blocking,
    blockingCount,
    result: {
      snapshotsCreated,
      snapshotsSuperseded,
      snapshotsUnchanged,
      linesCaptured,
      operationalTimeRowsMutated: 0,
      approvalEffects: 0,
      postingEffects: 0,
      invoiceEffects: 0,
    },
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    ...report,
    exactMappings: {
      count: exactMappings.length,
      sample: exactMappings.slice(0, 10),
    },
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
