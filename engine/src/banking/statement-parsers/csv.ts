/** CSV statement parsing. Split from banking.ts (ARCH-FILE-SPLIT; pure moves only). */
import { BankingError, type ParsedStatementLine, type StatementSourceContent, type CsvMapping, type SkippedStatementRow } from "../banking-core"
import { decodeStatementSourceText } from "../statement-encoding"
import { assertRealDate, normalizeAmount } from "./shared"
import { fromUnits, toUnits } from "../../money/money.ts"


// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/** RFC-4180 tokenizer: quoted fields, "" escapes, commas/newlines in quotes. */
export function parseCsvRows(source: StatementSourceContent): string[][] {
  const text = decodeStatementSourceText(source, "csv");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      sawAny = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
      sawAny = true;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  if (!sawAny || rows.length === 0) throw new BankingError("CSV is empty");
  return rows;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse a CSV cell date. Accepts ISO (YYYY-MM-DD, YYYY/MM/DD), slash/dash
 * numeric dates (disambiguated by >12 day part, otherwise assumed MM/DD/YYYY),
 * and month-name forms ("12 Jan 2026", "Jan 12, 2026"). Returns null when the
 * cell is not a date (used for header detection); import errors on null.
 */
export function parseCsvDate(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return safeDate(m[1]!, m[2]!, m[3]!);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) {
    // first part >12 ⇒ it is the day (DD/MM/YYYY); otherwise MM/DD/YYYY
    // (documented import assumption for ambiguous dates).
    return Number(m[1]) > 12
      ? safeDate(m[3]!, m[2]!, m[1]!)
      : safeDate(m[3]!, m[1]!, m[2]!);
  }
  m = s.match(/^(\d{1,2})[ -]([A-Za-z]{3,})[ -,]+(\d{4})$/);
  if (m) {
    const month = MONTHS[m[2]!.slice(0, 3).toLowerCase()];
    return month ? safeDate(m[3]!, String(month), m[1]!) : null;
  }
  m = s.match(/^([A-Za-z]{3,})[ .]+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const month = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
    return month ? safeDate(m[3]!, String(month), m[2]!) : null;
  }
  return null;
}

function safeDate(y: string, mo: string, d: string): string | null {
  try {
    return assertRealDate(y, mo.padStart(2, "0"), d.padStart(2, "0"), "date");
  } catch {
    return null;
  }
}

const CSV_MAPPING_FIELDS = [
  "date",
  "amount",
  "description",
  "counterpartyRef",
  "bankTransactionId",
  "debitAmount",
] as const satisfies readonly (keyof CsvMapping)[];

/** Validate and copy only mapping fields that can affect CSV normalization. */
export function canonicalCsvMapping(mapping: CsvMapping): CsvMapping {
  const canonical = {} as CsvMapping;
  for (const field of CSV_MAPPING_FIELDS) {
    const index = mapping[field];
    if (index === undefined) continue;
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new BankingError(`CSV mapping ${field} must be a non-negative integer`);
    }
    canonical[field] = index;
  }
  return canonical;
}

