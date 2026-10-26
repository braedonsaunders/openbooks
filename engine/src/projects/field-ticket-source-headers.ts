import { createHash } from "node:crypto";
import { isIsoCalendarDate } from "../platform/civil-date.ts";

/**
 * Connector-neutral source Field Ticket header contract.
 *
 * This is the one parser and row fingerprint shared by the governed source
 * importer, the source-identity certification service, and their command
 * lines. A ticket number alone never identifies a source ticket: identity
 * is the source system plus the external id carried by each row.
 *
 * The TSV shape is the original tab-separated header export. A missing
 * SuperintendentID column and an explicit NULL superintendent are different
 * source facts and stay different here and in the row fingerprint.
 */

export interface FieldTicketSourceHeaderRow {
  sourceId: string;
  number: string;
  jobRef: string;
  empRef: string;
  customerRef: string;
  begin: string;
  end: string;
  billed: boolean;
  final: boolean;
  approval: string;
  foremanRef: string | null;
  /** Undefined means the source export omitted this column entirely. */
  superintendentRef?: string | null;
  po: string | null;
  description: string | null;
}

export class FieldTicketSourceHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldTicketSourceHeaderError";
  }
}

/**
 * Parse the tab-separated source header export. Rows must carry the
 * actual Yes/No billed and final facts: an unknown flag refuses instead
 * of becoming a manufactured false. Other blank source facts (a job an
 * unrelated source ticket never named, for example) are retained as the
 * blank facts they are; only a selected row is judged on them.
 */
export function parseFieldTicketSourceHeaderTsv(text: string): FieldTicketSourceHeaderRow[] {
  const sourceRef = (value: string | undefined): string | null => {
    const normalized = value?.trim();
    return !normalized || normalized.toUpperCase() === "NULL" ? null : normalized;
  };
  for (const line of text.split("\n")) {
    const columns = line.split("\t");
    if (!/^\d+$/.test(columns[0]!)) continue;
    if (columns.length !== 13 && columns.length !== 14) {
      throw new FieldTicketSourceHeaderError(
        `source ticket ${columns[0]} has ${columns.length} columns in the source export; retain the exact 13- or 14-column source export`,
      );
    }
    if (!["Yes", "No"].includes(columns[7]!) || !["Yes", "No"].includes(columns[8]!)) {
      throw new FieldTicketSourceHeaderError(
        `source ticket ${columns[0]} has a malformed billed or final flag in the source export; retain the exact source export`,
      );
    }
  }
  return text
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(
      (columns) => (columns.length === 13 || columns.length === 14) && /^\d+$/.test(columns[0]!),
    )
    .map((columns) => ({
      sourceId: columns[0]!,
      number: columns[1]!,
      jobRef: columns[2]!,
      empRef: columns[3]!,
      customerRef: sourceRef(columns[4]) ?? "",
      begin: columns[5]!,
      end: columns[6]!,
      billed: columns[7] === "Yes",
      final: columns[8] === "Yes",
      approval: columns[9]!,
      foremanRef: sourceRef(columns[10]),
      // The original connector-neutral export has 13 columns. New exports
      // carry SuperintendentID after ForemanID; both formats remain readable.
      ...(columns.length >= 14 ? { superintendentRef: sourceRef(columns[11]) } : {}),
      po:
        (columns[columns.length >= 14 ? 12 : 11] ?? "").toUpperCase() === "NULL"
          ? null
          : (columns[columns.length >= 14 ? 12 : 11] ?? null),
      description: (columns[columns.length >= 14 ? 13 : 12] ?? "").trim() || null,
    }));
}

const JSON_ROW_KEYS = new Set([
  "sourceId",
  "number",
  "jobRef",
  "empRef",
  "customerRef",
  "begin",
  "end",
  "billed",
  "final",
  "approval",
  "foremanRef",
  "superintendentRef",
  "po",
  "description",
]);

/**
 * Parse a JSON source-header file. The JSON shape is the canonical
 * FieldTicketSourceHeaderRow contract itself — exact keys and exact types,
 * with a missing superintendentRef distinct from an explicit null — so a
 * malformed retained file refuses instead of manufacturing reviewed
 * reference, approval or billed facts.
 */
