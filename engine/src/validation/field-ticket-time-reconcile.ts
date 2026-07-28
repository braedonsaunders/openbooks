/**
 * Exhaustive field-ticket ↔ atomic-time reconciliation.
 *
 * A field ticket is always one project. A time-entry line is always one
 * employee/date/time-type/item/project atom and may belong to at most one
 * field ticket. This tool proves whether imported atomic time can be reassigned
 * to the exact legacy ticket cells without changing hours, and separately
 * reports groups that would require a controlled split or missing source time.
 *
 * Dry-run only. Customer data is written outside the repository by default.
 *
 * Usage:
 *   npx tsx src/validation/field-ticket-time-reconcile.ts \
 *     --org=<uuid> --headers=/tmp/ft-head.tsv --rows=/tmp/ft-rows.tsv
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../db.ts";
import { fromUnits, toUnits } from "../money.ts";

interface Ticket {
  id: string;
  number: string;
  projectRef: string;
  begin: string;
}

interface ExpectedCell {
  ticketRef: string;
  ticketNumber: string;
  baseKey: string;
  hours: bigint;
}

interface TimeEntry {
  id: string;
  sourceRef: string | null;
  baseKey: string;
  hours: bigint;
  currentTicketRef: string | null;
  currentTicketNumber: string | null;
  status: string;
  invoicedByLineId: string | null;
  costJournalEntryId: string | null;
  overheadJournalEntryId: string | null;
}

interface SourceTimeLink {
  id: string;
  ticketNumber: string;
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
const rowPath = args.get("rows") ?? "/tmp/ft-rows.tsv";
const sourceTimeLinkPath =
  args.get("source-time-links") ??
  (existsSync("/tmp/ns-time-ticket.json")
    ? "/tmp/ns-time-ticket.json"
    : null);
const out =
  args.get("out") ??
  `/tmp/openbooks-field-ticket-time-reconcile-${orgId}-${Date.now()}.json`;
if (!existsSync(headerPath) || !existsSync(rowPath)) {
  throw new Error("legacy field-ticket header and row exports are required");
}

const hash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
async function retry<T>(fn: () => Promise<T>, attempts = 7): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const messages: string[] = [];
      const seen = new Set<unknown>();
      let current: unknown = error;
      while (current && !seen.has(current)) {
        seen.add(current);
        messages.push(
          current instanceof Error ? current.message : String(current),
        );
        current =
          typeof current === "object" && "cause" in current
            ? (current as { cause?: unknown }).cause
            : null;
      }
      if (
        !/timeout|terminated|ECONN|ETIMEDOUT|EHOSTUNREACH|Connection/i.test(
          messages.join("\n"),
        )
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 750 * (attempt + 1)),
      );
    }
  }
  throw last;
}
const addDays = (iso: string, days: number) => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const baseKey = (
  projectRef: unknown,
  employeeRef: unknown,
  itemRef: unknown,
  workedOn: unknown,
  timeKind: unknown,
) =>
  [projectRef, employeeRef, itemRef, workedOn, timeKind]
    .map((value) => String(value ?? ""))
    .join("|");

const tickets = new Map<string, Ticket>();
const ticketsByNumber = new Map<string, Ticket>();
for (const line of readFileSync(headerPath, "utf8").split(/\r?\n/)) {
  const columns = line.split("\t");
  if (columns.length < 13 || !/^\d+$/.test(columns[0] ?? "")) continue;
  const ticket = {
    id: columns[0]!,
    number: columns[1]!,
    projectRef: columns[2]!,
    begin: columns[5]!,
  };
  if (ticketsByNumber.has(ticket.number)) {
    throw new Error(`duplicate source field-ticket number ${ticket.number}`);
  }
  tickets.set(ticket.id, ticket);
  ticketsByNumber.set(ticket.number, ticket);
}

const sourceTimeLinks: SourceTimeLink[] = sourceTimeLinkPath
  ? (JSON.parse(readFileSync(sourceTimeLinkPath, "utf8")) as Array<
      Record<string, unknown>
    >).map((row) => ({
      id: String(row.id ?? ""),
      ticketNumber: String(row.ticket_number ?? row.ticketNumber ?? "").trim(),
    }))
  : [];
const sourceTicketByTimeRef = new Map<string, string>();
for (const link of sourceTimeLinks) {
  if (!link.id || !link.ticketNumber) {
    throw new Error("source time-link rows require id and ticket_number");
  }
  const prior = sourceTicketByTimeRef.get(link.id);
  if (prior && prior !== link.ticketNumber) {
    throw new Error(
      `source time entry ${link.id} has conflicting field tickets ${prior} and ${link.ticketNumber}`,
    );
  }
  sourceTicketByTimeRef.set(link.id, link.ticketNumber);
}

const expectedByTicketAndBase = new Map<string, ExpectedCell>();
for (const line of readFileSync(rowPath, "utf8").split(/\r?\n/)) {
  const columns = line.split("\t");
  if (columns.length < 25 || !/^\d+$/.test(columns[0] ?? "")) continue;
  const ticket = tickets.get(columns[0]!);
  if (!ticket) continue;
  for (let day = 0; day < 7; day++) {
    for (const [offset, kind] of [
      [0, "regular"],
      [1, "overtime"],
      [2, "double_time"],
    ] as const) {
      const hours = toUnits(columns[4 + day * 3 + offset] ?? "0");
      if (hours === 0n) continue;
      const group = baseKey(
        ticket.projectRef,
        columns[1],
        columns[2],
        addDays(ticket.begin, day),
        kind,
      );
      const key = `${ticket.id}::${group}`;
      const current = expectedByTicketAndBase.get(key);
      expectedByTicketAndBase.set(key, {
        ticketRef: ticket.id,
        ticketNumber: ticket.number,
        baseKey: group,
        hours: (current?.hours ?? 0n) + hours,
      });
    }
  }
}

const rawEntries = await retry(() => withOrgContext(orgId, async () => {
  const result = await db.execute(sql`
    select te.id,
           te.custom->>'nsId' as source_ref,
           project.custom->>'nsId' as project_ref,
           employee.custom->>'nsId' as employee_ref,
           item.custom->>'nsId' as item_ref,
           te.worked_on::text as worked_on,
           coalesce(tt.classification, 'regular') as time_kind,
           te.hours::text,
           ticket.custom->'legacy'->>'id' as current_ticket_ref,
           ticket.document_number as current_ticket_number,
           te.status,
           te.invoiced_by_line_id,
           te.cost_journal_entry_id,
           te.overhead_journal_entry_id
      from time_entries te
      join projects project on project.id = te.project_id and project.org_id = te.org_id
      join parties employee on employee.id = te.employee_party_id and employee.org_id = te.org_id
      left join items item on item.id = te.item_id and item.org_id = te.org_id
      left join time_types tt on tt.id = te.time_type_id and tt.org_id = te.org_id
      left join documents ticket on ticket.id = te.field_ticket_id and ticket.org_id = te.org_id
     where te.org_id = ${orgId}
       and project.custom->>'nsId' is not null
       and employee.custom->>'nsId' is not null
  `);
  return result.rows as Array<Record<string, unknown>>;
}));

const entries: TimeEntry[] = rawEntries.map((row) => ({
  id: String(row.id),
  sourceRef: row.source_ref ? String(row.source_ref) : null,
  baseKey: baseKey(
    row.project_ref,
    row.employee_ref,
    row.item_ref,
    row.worked_on,
    row.time_kind,
  ),
  hours: toUnits(String(row.hours ?? "0")),
  currentTicketRef: row.current_ticket_ref
    ? String(row.current_ticket_ref)
    : null,
  currentTicketNumber: row.current_ticket_number
    ? String(row.current_ticket_number)
    : null,
  status: String(row.status),
  invoicedByLineId: row.invoiced_by_line_id
    ? String(row.invoiced_by_line_id)
    : null,
  costJournalEntryId: row.cost_journal_entry_id
    ? String(row.cost_journal_entry_id)
    : null,
  overheadJournalEntryId: row.overhead_journal_entry_id
    ? String(row.overhead_journal_entry_id)
    : null,
}));

const expectedGroups = new Map<string, ExpectedCell[]>();
for (const cell of expectedByTicketAndBase.values()) {
  const list = expectedGroups.get(cell.baseKey) ?? [];
  list.push(cell);
  expectedGroups.set(cell.baseKey, list);
}
const entryGroups = new Map<string, TimeEntry[]>();
for (const entry of entries) {
  if (!expectedGroups.has(entry.baseKey)) continue;
  const list = entryGroups.get(entry.baseKey) ?? [];
  list.push(entry);
  entryGroups.set(entry.baseKey, list);
}

function findSubset(
  candidates: TimeEntry[],
  wanted: bigint,
): TimeEntry[] | null {
  const paths = new Map<bigint, number[]>([[0n, []]]);
  for (let index = 0; index < candidates.length; index++) {
    for (const [sum, path] of [...paths.entries()].sort((a, b) =>
      a[0] > b[0] ? -1 : a[0] < b[0] ? 1 : 0,
    )) {
      const next = sum + candidates[index]!.hours;
      if (next > wanted || paths.has(next)) continue;
      const nextPath = [...path, index];
      if (next === wanted) return nextPath.map((i) => candidates[i]!);
      paths.set(next, nextPath);
    }
  }
  return null;
}

const assignments: Array<{
  timeEntryId: string;
  fromTicketRef: string | null;
  toTicketRef: string;
  hours: string;
  status: string;
  protectedEvidence: boolean;
}> = [];
const groupResults: Array<Record<string, unknown>> = [];
let exactGroups = 0;
let reassignmentOnlyGroups = 0;
let splitRequiredGroups = 0;
let sourceExceedsTargetGroups = 0;
let targetExceedsSourceGroups = 0;

for (const [group, expected] of expectedGroups) {
  const candidates = [...(entryGroups.get(group) ?? [])].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const sourceHours = expected.reduce((sum, cell) => sum + cell.hours, 0n);
  const targetHours = candidates.reduce((sum, entry) => sum + entry.hours, 0n);
  const unassigned = new Set(candidates.map((entry) => entry.id));
  const planned: Array<{ cell: ExpectedCell; entries: TimeEntry[] }> = [];
  let needsSplit = false;

  // Preserve already-correct ticket assignments first.
  for (const cell of expected) {
    const current = candidates.filter(
      (entry) =>
        unassigned.has(entry.id) &&
        entry.currentTicketRef === cell.ticketRef,
    );
    if (current.reduce((sum, entry) => sum + entry.hours, 0n) !== cell.hours) {
      continue;
    }
    planned.push({ cell, entries: current });
    current.forEach((entry) => unassigned.delete(entry.id));
  }

  for (const cell of expected) {
    if (planned.some((plan) => plan.cell === cell)) continue;
    const pool = candidates.filter((entry) => unassigned.has(entry.id));
    const subset = findSubset(pool, cell.hours);
    if (!subset) {
      needsSplit = true;
      continue;
    }
    planned.push({ cell, entries: subset });
    subset.forEach((entry) => unassigned.delete(entry.id));
  }

  const fullyAssigned =
    planned.length === expected.length &&
    planned.every(
      (plan) =>
        plan.entries.reduce((sum, entry) => sum + entry.hours, 0n) ===
        plan.cell.hours,
    );
  if (sourceHours > targetHours) sourceExceedsTargetGroups++;
  if (targetHours > sourceHours) targetExceedsSourceGroups++;
  if (needsSplit && sourceHours <= targetHours) splitRequiredGroups++;

  const changes = planned.flatMap((plan) =>
    plan.entries
      .filter((entry) => entry.currentTicketRef !== plan.cell.ticketRef)
      .map((entry) => ({ entry, ticketRef: plan.cell.ticketRef })),
  );
  if (fullyAssigned && changes.length === 0) exactGroups++;
  if (fullyAssigned && changes.length > 0) reassignmentOnlyGroups++;
  if (fullyAssigned) {
    for (const { entry, ticketRef } of changes) {
      assignments.push({
        timeEntryId: entry.id,
        fromTicketRef: entry.currentTicketRef,
        toTicketRef: ticketRef,
        hours: fromUnits(entry.hours),
        status: entry.status,
        protectedEvidence: Boolean(
          entry.invoicedByLineId ||
            entry.costJournalEntryId ||
            entry.overheadJournalEntryId,
        ),
      });
    }
  }

  if (!fullyAssigned || changes.length > 0 || targetHours !== sourceHours) {
    groupResults.push({
      baseKey: group,
      sourceHours: fromUnits(sourceHours),
      targetHours: fromUnits(targetHours),
      expected: expected.map((cell) => ({
        ticketRef: cell.ticketRef,
        ticketNumber: cell.ticketNumber,
        hours: fromUnits(cell.hours),
      })),
      candidates: candidates.map((entry) => ({
        id: entry.id,
        hours: fromUnits(entry.hours),
        currentTicketRef: entry.currentTicketRef,
        currentTicketNumber: entry.currentTicketNumber,
        status: entry.status,
        invoiced: Boolean(entry.invoicedByLineId),
        costPosted: Boolean(entry.costJournalEntryId),
        overheadPosted: Boolean(entry.overheadJournalEntryId),
      })),
      fullyAssigned,
      needsSplit,
      plannedChanges: changes.length,
    });
  }
}

/**
 * The upstream time source retains authoritative lineage on each atomic line:
 * its source ID is already retained by the target time entry and a configured
 * source field carries the field-ticket number. Unlike the aggregate fallback
 * above, this proves each individual assignment without tenant-specific logic.
 */