/** A mapped cell holding a parseable amount (numericity, not mere text). */
function csvCellParsesAsAmount(cell: string | undefined, rowNo: number): boolean {
  const text = (cell ?? "").trim();
  if (!text) return false;
  try {
    normalizeAmount(text, `CSV row ${rowNo}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * A row carries a parseable amount plus a description: it reads as a
 * transaction, so an unparseable date refuses the import rather than
 * silently dropping the row. Either money column parsing counts — even
 * both at once (the data rule refuses that shape by name). Mere TEXT in
 * the money columns is a header ("Credit","Debit"), never money: the test
 * is parsing, not non-emptiness.
 */
function csvRowLooksLikeTransaction(cols: string[], mapping: CsvMapping, rowNo: number): boolean {
  const description = (cols[mapping.description] ?? "").trim();
  if (!description) return false;
  if (mapping.debitAmount !== undefined) {
    return (
      csvCellParsesAsAmount(cols[mapping.amount], rowNo) ||
      csvCellParsesAsAmount(cols[mapping.debitAmount], rowNo)
    );
  }
  return csvCellParsesAsAmount(cols[mapping.amount], rowNo);
}

/** A mapped cell holding a non-empty, non-numeric label (never a number). */
function csvCellIsLabel(cell: string | undefined): boolean {
  const text = (cell ?? "").trim();
  if (!text) return false;
  try {
    normalizeAmount(text, "CSV header probe");
    return false;
  } catch {
    return true;
  }
}

/**
 * A leading row whose mapped amount column holds a label (not a number)
 * beside a populated description reads as the file's column-header row —
 * "Date,Amount,Description" in any language, with no word list: numericity
 * is the test, so every locale's labels classify alike. Consumed silently:
 * labels carry no transaction, and reporting them would warn on every
 * import. A row with a NUMERIC amount is never a header — it is either a
 * transaction (refused above) or a disclaimer (reported below).
 */
function csvRowLooksLikeHeader(cols: string[], mapping: CsvMapping): boolean {
  if (!(cols[mapping.description] ?? "").trim()) return false;
  if (mapping.debitAmount !== undefined) {
    return (
      csvCellIsLabel(cols[mapping.amount]) || csvCellIsLabel(cols[mapping.debitAmount])
    );
  }
  return csvCellIsLabel(cols[mapping.amount]);
}

/**
 * Parse CSV text into normalized statement lines using a column mapping.
 * Each leading row whose mapped date column does not parse is classified
 * from the mapping alone: a transaction-looking row (parseable amount with
 * a description) refuses the import by row number — dropping it would lose
 * real money, and guessing is not an option; a column-header row (labels,
 * never numbers) is consumed silently; any other metadata/disclaimer row
 * is reported in `skipped` by code, never silently discarded. The first
 * row with a parseable date starts the data; a later unparseable date
 * still refuses, so a mid-file metadata row cannot slip past.
 */
export function parseCsv(
  source: StatementSourceContent,
  mapping: CsvMapping,
): { lines: ParsedStatementLine[]; skipped: SkippedStatementRow[] } {
  mapping = canonicalCsvMapping(mapping);
  const rows = parseCsvRows(source);
  let start = 0;
  const skipped: SkippedStatementRow[] = [];
  for (; start < rows.length; start++) {
    const rowNo = start + 1;
    const rawDate = (rows[start]![mapping.date] ?? "").trim();
    if (parseCsvDate(rawDate) !== null) break;
    if (csvRowLooksLikeTransaction(rows[start]!, mapping, rowNo)) {
      throw new BankingError(
        `CSV row ${rowNo} looks like a transaction (a parseable amount with a description) but its date "${rawDate}" does not parse — remove the row if it is a summary or metadata row, otherwise fix the date`,
      );
    }
    if (!csvRowLooksLikeHeader(rows[start]!, mapping)) {
      skipped.push({ line: rowNo, code: "csv_metadata_row", dateCell: rawDate });
    }
  }
  const dataRows = rows.slice(start);
  if (dataRows.length === 0) throw new BankingError("CSV has a header but no data rows");

  const lines = dataRows.map((cols, i) => {
    const rowNo = start + i + 1;
    const rawDate = (cols[mapping.date] ?? "").trim();
    const postedOn = parseCsvDate(rawDate);
    if (!postedOn) throw new BankingError(`CSV row ${rowNo}: unparseable date "${rawDate}"`);

    const rawAmount = (cols[mapping.amount] ?? "").trim();
    let amount: string;
    if (mapping.debitAmount !== undefined) {
      const rawDebit = (cols[mapping.debitAmount] ?? "").trim();
      if (rawAmount && rawDebit) {
        throw new BankingError(`CSV row ${rowNo}: both credit and debit columns have values`);
      }
      if (!rawAmount && !rawDebit) {
        throw new BankingError(`CSV row ${rowNo}: no amount in credit or debit column`);
      }
      amount = rawAmount
        ? normalizeAmount(rawAmount, `CSV row ${rowNo}`)
        : fromUnits(-toUnits(normalizeAmount(rawDebit, `CSV row ${rowNo}`)));
    } else {
      if (!rawAmount) throw new BankingError(`CSV row ${rowNo}: empty amount`);
      amount = normalizeAmount(rawAmount, `CSV row ${rowNo}`);
    }

    const description = (cols[mapping.description] ?? "").trim() || null;
    const counterpartyRef =
      mapping.counterpartyRef !== undefined
        ? (cols[mapping.counterpartyRef] ?? "").trim() || null
        : null;
    const bankTransactionId =
      mapping.bankTransactionId !== undefined
        ? (cols[mapping.bankTransactionId] ?? "").trim() || null
        : null;
    return { postedOn, amount, description, counterpartyRef, bankTransactionId };
  });
  return { lines, skipped };
}
