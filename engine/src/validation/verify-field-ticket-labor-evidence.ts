/**
 * Whole-population certificate for AdminApp2-approved Field Ticket labor
 * evidence. Compares every non-zero source grid cell and every approved ticket
 * payload hash to the current immutable OpenBooks snapshot.
 *
 * Usage:
 *   TARGET_ORG=<uuid> npx tsx src/validation/verify-field-ticket-labor-evidence.ts --production --out report.json
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { resolveTargetOrg } from "./target-org.ts";

const ORG =
  process.env.TARGET_ORG ??
  process.env.SANDBOX_ORG ??
  "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
const outIndex = process.argv.indexOf("--out");
const OUT = outIndex >= 0 ? process.argv[outIndex + 1] : null;
const TYPE_REF_BY_KIND = {
  regular: process.env.ADMINAPP2_REGULAR_TIME_TYPE_REF ?? "1",
  overtime: process.env.ADMINAPP2_OVERTIME_TIME_TYPE_REF ?? "2",
  double_time: process.env.ADMINAPP2_DOUBLE_TIME_TYPE_REF ?? "3",
} as const;
type HourKind = keyof typeof TYPE_REF_BY_KIND;

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

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function decimal(value: string): string {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    throw new Error(`invalid source decimal: ${value}`);
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
  const value = new Date(Date.UTC(year, month - 1, day, 12));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function source(): { tickets: Ticket[]; cells: SourceCell[] } {
  const tickets = readFileSync("/tmp/ft-head.tsv", "utf8")
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
  const cells: SourceCell[] = [];
  for (const columns of readFileSync("/tmp/ft-rows.tsv", "utf8")
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((candidate) => candidate.length >= 25 && /^\d+$/.test(candidate[0]))) {
    for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
      for (const [offset, kind] of [
        [0, "regular"],
        [1, "overtime"],
        [2, "double_time"],
      ] as const) {
        const hours = decimal(columns[4 + dayOffset * 3 + offset] ?? "0");
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
  return { tickets, cells };
}

const cellKey = (parts: {
  ticketLegacyId: string;
  employeeRef: string;
  itemRef: string;
  workedOn: string;
  timeTypeRef: string;
}): string =>
  [
    parts.ticketLegacyId,
    parts.employeeRef,
    parts.itemRef,
    parts.workedOn,
    parts.timeTypeRef,
  ].join("|");

async function main(): Promise<void> {
  const target = await resolveTargetOrg(ORG);
  const extracted = source();
  const approvedTickets = extracted.tickets.filter((ticket) => ticket.approved);
  const approvedIds = new Set(approvedTickets.map((ticket) => ticket.legacyId));
  const cellsByTicket = new Map<string, SourceCell[]>();
  for (const cell of extracted.cells) {
    if (!approvedIds.has(cell.ticketLegacyId)) continue;
    const values = cellsByTicket.get(cell.ticketLegacyId) ?? [];
    values.push(cell);
    cellsByTicket.set(cell.ticketLegacyId, values);
  }

  const expected = new Map<string, string>();
  const expectedDuplicateKeys: string[] = [];
  const expectedTicketHashes = new Map<string, string>();
  for (const ticket of approvedTickets) {
    const cells = (cellsByTicket.get(ticket.legacyId) ?? [])
      .slice()
      .sort((a, b) =>
        a.employeeRef.localeCompare(b.employeeRef) ||
        a.itemRef.localeCompare(b.itemRef) ||
        a.dayOffset - b.dayOffset ||
        a.kind.localeCompare(b.kind));
    expectedTicketHashes.set(
      ticket.legacyId,
      hash({
        sourceSystem: "adminapp2",
        ticketLegacyId: ticket.legacyId,
        ticketNumber: ticket.number,
        periodStart: ticket.begin,
        periodEnd: ticket.end,
        approved: ticket.approved,
        lines: cells,
      }),
    );
    for (const cell of cells) {
      const key = cellKey({
        ticketLegacyId: ticket.legacyId,
        employeeRef: cell.employeeRef,
        itemRef: cell.itemRef,
        workedOn: addDays(ticket.begin, cell.dayOffset),
        timeTypeRef: TYPE_REF_BY_KIND[cell.kind],
      });
      if (expected.has(key)) expectedDuplicateKeys.push(key);
      expected.set(key, cell.hours);
    }
  }

  const [snapshotResult, lineResult] = await Promise.all([
    db.execute(sql`
      select d.custom #>> '{legacy,id}' as ticket_legacy_id,
             snapshot.id, snapshot.revision, snapshot.source_payload_hash
        from documents d
        join field_ticket_labor_snapshots snapshot
          on snapshot.field_ticket_id = d.id
         and snapshot.org_id = d.org_id
         and snapshot.superseded_at is null
       where d.org_id = ${ORG}
         and d.kind = 'field_ticket'
         and d.status = 'approved'
         and snapshot.evidence_basis = 'source_import'
         and snapshot.source_system = 'adminapp2'
    `),
    db.execute(sql`
      select d.custom #>> '{legacy,id}' as ticket_legacy_id,
             employee.custom->>'nsId' as employee_ref,
             item.custom->>'nsId' as item_ref,
             time_type.custom->>'nsId' as time_type_ref,
             line.worked_on::text as worked_on,
             line.hours::text as hours
        from documents d
        join field_ticket_labor_snapshots snapshot
          on snapshot.field_ticket_id = d.id
         and snapshot.org_id = d.org_id
         and snapshot.superseded_at is null
         and snapshot.evidence_basis = 'source_import'
         and snapshot.source_system = 'adminapp2'
        join field_ticket_labor_lines line
          on line.snapshot_id = snapshot.id
         and line.org_id = snapshot.org_id
         and line.field_ticket_id = snapshot.field_ticket_id
        join parties employee
          on employee.id = line.employee_party_id
         and employee.org_id = line.org_id
        join items item
          on item.id = line.item_id
         and item.org_id = line.org_id
        join time_types time_type
          on time_type.id = line.time_type_id
         and time_type.org_id = line.org_id
       where d.org_id = ${ORG}
         and d.kind = 'field_ticket'
         and d.status = 'approved'
    `),
  ]);
  const snapshots = snapshotResult.rows as Array<Record<string, unknown>>;
  const lines = lineResult.rows as Array<Record<string, unknown>>;

  const actual = new Map<string, string>();
  const actualDuplicateKeys: string[] = [];
  for (const row of lines) {
    const key = cellKey({
      ticketLegacyId: String(row.ticket_legacy_id),
      employeeRef: String(row.employee_ref),
      itemRef: String(row.item_ref),
      workedOn: String(row.worked_on),
      timeTypeRef: String(row.time_type_ref),
    });
    if (actual.has(key)) actualDuplicateKeys.push(key);
    actual.set(key, decimal(String(row.hours)));
  }

  const missingCells: Array<{ key: string; hours: string }> = [];
  const extraCells: Array<{ key: string; hours: string }> = [];
  const hourMismatches: Array<{ key: string; source: string; target: string }> = [];
  for (const [key, hours] of expected) {
    const targetHours = actual.get(key);
    if (targetHours == null) missingCells.push({ key, hours });
    else if (targetHours !== hours) {
      hourMismatches.push({ key, source: hours, target: targetHours });
    }
  }
  for (const [key, hours] of actual) {
    if (!expected.has(key)) extraCells.push({ key, hours });
  }

  const actualTicketHashes = new Map(
    snapshots.map((row) => [
      String(row.ticket_legacy_id),
      String(row.source_payload_hash),
    ]),
  );
  const missingTicketSnapshots = approvedTickets
    .filter((ticket) => !actualTicketHashes.has(ticket.legacyId))
    .map((ticket) => ticket.legacyId);
  const extraTicketSnapshots = [...actualTicketHashes.keys()]
    .filter((legacyId) => !expectedTicketHashes.has(legacyId));
  const ticketHashMismatches = [...expectedTicketHashes]
    .filter(([legacyId, expectedHash]) =>
      actualTicketHashes.has(legacyId) &&
      actualTicketHashes.get(legacyId) !== expectedHash)
    .map(([legacyId, expectedHash]) => ({
      legacyId,
      source: expectedHash,
      target: actualTicketHashes.get(legacyId),
    }));

  const failureCount =
    expectedDuplicateKeys.length +
    actualDuplicateKeys.length +
    missingCells.length +
    extraCells.length +
    hourMismatches.length +
    missingTicketSnapshots.length +
    extraTicketSnapshots.length +
    ticketHashMismatches.length;
  const report = {
    generatedAt: new Date().toISOString(),
    target: {
      orgId: target.id,
      name: target.name,
      environment: target.envKind,
    },
    source: {
      approvedTickets: approvedTickets.length,
      approvedNonzeroCells: expected.size,
    },
    targetEvidence: {
      currentSourceSnapshots: snapshots.length,
      currentSourceLines: actual.size,
    },
    gates: {
      expectedDuplicateKeys,
      actualDuplicateKeys,
      missingCells,
      extraCells,
      hourMismatches,
      missingTicketSnapshots,
      extraTicketSnapshots,
      ticketHashMismatches,
    },
    failureCount,
    certified: failureCount === 0,
  };
  if (OUT) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    ...report,
    gates: Object.fromEntries(
      Object.entries(report.gates).map(([key, values]) => [
        key,
        { count: values.length, sample: values.slice(0, 10) },
      ]),
    ),
  }, null, 2));
  if (failureCount > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
