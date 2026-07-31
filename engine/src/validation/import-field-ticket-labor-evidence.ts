/**
 * Import the exact AdminApp2 Field Ticket labor grid as versioned commercial
 * evidence. This does NOT create, update, approve, post, or relink time entries.
 *
 * Input:
 *   --headers  ticket headers exported by import-field-tickets.ts
 *   --rows     ticket, employee, item, shortform, 7 × (regular, OT, DT)
 *
 * Approved source tickets receive a controlled `source_import` revision.
 * Draft source tickets are reported, not snapshotted: their editable source of
 * truth remains operational time. Every source reference must resolve uniquely
 * before --apply is permitted.
 *
 * Usage:
 *   TARGET_ORG=<uuid> npx tsx src/validation/import-field-ticket-labor-evidence.ts
 *   TARGET_ORG=<uuid> npx tsx src/validation/import-field-ticket-labor-evidence.ts --apply --production
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import {
  captureFieldTicketLaborEvidence,
  type FieldTicketLaborEvidenceLine,
} from "../field-ticket-labor-evidence.ts";
import { db } from "../db.ts";
import { resolveTargetOrg } from "./target-org.ts";

const ORG =
  process.env.TARGET_ORG ??
  process.env.SANDBOX_ORG ??
  (process.env.SANDBOX_ORG ?? (() => { throw new Error("SANDBOX_ORG is required"); })());
const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, ...value] = arg.slice(2).split("=");
      return [key!, value.length ? value.join("=") : "true"];
    }),
);
const argValue = (name: string): string | null => {
  const mapped = args.get(name);
  if (mapped && mapped !== "true") return mapped;
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
};
const APPLY = args.get("apply") === "true";
const OUT = argValue("out");
const HEADERS = argValue("headers") ?? "/tmp/ft-head.tsv";
const ROWS = argValue("rows") ?? "/tmp/ft-rows.tsv";
if (!existsSync(HEADERS) || !existsSync(ROWS)) {
  throw new Error("--headers and --rows source artifacts are required");
}
const TIME_TYPE_SOURCE_REFS: Record<HourKind, string> = {
  regular: process.env.ADMINAPP2_REGULAR_TIME_TYPE_REF ?? "1",
  overtime: process.env.ADMINAPP2_OVERTIME_TIME_TYPE_REF ?? "2",
  double_time: process.env.ADMINAPP2_DOUBLE_TIME_TYPE_REF ?? "3",
};
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

type HourKind = "regular" | "overtime" | "double_time";
interface Ticket {
  legacyId: string;
  number: string;
  begin: string;
  end: string;
  approved: boolean;
}
interface SourceCell {
  ticketLegacyId: string;
  employeeRef: string;
  itemRef: string;
  shortform: string;
  dayOffset: number;
  kind: HourKind;
  hours: string;
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
  currency: string;
}

function canonicalDecimal(value: string): string {
  const trimmed = value.trim();
  if (!DECIMAL.test(trimmed)) {
    throw new Error(`invalid non-negative decimal in AdminApp2 export: ${value}`);
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

function parseTickets(): Ticket[] {
  return readFileSync(HEADERS, "utf8")
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((columns) => columns.length >= 13 && /^\d+$/.test(columns[0]))
    .map((columns) => ({
      legacyId: columns[0],
      number: columns[1],
      begin: columns[5],
      end: columns[6],
      approved: columns[9] === "Yes",
    }));
}

function parseCells(): SourceCell[] {
  const cells: SourceCell[] = [];
  for (const columns of readFileSync(ROWS, "utf8")
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((candidate) => candidate.length >= 25 && /^\d+$/.test(candidate[0]))) {
    for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
      for (const [offset, kind] of [
        [0, "regular"],
        [1, "overtime"],
        [2, "double_time"],
      ] as const) {
        const hours = canonicalDecimal(columns[4 + dayOffset * 3 + offset] ?? "0");
        if (hours === "0") continue;
        cells.push({
          ticketLegacyId: columns[0],
          employeeRef: columns[1],
          itemRef: columns[2],
          shortform: columns[3]?.trim() ?? "",
          dayOffset,
          kind,
          hours,
        });
      }
    }
  }
  return cells;
}

async function uniqueSourceMap(
  table: "parties" | "items" | "time_types",
): Promise<{ values: Map<string, TargetRef>; duplicateRefs: string[] }> {
  const result = (await db.execute(sql.raw(`
    select custom->>'nsId' as source_ref,
           min(id::text) as id,
           min(name_value) as name,
           count(*)::int as matches
      from (
        select id, custom,
               ${table === "parties" ? "display_name" : "name"} as name_value
          from ${table}
         where org_id = '${ORG}'
           and custom->>'nsId' is not null
      ) source_rows
     group by custom->>'nsId'
  `))) as unknown as {
    rows: Array<{ source_ref: string; id: string; name: string; matches: number }>;
  };
  return {
    values: new Map(
      result.rows
        .filter((row) => Number(row.matches) === 1)
        .map((row) => [row.source_ref, { id: row.id, name: row.name }]),
    ),
    duplicateRefs: result.rows
      .filter((row) => Number(row.matches) !== 1)
      .map((row) => row.source_ref)
      .sort(),
  };
}

const stableHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function main(): Promise<void> {
  const target = await resolveTargetOrg(ORG);
  const tickets = parseTickets();
  const sourceCells = parseCells();
  const sourceTicketById = new Map(tickets.map((ticket) => [ticket.legacyId, ticket]));
  if (sourceTicketById.size !== tickets.length) {
    throw new Error("AdminApp2 ticket export contains duplicate header identities");
  }

  const [partyMap, itemMap, timeTypeMap, targetTicketRows, actorRows] =
    await Promise.all([
      uniqueSourceMap("parties"),
      uniqueSourceMap("items"),
      uniqueSourceMap("time_types"),
      db.execute(sql`
        select d.id, d.custom #>> '{legacy,id}' as legacy_id,
               d.document_number, d.status, d.currency
          from documents d
         where d.org_id = ${ORG}
           and d.kind = 'field_ticket'
           and d.custom #>> '{legacy,id}' is not null
      `),
      db.execute(sql`
        select id from users
         where org_id = ${ORG}
         order by case when email ilike '%verify%' then 0 else 1 end, created_at
         limit 1
      `),
    ]);
  const actorId = String(
    (actorRows as unknown as { rows: Array<{ id: string }> }).rows[0]?.id ?? "",
  );
  if (!actorId) throw new Error("target organization has no audit actor");

  const targetTickets = (targetTicketRows as unknown as {
    rows: Array<{
      id: string;
      legacy_id: string;
      document_number: string;
      status: string;
      currency: string;
    }>;
  }).rows.map<TargetTicket>((row) => ({
    id: row.id,
    legacyId: row.legacy_id,
    number: row.document_number,
    status: row.status,
    currency: row.currency,
  }));
  const duplicateTargetTicketRefs = [...new Set(
    targetTickets
      .filter((ticket, index, all) =>
        all.findIndex((candidate) => candidate.legacyId === ticket.legacyId) !== index)
      .map((ticket) => ticket.legacyId),
  )].sort();
  const targetTicketByLegacyId = new Map(
    targetTickets
      .filter((ticket) => !duplicateTargetTicketRefs.includes(ticket.legacyId))
      .map((ticket) => [ticket.legacyId, ticket]),
  );

  const cellsByTicket = new Map<string, SourceCell[]>();
  let orphanSourceCells = 0;
  for (const cell of sourceCells) {
    if (!sourceTicketById.has(cell.ticketLegacyId)) {
      orphanSourceCells += 1;
      continue;
    }
    const current = cellsByTicket.get(cell.ticketLegacyId) ?? [];
    current.push(cell);
    cellsByTicket.set(cell.ticketLegacyId, current);
  }

  const missingTicketRefs = tickets
    .filter((ticket) => !targetTicketByLegacyId.has(ticket.legacyId))
    .map((ticket) => ticket.legacyId);
  const targetStatusMismatches = tickets
    .filter((ticket) => {
      const targetTicket = targetTicketByLegacyId.get(ticket.legacyId);
      return targetTicket &&
        (ticket.approved
          ? targetTicket.status !== "approved"
          : targetTicket.status === "approved");
    })
    .map((ticket) => ticket.legacyId);
  const missingEmployeeRefs = new Set<string>();
  const missingItemRefs = new Set<string>();
  const missingTimeTypeRefs = new Set<string>();
  for (const cell of sourceCells) {
    if (sourceTicketById.has(cell.ticketLegacyId)) {
      if (!partyMap.values.has(cell.employeeRef)) missingEmployeeRefs.add(cell.employeeRef);
      if (!itemMap.values.has(cell.itemRef)) missingItemRefs.add(cell.itemRef);
      const timeTypeRef = TIME_TYPE_SOURCE_REFS[cell.kind];
      if (!timeTypeMap.values.has(timeTypeRef)) missingTimeTypeRefs.add(timeTypeRef);
    }
  }

  const approvedTickets = tickets.filter((ticket) => ticket.approved);
  const draftTickets = tickets.filter((ticket) => !ticket.approved);
  const approvedSourceCells = approvedTickets.reduce(
    (total, ticket) => total + (cellsByTicket.get(ticket.legacyId)?.length ?? 0),
    0,
  );
  const draftSourceCells = draftTickets.reduce(
    (total, ticket) => total + (cellsByTicket.get(ticket.legacyId)?.length ?? 0),
    0,
  );
  const blocking = {
    duplicatePartySourceRefs: partyMap.duplicateRefs,
    duplicateItemSourceRefs: itemMap.duplicateRefs,
    duplicateTimeTypeSourceRefs: timeTypeMap.duplicateRefs,
    duplicateTargetTicketRefs,
    missingTicketRefs,
    targetStatusMismatches,
    missingEmployeeRefs: [...missingEmployeeRefs].sort(),
    missingItemRefs: [...missingItemRefs].sort(),
    missingTimeTypeRefs: [...missingTimeTypeRefs].sort(),
  };
  const blockingCount = Object.values(blocking).reduce(
    (total, values) => total + values.length,
    0,
  );

  let snapshotsCreated = 0;
  let snapshotsSuperseded = 0;
  let snapshotsUnchanged = 0;
  let linesCaptured = 0;
  if (APPLY) {
    if (blockingCount > 0) {
      throw new Error(`refusing source-evidence import: ${blockingCount} unresolved or ambiguous mappings`);
    }
    for (const [ticketIndex, ticket] of approvedTickets.entries()) {
      const targetTicket = targetTicketByLegacyId.get(ticket.legacyId)!;
      const source = (cellsByTicket.get(ticket.legacyId) ?? [])
        .slice()
        .sort((a, b) =>
          a.employeeRef.localeCompare(b.employeeRef) ||
          a.itemRef.localeCompare(b.itemRef) ||
          a.dayOffset - b.dayOffset ||
          a.kind.localeCompare(b.kind));
      const canonicalPayload = {
        sourceSystem: "adminapp2",
        ticketLegacyId: ticket.legacyId,
        ticketNumber: ticket.number,
        periodStart: ticket.begin,
        periodEnd: ticket.end,
        approved: ticket.approved,
        lines: source,
      };
      const payloadHash = stableHash(canonicalPayload);
      const lines: FieldTicketLaborEvidenceLine[] = source.map((cell) => {
        const employee = partyMap.values.get(cell.employeeRef)!;
        const item = itemMap.values.get(cell.itemRef)!;
        const timeType = timeTypeMap.values.get(TIME_TYPE_SOURCE_REFS[cell.kind])!;
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
          workedOn: addDays(ticket.begin, cell.dayOffset),
          hours: cell.hours,
          sourceSystem: "adminapp2",
          sourceLineRef: [
            ticket.legacyId,
            cell.employeeRef,
            cell.itemRef,
            cell.dayOffset,
            cell.kind,
          ].join(":"),
          sourcePayloadHash: stableHash(sourceLine),
        };
      });
      const result = await captureFieldTicketLaborEvidence({
        orgId: ORG,
        fieldTicketId: targetTicket.id,
        actorId,
        evidenceBasis: "source_import",
        reason:
          "Exact approved commercial labor grid imported from AdminApp2; operational time and its approval/posting state remain unchanged",
        currency: targetTicket.currency,
        sourceSystem: "adminapp2",
        sourcePayloadHash: payloadHash,
        lines,
        supersedeCurrent: true,
      });
      if (result.unchanged) snapshotsUnchanged += 1;
      else {
        snapshotsCreated += 1;
        if (result.revision > 1) snapshotsSuperseded += 1;
      }
      linesCaptured += result.lineCount;
      if (
        (ticketIndex + 1) % 250 === 0 ||
        ticketIndex + 1 === approvedTickets.length
      ) {
        console.log(
          `captured ${ticketIndex + 1}/${approvedTickets.length} approved tickets ` +
            `(${linesCaptured} source cells)`,
        );
      }
    }
  }

  const report = {
    target: {
      orgId: target.id,
      name: target.name,
      environment: target.envKind,
    },
    mode: APPLY ? "apply" : "plan",
    source: {
      ticketHeaders: tickets.length,
      approvedTickets: approvedTickets.length,
      draftTickets: draftTickets.length,
      nonzeroCells: sourceCells.length,
      approvedCells: approvedSourceCells,
      draftCells: draftSourceCells,
      orphanCellsWithoutCurrentHeader: orphanSourceCells,
    },
    targetTickets: targetTickets.length,
    blocking,
    blockingCount,
    result: {
      snapshotsCreated,
      snapshotsSuperseded,
      snapshotsUnchanged,
      linesCaptured,
      operationalTimeRowsMutated: 0,
    },
  };
  if (OUT) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  const consoleReport = {
    ...report,
    blocking: Object.fromEntries(
      Object.entries(blocking).map(([key, values]) => [
        key,
        { count: values.length, sample: values.slice(0, 20) },
      ]),
    ),
  };
  console.log(JSON.stringify(consoleReport, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
