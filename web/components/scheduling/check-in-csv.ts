/**
 * Reads a time-clock export into device check-ins. The file needs a header
 * row naming source_event_id, source_worker_id, kind and occurred_at, and
 * may name source_version (1 when absent). Times must carry a UTC offset so
 * an instant is never guessed from a browser's clock; every other column is
 * kept as the check-in's source record. Pure: no I/O.
 */
import type { SourceCheckIn } from "@openbooks/engine/schedule-boards/attendance";

export const CHECK_IN_KINDS = [
  "clock_in",
  "clock_out",
  "break_start",
  "break_end",
  "void",
] as const;
const REQUIRED = ["source_event_id", "source_worker_id", "kind", "occurred_at"] as const;
const OFFSET_INSTANT =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export type CheckInCsvProblem =
  | { readonly code: "empty" }
  | { readonly code: "missing_column"; readonly column: string }
  | { readonly code: "kind" | "time" | "version" | "blank" | "columns"; readonly line: number }
  | { readonly code: "duplicate"; readonly line: number; readonly firstLine: number };

export type ParsedCheckIn = Omit<SourceCheckIn, "id">;

/** Split CSV text into rows of fields, honouring quoted fields and doubled quotes. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((value) => value.trim() !== ""));
}

export function parseCheckInCsv(text: string): {
  readonly events: ParsedCheckIn[];
  readonly problems: CheckInCsvProblem[];
} {
  const rows = csvRows(text.replace(/^\uFEFF/, ""));
  if (rows.length < 2) return { events: [], problems: [{ code: "empty" }] };
  const header = rows[0]!.map((name) => name.trim().toLowerCase());
  const missing = REQUIRED.filter((column) => !header.includes(column));
  if (missing.length)
    return { events: [], problems: missing.map((column) => ({ code: "missing_column", column })) };
  const at = (row: readonly string[], column: string) => (row[header.indexOf(column)] ?? "").trim();
  const events: ParsedCheckIn[] = [],
    problems: CheckInCsvProblem[] = [];
  const seen = new Map<string, number>();
  rows.slice(1).forEach((row, offset) => {
    const line = offset + 2;
    if (row.length !== header.length) {
      problems.push({ code: "columns", line });
      return;
    }
    const sourceEventId = at(row, "source_event_id"),
      sourceWorkerId = at(row, "source_worker_id");
    if (!sourceEventId || !sourceWorkerId) {
      problems.push({ code: "blank", line });
      return;
    }
    const kind = at(row, "kind").toLowerCase();
    if (!(CHECK_IN_KINDS as readonly string[]).includes(kind)) {
      problems.push({ code: "kind", line });
      return;
    }
    const time = at(row, "occurred_at");
    const instant = OFFSET_INSTANT.test(time) ? new Date(time.replace(" ", "T")) : null;
    if (!instant || Number.isNaN(instant.getTime())) {
      problems.push({ code: "time", line });
      return;
    }
    const versionText = header.includes("source_version") ? at(row, "source_version") : "";
    const sourceVersion = versionText === "" ? 1 : Number(versionText);
    if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1) {
      problems.push({ code: "version", line });
      return;
    }
    const key = `${sourceEventId}\u0000${sourceVersion}`;
    const firstLine = seen.get(key);
    if (firstLine !== undefined) {
      problems.push({ code: "duplicate", line, firstLine });
      return;
    }
    seen.set(key, line);
    events.push({
      sourceEventId,
      sourceWorkerId,
      sourceVersion,
      kind: kind as ParsedCheckIn["kind"],
      occurredAt: instant.toISOString(),
      supersedesId: null,
      sourcePayload: Object.fromEntries(header.map((column, index) => [column, row[index] ?? ""])),
    });
  });
  return { events, problems };
}