const entryBySourceRef = new Map<string, TimeEntry>();
for (const entry of entries) {
  if (!entry.sourceRef) continue;
  if (entryBySourceRef.has(entry.sourceRef)) {
    throw new Error(`duplicate target time-entry source ref ${entry.sourceRef}`);
  }
  entryBySourceRef.set(entry.sourceRef, entry);
}

const lineageAssignments: Array<{
  timeEntryId: string;
  sourceRef: string;
  fromTicketNumber: string | null;
  toTicketNumber: string;
  protectedEvidence: boolean;
}> = [];
let lineageMissingTargetEntries = 0;
let lineageUnknownTickets = 0;
let lineageExactCurrentLinks = 0;
const lineageAggregate = new Map<string, bigint>();
for (const link of sourceTimeLinks) {
  const ticket = ticketsByNumber.get(link.ticketNumber);
  if (!ticket) {
    lineageUnknownTickets++;
    continue;
  }
  const entry = entryBySourceRef.get(link.id);
  if (!entry) {
    lineageMissingTargetEntries++;
    continue;
  }
  const aggregateKey = `${ticket.id}::${entry.baseKey}`;
  lineageAggregate.set(
    aggregateKey,
    (lineageAggregate.get(aggregateKey) ?? 0n) + entry.hours,
  );
  if (entry.currentTicketNumber === link.ticketNumber) {
    lineageExactCurrentLinks++;
    continue;
  }
  lineageAssignments.push({
    timeEntryId: entry.id,
    sourceRef: link.id,
    fromTicketNumber: entry.currentTicketNumber,
    toTicketNumber: link.ticketNumber,
    protectedEvidence: Boolean(
      entry.invoicedByLineId ||
        entry.costJournalEntryId ||
        entry.overheadJournalEntryId,
    ),
  });
}