function parseFieldTicketSourceHeaderJson(text: string): FieldTicketSourceHeaderRow[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FieldTicketSourceHeaderError(
      "source file is not valid JSON; retain the exact source export and certify against its pinned version",
    );
  }
  if (!Array.isArray(value)) {
    throw new FieldTicketSourceHeaderError(
      "source JSON file must contain an array of source ticket header rows",
    );
  }
  return value.map((raw, index) => {
    const label = `source row ${index + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new FieldTicketSourceHeaderError(`${label} must be an object`);
    }
    const row = raw as Record<string, unknown>;
    for (const key of Object.keys(row)) {
      if (!JSON_ROW_KEYS.has(key)) {
        throw new FieldTicketSourceHeaderError(
          `${label} carries unsupported field ${key}; retain the canonical source header export`,
        );
      }
    }
    const textField = (key: string): string => {
      const field = row[key];
      if (typeof field !== "string" || !field.trim()) {
        throw new FieldTicketSourceHeaderError(`${label} has no exact ${key}`);
      }
      return field;
    };
    // A blank job, number or approval is retained as the blank source
    // fact it is; a certification judges it only on its selected row.
    const blankableTextField = (key: string): string => {
      const field = row[key];
      if (typeof field !== "string") {
        throw new FieldTicketSourceHeaderError(
          `${label} has a malformed ${key}; retain the exact source export`,
        );
      }
      return field;
    };
    const refField = (key: string): string | null => {
      const field = row[key];
      if (field === null) return null;
      if (typeof field !== "string") {
        throw new FieldTicketSourceHeaderError(
          `${label} has a malformed ${key} reference; retain the exact source export`,
        );
      }
      return field;
    };
    const flagField = (key: string): boolean => {
      const field = row[key];
      if (typeof field !== "boolean") {
        throw new FieldTicketSourceHeaderError(
          `${label} has a malformed ${key} flag; retain the exact source export`,
        );
      }
      return field;
    };
    if (typeof row.customerRef !== "string") {
      throw new FieldTicketSourceHeaderError(
        `${label} has a malformed customerRef reference; retain the exact source export`,
      );
    }
    const superintendentPresent = "superintendentRef" in row;
    return {
      sourceId: textField("sourceId"),
      number: blankableTextField("number"),
      jobRef: blankableTextField("jobRef"),
      empRef: textField("empRef"),
      customerRef: row.customerRef,
      begin: textField("begin"),
      end: textField("end"),
      billed: flagField("billed"),
      final: flagField("final"),
      approval: blankableTextField("approval"),
      foremanRef: refField("foremanRef"),
      ...(superintendentPresent ? { superintendentRef: refField("superintendentRef") } : {}),
      po: refField("po"),
      description: refField("description"),
    };
  });
}

/**
 * Parse the exact retained source-header bytes: the tab-separated export,
 * or a JSON array of header objects. Every row's identity and work period
 * is validated, so a caller certifies against a well-formed source row.
 */
export function parseFieldTicketSourceHeaders(bytes: Uint8Array): FieldTicketSourceHeaderRow[] {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FieldTicketSourceHeaderError(
      "source file is not valid UTF-8; retain the exact source export without repairing its bytes",
    );
  }
  const text = decoded.replace(/^\uFEFF/, "");
  const isJson = text.trimStart().startsWith("[") || text.trimStart().startsWith("{");
  const rows = isJson
    ? parseFieldTicketSourceHeaderJson(text.trimStart())
    : parseFieldTicketSourceHeaderTsv(text);
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.sourceId.trim() || seen.has(row.sourceId)) {
      throw new FieldTicketSourceHeaderError(
        "source file ticket identities must be nonempty and appear once; retain an exact, unduplicated source export",
      );
    }
    seen.add(row.sourceId);
    if (!isIsoCalendarDate(row.begin) || !isIsoCalendarDate(row.end) || row.end < row.begin) {
      throw new FieldTicketSourceHeaderError(
        `source ticket ${row.sourceId} has an invalid work period in the retained source file`,
      );
    }
  }
  return rows;
}

/** Exactly one parsed row may carry a certified source identity. */
export function findFieldTicketSourceHeaderRow(
  rows: readonly FieldTicketSourceHeaderRow[],
  sourceTicketId: string,
): FieldTicketSourceHeaderRow {
  const matches = rows.filter((row) => row.sourceId === sourceTicketId);
  if (matches.length === 0) {
    throw new FieldTicketSourceHeaderError(
      `source ticket ${sourceTicketId} is not a row of the pinned retained source file; retain the exact export that contains it and certify against that version`,
    );
  }
  if (matches.length > 1) {
    throw new FieldTicketSourceHeaderError(
      `source ticket ${sourceTicketId} appears more than once in the retained source file`,
    );
  }
  const row = matches[0]!;
  if (!row.number.trim() || !row.jobRef.trim() || !row.approval.trim()) {
    throw new FieldTicketSourceHeaderError(
      `source ticket ${sourceTicketId} has a missing number, job or approval fact in the retained source file; a certification cannot manufacture its reviewed facts`,
    );
  }
  return row;
}

/** Fingerprint of one parsed source row, from its exact source facts. */
export function fieldTicketSourceHeaderRowSha256(row: FieldTicketSourceHeaderRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceId: row.sourceId,
        number: row.number,
        jobRef: row.jobRef,
        empRef: row.empRef,
        customerRef: row.customerRef,
        begin: row.begin,
        end: row.end,
        billed: row.billed,
        final: row.final,
        approval: row.approval,
        foremanRef: row.foremanRef,
        superintendentRef: row.superintendentRef,
        po: row.po,
        description: row.description,
      }),
    )
    .digest("hex");
}