let lineageExactCells = 0;
let lineageMissingCells = 0;
let lineageAmountMismatchCells = 0;
let lineageExtraCells = 0;
const lineageCellDifferences: Array<Record<string, unknown>> = [];
for (const [key, cell] of expectedByTicketAndBase) {
  const actual = lineageAggregate.get(key);
  if (actual === cell.hours) {
    lineageExactCells++;
  } else if (actual == null) {
    lineageMissingCells++;
  } else {
    lineageAmountMismatchCells++;
  }
  if (actual !== cell.hours) {
    lineageCellDifferences.push({
      ticketRef: cell.ticketRef,
      ticketNumber: cell.ticketNumber,
      baseKey: cell.baseKey,
      sourceHours: fromUnits(cell.hours),
      targetHours: fromUnits(actual ?? 0n),
    });
  }
}
for (const [key, actual] of lineageAggregate) {
  if (expectedByTicketAndBase.has(key)) continue;
  lineageExtraCells++;
  const [ticketRef, ...baseParts] = key.split("::");
  lineageCellDifferences.push({
    ticketRef,
    ticketNumber: tickets.get(ticketRef!)?.number ?? null,
    baseKey: baseParts.join("::"),
    sourceHours: "0.0000",
    targetHours: fromUnits(actual),
  });
}

const report = {
  schemaVersion: 2,
  runId: randomUUID(),
  generatedAt: new Date().toISOString(),
  orgId,
  sourceArtifacts: {
    headers: { path: headerPath, sha256: hash(headerPath) },
    rows: { path: rowPath, sha256: hash(rowPath) },
    ...(sourceTimeLinkPath
      ? {
          sourceTimeLinks: {
            path: sourceTimeLinkPath,
            sha256: hash(sourceTimeLinkPath),
          },
        }
      : {}),
  },
  summary: {
    sourceTickets: tickets.size,
    sourceCells: expectedByTicketAndBase.size,
    sourceBaseGroups: expectedGroups.size,
    candidateTimeEntries: [...entryGroups.values()].reduce(
      (sum, group) => sum + group.length,
      0,
    ),
    exactGroups,
    reassignmentOnlyGroups,
    splitRequiredGroups,
    sourceExceedsTargetGroups,
    targetExceedsSourceGroups,
    plannedReassignments: assignments.length,
    protectedReassignments: assignments.filter(
      (assignment) => assignment.protectedEvidence,
    ).length,
    sourceTimeLinks: sourceTimeLinks.length,
    lineageMissingTargetEntries,
    lineageUnknownTickets,
    lineageExactCurrentLinks,
    lineageRequiredReassignments: lineageAssignments.length,
    lineageProtectedReassignments: lineageAssignments.filter(
      (assignment) => assignment.protectedEvidence,
    ).length,
    lineageExactCells,
    lineageMissingCells,
    lineageAmountMismatchCells,
    lineageExtraCells,
  },
  lineageAssignments,
  lineageCellDifferences,
  assignments,
  groupResults,
};
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary, null, 2));
console.log(`report: ${out}`);
