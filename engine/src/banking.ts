import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, inDbTransaction, schema, type SqlExecutor, withOrgTransaction } from "./db.ts";
import { fromUnits, isZero, sum, toUnits } from "./money.ts";

/**
 * Banking: statement parsing (OFX / CSV) → import with dedupe → auto/manual
 * matching against posted journal lines → reconciliation sign-off.
 *
 * Statement lines are the immutable imported truth (bank's perspective,
 * signed). Matching connects them to unreconciled journal lines on the same
 * reconcilable account; sign-off stamps `reconciled_at`/`reconciliation_id`
 * on the matched journal lines (a metadata-only update the kernel's
 * `jl_guard` trigger explicitly allows on posted lines).
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Domain error → API 422. Message is safe to show to the user. */
export class BankingError extends Error {
  readonly name = "BankingError";
  readonly status = 422;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedStatementLine {
  /** ISO date (YYYY-MM-DD). */
  postedOn: string;
  /** Signed decimal string from the bank's perspective (+ deposit / − withdrawal). */
  amount: string;
  description: string | null;
  counterpartyRef?: string | null;
  /** Source-provided dedupe key (OFX FITID). Synthesized at import when absent. */
  bankTransactionId?: string | null;
}

export interface ParsedStatement {
  lines: ParsedStatementLine[];
  currency?: string;
  /** Balance-as-of date when the file carries one (OFX LEDGERBAL/DTASOF). */
  statementDate?: string;
  closingBalance?: string;
}

export type StatementSource = "ofx" | "csv" | "camt053" | "bai2" | "mt940" | "feed_api" | "manual";

/** Increment whenever statement-to-line normalization semantics change. */
export const BANK_STATEMENT_PARSER_VERSION = "2026.08.2";

export type StatementSourceContent = string | Uint8Array;
type StatementTextSource = Extract<StatementSource, "ofx" | "csv" | "camt053" | "bai2" | "mt940">;

/** Exact source and transformation evidence retained for later audit. */
export interface StatementSourceEvidence {
  content: StatementSourceContent;
  filename?: string | null;
  contentType?: string | null;
  parserVersion?: string | null;
  csvMapping?: CsvMapping | null;
}

const CTX = Symbol();
export interface BankingContext {
  orgId: string;
  userId: string;
  /**
   * Durable job marker persisted as `audit_log.request_id` on the rows an
   * engine-initiated write produces (e.g. `sftp-import:<scheduleId>` for a
   * scheduled SFTP statement pull — see sftpImportAuditSource). Engine callers
   * that have no background-job identity leave it unset, which persists null
   * exactly as before. It names the JOB, never a human actor: attribution of
   * people stays on `userId`.
   */
  requestId?: string | null;
  // prevents accidental structural-typing mixups with other {orgId,userId} bags
  [CTX]?: never;
}

/**
 * Explicit actor for engine-initiated financial writes that no signed-in human
 * performed — scheduled bank-feed pulls and other background jobs. Persistence
 * sites must carry this documented id so provenance stays queryable and is
 * never confused with a real operator; the zero UUID means "no actor at all"
 * and must never be persisted. It has no users row and must never be granted a
 * session, role, or credential.
 */
export const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000001";

/** The zero UUID means "no actor at all" and is never persisted; see {@link requireActorId}. */
const NO_ACTOR_SENTINEL_ID = "00000000-0000-0000-0000-000000000000";

/**
 * The zero UUID means "no actor at all" — an absence, not an identity. It must
 * never name who performed a financial write, so the import boundary rejects
 * it (and blank/whitespace actors) outright instead of silently persisting it
 * where an audit query would read it as a person.
 */
function requireActorId(userId: string): void {
  const trimmed = userId?.trim() ?? "";
  if (!trimmed || trimmed === NO_ACTOR_SENTINEL_ID) {
    throw new BankingError(
      "A bank statement import requires a real actor: the authenticated operator or SYSTEM_ACTOR_ID — never a no-actor placeholder",
    );
  }
}

// ---------------------------------------------------------------------------
// Source decoding
// ---------------------------------------------------------------------------

const STATEMENT_ENCODING_ALIASES: Readonly<Record<string, string>> = {
  "1252": "windows-1252",
  "cp1252": "windows-1252",
  "windows-1252": "windows-1252",
  "iso-8859-1": "windows-1252",
  "iso8859-1": "windows-1252",
  "latin1": "windows-1252",
  "65001": "utf-8",
  "utf-8": "utf-8",
  "utf8": "utf-8",
  "1200": "utf-16le",
  "unicode": "utf-16",
  "utf-16": "utf-16",
  "utf-16le": "utf-16le",
  "utf16": "utf-16",
  "utf16le": "utf-16le",
  "1201": "utf-16be",
  "utf-16be": "utf-16be",
  "utf16be": "utf-16be",
  "ascii": "ascii",
  "none": "",
  "usascii": "ascii",
  "us-ascii": "ascii",
};

function normalizeStatementEncoding(label: string): string | null {
  const normalized = label.trim().toLowerCase();
  const alias = Object.hasOwn(STATEMENT_ENCODING_ALIASES, normalized)
    ? STATEMENT_ENCODING_ALIASES[normalized]!
    : normalized;
  if (!alias) return null;
  if (alias === "ascii" || alias === "utf-16") return alias;
  try {
    return new TextDecoder(alias).encoding;
  } catch {
    throw new BankingError(`Statement source declares unsupported encoding "${label}"`);
  }
}

/** Read an encoding declaration only where the selected format permits one. */
function statementEncodingLabel(text: string, source?: StatementTextSource): string | null {
  if (source !== "ofx" && source !== "camt053") return null;
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const xml = withoutBom.match(
    /^[\t\r\n ]*<\?xml\b[^>]*\bencoding\s*=\s*["']\s*([^\s"']+)/i,
  )?.[1];
  if (xml) return xml;
  if (source !== "ofx") return null;

  const ofxStart = withoutBom.search(/<OFX(?:\s|>)/i);
  if (ofxStart < 0 || ofxStart > 4096) return null;
  const header = withoutBom.slice(0, ofxStart);
  if (!/^[\t\r\n ]*OFXHEADER\s*:/i.test(header)) return null;
  const charset = header.match(/(?:^|[\r\n])[\t ]*CHARSET\s*:\s*([^\s\r\n<]+)/i)?.[1];
  if (charset && charset.trim().toLowerCase() !== "none") return charset;
  return header.match(/(?:^|[\r\n])[\t ]*ENCODING\s*:\s*([^\s\r\n<]+)/i)?.[1] ?? null;
}

function rawStatementEncodingLabel(bytes: Uint8Array, source?: StatementTextSource): string | null {
  const offset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const prefix = Buffer.from(bytes.subarray(offset, offset + 4096)).toString("latin1");
  return statementEncodingLabel(prefix, source);
}

/** Conservative recognition for BOM-less UTF-16 text with an ASCII-heavy prefix. */
function bomlessUtf16Encoding(bytes: Uint8Array): "utf-16le" | "utf-16be" | null {
  if (bytes.length < 8 || bytes.length % 2 !== 0) return null;
  const pairs = Math.min(bytes.length / 2, 512);
  let evenNuls = 0;
  let oddNuls = 0;
  for (let pair = 0; pair < pairs; pair += 1) {
    if (bytes[pair * 2] === 0) evenNuls += 1;
    if (bytes[pair * 2 + 1] === 0) oddNuls += 1;
  }
  if (oddNuls / pairs >= 0.3 && evenNuls / pairs <= 0.05) return "utf-16le";
  if (evenNuls / pairs >= 0.3 && oddNuls / pairs <= 0.05) return "utf-16be";
  return null;
}

function decodeStatementBytes(bytes: Uint8Array, encoding: string): string {
  if (encoding === "ascii") {
    if (bytes.some((byte) => byte > 0x7f)) {
      throw new BankingError("Statement source declares US-ASCII but contains non-ASCII bytes");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  if (encoding === "utf-16") {
    throw new BankingError("UTF-16 bank statements require a BOM or detectable byte order");
  }
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding, { fatal: true });
  } catch {
    throw new BankingError(`Statement source declares unsupported encoding "${encoding}"`);
  }
  try {
    return decoder.decode(bytes);
  } catch {
    throw new BankingError(`Statement source is not valid ${encoding.toUpperCase()} text`);
  }
}

function statementEncodingMatches(actual: string, declared: string): boolean {
  if (declared === "utf-16") return actual === "utf-16le" || actual === "utf-16be";
  return actual === declared;
}

function assertStatementEncoding(
  text: string,
  source: StatementTextSource | undefined,
  actual: string,
  rawLabel: string | null,
): void {
  const decodedLabel = statementEncodingLabel(text, source);
  if (rawLabel && !decodedLabel) {
    throw new BankingError(`Statement source encoding declaration "${rawLabel}" does not match its bytes`);
  }
  const label = decodedLabel ?? rawLabel;
  if (!label) return;
  const declared = normalizeStatementEncoding(label);
  if (declared && !statementEncodingMatches(actual, declared)) {
    throw new BankingError(
      `Statement source encoding declaration "${label}" conflicts with ${actual.toUpperCase()} source bytes`,
    );
  }
}

function validateStatementText(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(withoutBom)) {
    throw new BankingError("Statement source contains unsupported control characters");
  }
  return withoutBom;
}

/**
 * Decode exact bank-statement bytes without replacement characters. BOMs and
 * explicit XML/OFX declarations are authoritative; otherwise valid UTF-8 wins
 * and legacy single-byte exports fall back deterministically to Windows-1252.
 */
export function decodeStatementSourceText(
  content: StatementSourceContent,
  source?: StatementTextSource,
): string {
  if (typeof content === "string") return validateStatementText(content);
  const bytes = content;
  if (bytes.length === 0) return "";

  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00)
    || (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff)
  ) {
    throw new BankingError("UTF-32 bank statements are not supported");
  }

  const rawLabel = rawStatementEncodingLabel(bytes, source);
  let encoding =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? "utf-8"
      : bytes[0] === 0xff && bytes[1] === 0xfe
        ? "utf-16le"
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? "utf-16be"
          : bomlessUtf16Encoding(bytes);
  if (!encoding && rawLabel) encoding = normalizeStatementEncoding(rawLabel);

  let text: string;
  if (encoding) {
    text = decodeStatementBytes(bytes, encoding);
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      encoding = "utf-8";
    } catch {
      encoding = "windows-1252";
      text = decodeStatementBytes(bytes, encoding);
    }
  }
  assertStatementEncoding(text, source, encoding, rawLabel);
  return validateStatementText(text);
}

// ---------------------------------------------------------------------------
// OFX parsing (1.x SGML and 2.x XML)
// ---------------------------------------------------------------------------

function decodeOfxEntities(v: string): string {
  return v
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

/** First leaf value for `<TAG>value` (SGML, unclosed) or `<TAG>value</TAG>`. */
function ofxValue(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}>\\s*([^<\\r\\n]*)`, "i"));
  const v = m?.[1]?.trim();
  return v ? decodeOfxEntities(v) : undefined;
}

/** OFX DTPOSTED/DTASOF: YYYYMMDD[HHMMSS[.mmm]][ [gmt offset] ] → YYYY-MM-DD. */
function ofxDate(raw: string): string {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) throw new BankingError(`OFX: unparseable date "${raw}"`);
  return assertRealDate(m[1]!, m[2]!, m[3]!, `OFX date "${raw}"`);
}

function assertRealDate(y: string, mo: string, d: string, label: string): string {
  const year = Number(y), month = Number(mo), day = Number(d);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    throw new BankingError(`${label} is not a real calendar date`);
  }
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Normalize a raw amount ("1,234.56", "(45.00)", "45.00-", "1.234,56") to a signed decimal string. */
function normalizeAmount(raw: string, label: string): string {
  let s = raw.trim().replace(/[$€£\s]/g, "");
  if (!s) throw new BankingError(`${label}: empty amount`);
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith("-")) {
    negative = true;
    s = s.slice(0, -1);
  }
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");
  if (hasDot && hasComma) {
    // rightmost separator is the decimal point
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    // "123,45" → decimal comma; "1,234" / "1,234,567" → thousands
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(/,/g, ".");
  }
  let units: bigint;
  try {
    units = toUnits(s);
  } catch {
    throw new BankingError(`${label}: unparseable amount "${raw}"`);
  }
  return fromUnits(negative ? -units : units);
}

/**
 * Parse an OFX bank statement (v1 SGML headers or v2 XML) into normalized
 * lines. Reads `<STMTTRN>` blocks (DTPOSTED, TRNAMT, NAME/MEMO, FITID,
 * REFNUM/CHECKNUM) plus statement-level CURDEF and LEDGERBAL.
 */
export function parseOfx(source: StatementSourceContent): ParsedStatement {
  const text = decodeStatementSourceText(source, "ofx");
  const body = text.replace(/\r\n/g, "\n");
  const chunks = body.split(/<STMTTRN>/i).slice(1);
  if (chunks.length === 0) {
    throw new BankingError("No transactions found — expected OFX <STMTTRN> blocks");
  }
  const lines: ParsedStatementLine[] = chunks.map((chunk, i) => {
    const block = chunk.split(/<\/STMTTRN>/i)[0]!;
    const dt = ofxValue(block, "DTPOSTED");
    const amt = ofxValue(block, "TRNAMT");
    if (!dt) throw new BankingError(`OFX transaction ${i + 1}: missing DTPOSTED`);
    if (!amt) throw new BankingError(`OFX transaction ${i + 1}: missing TRNAMT`);
    const name = ofxValue(block, "NAME");
    const memo = ofxValue(block, "MEMO");
    const description =
      name && memo && memo !== name ? `${name} — ${memo}` : (name ?? memo ?? null);
    return {
      postedOn: ofxDate(dt),
      amount: normalizeAmount(amt, `OFX transaction ${i + 1}`),
      description,
      counterpartyRef: ofxValue(block, "REFNUM") ?? ofxValue(block, "CHECKNUM") ?? null,
      bankTransactionId: ofxValue(block, "FITID") ?? null,
    };
  });

  const parsed: ParsedStatement = { lines };
  const curdef = ofxValue(body, "CURDEF");
  if (curdef && /^[A-Za-z]{3}$/.test(curdef)) parsed.currency = curdef.toUpperCase();
  const ledger = body.match(/<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|$)/i)?.[1];
  if (ledger) {
    const bal = ofxValue(ledger, "BALAMT");
    const asOf = ofxValue(ledger, "DTASOF");
    if (bal) parsed.closingBalance = normalizeAmount(bal, "OFX ledger balance");
    if (asOf) parsed.statementDate = ofxDate(asOf);
  }
  return parsed;
}

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

export interface CsvMapping {
  /** Zero-based column indexes into each CSV row. */
  date: number;
  amount: number;
  description: number;
  counterpartyRef?: number;
  bankTransactionId?: number;
  /**
   * Some bank exports split money into Debit and Credit columns; when set,
   * `amount` is the credit (money-in) column and this is the money-out
   * column, negated on import.
   */
  debitAmount?: number;
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
function canonicalCsvMapping(mapping: CsvMapping): CsvMapping {
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

/**
 * Parse CSV text into normalized statement lines using a column mapping.
 * The header row is skipped automatically when the mapped date column of the
 * first row does not parse as a date.
 */
export function parseCsv(source: StatementSourceContent, mapping: CsvMapping): ParsedStatementLine[] {
  mapping = canonicalCsvMapping(mapping);
  const rows = parseCsvRows(source);
  let start = 0;
  if (rows[0] && parseCsvDate(rows[0][mapping.date] ?? "") === null) start = 1;
  const dataRows = rows.slice(start);
  if (dataRows.length === 0) throw new BankingError("CSV has a header but no data rows");

  return dataRows.map((cols, i) => {
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
}

// ---------------------------------------------------------------------------
// International statement formats: CAMT.053 (ISO 20022), BAI2, MT940
// ---------------------------------------------------------------------------

function xmlTag(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decodeOfxEntities(m[1]!.trim()) : undefined;
}
function xmlTags(block: string, tag: string): string[] {
  return [...block.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))].map((m) => m[1]!);
}

/**
 * Parse an ISO 20022 CAMT.053 (Bank-to-Customer Statement) into normalized
 * lines. Reads `<Ntry>` entries — `<Amt Ccy>`, `<CdtDbtInd>` (CRDT/DBIT),
 * booking date, and `<AddtlNtryInf>`/reference text — plus the closing booked
 * balance (`<Bal>` with type code CLBD). Amounts sign from the CdtDbtInd.
 */
export function parseCamt053(source: StatementSourceContent): ParsedStatement {
  const text = decodeStatementSourceText(source, "camt053");
  const stmt = xmlTag(text, "Stmt") ?? text;
  const currency = xmlTag(stmt, "Ccy");
  const lines: ParsedStatementLine[] = [];
  let lineNo = 0;
  for (const ntry of xmlTags(stmt, "Ntry")) {
    const amtRaw = xmlTag(ntry, "Amt");
    if (!amtRaw) continue;
    const ind = (xmlTag(ntry, "CdtDbtInd") ?? "CRDT").toUpperCase();
    const signed = normalizeAmount((ind === "DBIT" ? "-" : "") + amtRaw, "CAMT.053 amount");
    const bookg = xmlTag(ntry, "BookgDt");
    const dt = bookg ? (xmlTag(bookg, "Dt") ?? xmlTag(bookg, "DtTm")) : undefined;
    const iso = dt?.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!iso) throw new BankingError(`CAMT.053: entry missing a booking date`);
    const txDtls = xmlTag(ntry, "TxDtls") ?? ntry;
    const description =
      xmlTag(ntry, "AddtlNtryInf") ??
      xmlTag(txDtls, "AddtlTxInf") ??
      xmlTag(txDtls, "Ustrd") ??
      xmlTag(txDtls, "Nm") ??
      null;
    const ref =
      xmlTag(txDtls, "EndToEndId") ?? xmlTag(txDtls, "TxId") ?? xmlTag(txDtls, "AcctSvcrRef") ?? null;
    lines.push({
      postedOn: assertRealDate(iso[1]!, iso[2]!, iso[3]!, `CAMT.053 date "${dt}"`),
      amount: signed,
      description,
      counterpartyRef: ref,
      bankTransactionId: ref,
    });
    lineNo++;
  }
  if (lineNo === 0) throw new BankingError("CAMT.053: no <Ntry> entries found");
  // closing booked balance (CLBD)
  let closingBalance: string | undefined;
  let statementDate: string | undefined;
  for (const bal of xmlTags(stmt, "Bal")) {
    const cd = xmlTag(bal, "Cd");
    if (cd && /CLBD|CLAV/i.test(cd)) {
      const amt = xmlTag(bal, "Amt");
      const ind = (xmlTag(bal, "CdtDbtInd") ?? "CRDT").toUpperCase();
      if (amt) closingBalance = normalizeAmount((ind === "DBIT" ? "-" : "") + amt, "CAMT.053 balance");
      const bd = xmlTag(bal, "Dt");
      const m = bd?.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) statementDate = assertRealDate(m[1]!, m[2]!, m[3]!, "CAMT.053 balance date");
    }
  }
  return { lines, currency, statementDate, closingBalance };
}

/**
 * Parse a BAI2 (Cash Management Balance Reporting) file. Type-16 detail records
 * carry a BAI type code, amount (in cents, no decimal), and reference/text.
 * Type codes < 400 are credits, ≥ 400 debits. The statement date comes from the
 * type-02 group header (field 4, YYMMDD) and closing balance from the type-03
 * account record's 015 status code.
 */
export function parseBai2(source: StatementSourceContent): ParsedStatement {
  const text = decodeStatementSourceText(source, "bai2");
  // Join 88-continuation records onto their parent, split on record delimiter.
  const raw = text.replace(/\r/g, "");
  const records: string[] = [];
  for (const seg of raw.split("/\n")) {
    for (const ln of seg.split("\n")) {
      const t = ln.replace(/\/\s*$/, "").trim();
      if (!t) continue;
      if (t.startsWith("88,") && records.length) records[records.length - 1] += "," + t.slice(3);
      else records.push(t);
    }
  }
  const lines: ParsedStatementLine[] = [];
  let statementDate: string | undefined;
  let currency: string | undefined;
  let closingBalance: string | undefined;
  let lineNo = 0;
  for (const rec of records) {
    const f = rec.split(",");
    if (f[0] === "02") {
      const d = f[4]; // YYMMDD
      const m = d?.match(/^(\d{2})(\d{2})(\d{2})$/);
      if (m) statementDate = assertRealDate("20" + m[1]!, m[2]!, m[3]!, `BAI2 date "${d}"`);
    } else if (f[0] === "03") {
      if (f[2]) currency = f[2];
      // status/summary type codes follow in groups of (code, amount, ...)
      for (let i = 3; i + 1 < f.length; i += 1) {
        if (f[i] === "015" && f[i + 1]) closingBalance = baiAmount(f[i + 1]!); // 015 = closing ledger
      }
    } else if (f[0] === "16") {
      const typeCode = Number(f[1]);
      const cents = f[2];
      if (!cents) continue;
      const magnitude = baiAmount(cents);
      const signed = typeCode >= 400 ? "-" + magnitude.replace(/^-/, "") : magnitude;
      const bankRef = f[4] || null;
      const custRef = f[5] || null;
      const textDesc = f.slice(6).join(",").trim() || null;
      if (!statementDate) {
        throw new BankingError("BAI2: type-16 transaction before a type-02 header date");
      }
      lines.push({
        postedOn: statementDate,
        amount: signed,
        description: textDesc,
        counterpartyRef: custRef ?? bankRef,
        bankTransactionId: bankRef ?? custRef,
      });
      lineNo++;
    }
  }
  if (lineNo === 0) throw new BankingError("BAI2: no type-16 transaction records found");
  return { lines, currency, statementDate, closingBalance };
}

/** BAI2 amounts are integer cents with no decimal point (e.g. "150000" = 1500.00). */
function baiAmount(cents: string): string {
  const neg = cents.startsWith("-");
  const digits = cents.replace(/[^0-9]/g, "");
  if (!digits) throw new BankingError(`BAI2: unparseable amount "${cents}"`);
  return fromUnits((neg ? -1n : 1n) * BigInt(digits) * 100n);
}

/**
 * Parse a SWIFT MT940 (Customer Statement) message. Reads :61: statement lines
 * (value date, D/C mark, amount) with their following :86: information line,
 * plus :25: account, :28C: statement number, and :62F: closing balance.
 */
export function parseMt940(source: StatementSourceContent): ParsedStatement {
  const text = decodeStatementSourceText(source, "mt940");
  const body = text.replace(/\r/g, "");
  // Split into tag blocks: a line starting with ":NN:" begins a new field.
  const fields: { tag: string; value: string }[] = [];
  for (const ln of body.split("\n")) {
    const m = ln.match(/^:(\d{2}[A-Z]?):(.*)$/);
    if (m) fields.push({ tag: m[1]!, value: m[2]! });
    else if (fields.length && ln.trim() && ln.trim() !== "-") fields[fields.length - 1]!.value += "\n" + ln;
  }
  const lines: ParsedStatementLine[] = [];
  let currency: string | undefined;
  let closingBalance: string | undefined;
  let statementDate: string | undefined;
  let pending: ParsedStatementLine | null = null;
  const pushPending = () => {
    if (pending) lines.push(pending);
    pending = null;
  };
  for (const { tag, value } of fields) {
    if (tag === "61") {
      pushPending();
      // YYMMDD [MMDD] {D|C|RD|RC} [funds] amount(,) type ...
      const m = value.match(/^(\d{6})(\d{4})?(R?[DC])([A-Z])?([\d.,]+)/);
      if (!m) throw new BankingError(`MT940: unparseable :61: line "${value.slice(0, 40)}"`);
      const dm = m[1]!.match(/^(\d{2})(\d{2})(\d{2})$/)!;
      const debit = /D/.test(m[3]!);
      const amount = normalizeAmount((debit ? "-" : "") + m[5], "MT940 amount");
      const rest = value.slice(m[0].length);
      const ref = rest.split("//")[0]?.replace(/^N[A-Z]{3}/, "").trim() || null;
      pending = {
        postedOn: assertRealDate("20" + dm[1]!, dm[2]!, dm[3]!, `MT940 date "${m[1]}"`),
        amount,
        description: null,
        counterpartyRef: ref,
        bankTransactionId: ref,
      };
    } else if (tag === "86" && pending) {
      pending.description = value.replace(/\n/g, " ").replace(/[?>]\d{2}/g, " ").replace(/\s+/g, " ").trim() || null;
    } else if (tag === "25") {
      const cm = value.match(/([A-Z]{3})\s*$/);
      if (cm) currency = cm[1];
    } else if (tag === "62F" || tag === "62M") {
      const m = value.match(/^([DC])(\d{6})([A-Z]{3})([\d.,]+)/);
      if (m) {
        closingBalance = normalizeAmount((m[1] === "D" ? "-" : "") + m[4], "MT940 closing balance");
        currency = currency ?? m[3];
        const dm = m[2]!.match(/^(\d{2})(\d{2})(\d{2})$/)!;
        statementDate = assertRealDate("20" + dm[1]!, dm[2]!, dm[3]!, "MT940 balance date");
      }
    }
  }
  pushPending();
  if (lines.length === 0) throw new BankingError("MT940: no :61: statement lines found");
  return { lines, currency, statementDate, closingBalance };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
type ReconcilableAccount = {
  id: string;
  name: string;
  number: string | null;
  currency: string;
};

async function loadReconcilableAccount(orgId: string, accountId: string): Promise<ReconcilableAccount> {
  const r = (await db.execute<ReconcilableAccount>(sql`
    select a.id, a.name, a.number, a.currency_restriction as currency
      from accounts a
     where a.id = ${accountId} and a.org_id = ${orgId}
       and a.reconcilable and a.is_active and not a.is_summary
  `));
  const account = r.rows[0];
  if (!account) throw new BankingError("Account not found or not reconcilable");
  if (!account.currency) {
    throw new BankingError(
      "Reconcilable accounts require an explicit currency before statement import or reconciliation",
    );
  }
  return account;
}

/**
 * Apply the safe automatic statement dedupe rules. An exact retry of source
 * bytes is the same import, while a non-empty ID supplied by the bank may
 * identify a transaction across different sources. Parsed line content is not
 * identity — two real transactions can share every visible field — so an
 * ID-less line from a different source is retained and remains ID-less.
 */
export function filterDuplicateStatementLines(
  lines: ParsedStatementLine[],
  existingTransactionIds: ReadonlySet<string>,
  exactSourceRetry = false,
): { lines: ParsedStatementLine[]; duplicates: number } {
  if (exactSourceRetry) return { lines: [], duplicates: lines.length };
  const batchSeen = new Set<string>();
  const fresh: ParsedStatementLine[] = [];
  let duplicates = 0;
  for (const line of lines) {
    const key = line.bankTransactionId;
    if (key && (existingTransactionIds.has(key) || batchSeen.has(key))) {
      duplicates += 1;
      continue;
    }
    if (key) batchSeen.add(key);
    fresh.push(line);
  }
  return { lines: fresh, duplicates };
}

export interface ImportResult {
  /** Null when every line was a duplicate (nothing was written). */
  statementId: string | null;
  /** Pointer to the append-only audit row containing the exact source bytes. */
  sourceEvidenceRef: string | null;
  imported: number;
  duplicates: number;
  /** The deduped lines (dry-run preview shows exactly what import would write). */
  lines: ParsedStatementLine[];
}

const MAX_STATEMENT_EVIDENCE_BYTES = 25 * 1024 * 1024;

/** Stable identity for exact statement source bytes (filename is metadata). */
export function statementSourceSha256(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  return createHash("sha256").update(bytes).digest("hex");
}

function defaultStatementContentType(source: StatementSource): string {
  if (source === "ofx") return "application/x-ofx";
  if (source === "csv") return "text/csv";
  if (source === "camt053") return "application/xml";
  if (source === "feed_api") return "application/json";
  return "text/plain";
}

function defaultStatementFilename(source: StatementSource, hash: string): string {
  const extension = source === "camt053" ? "xml" : source === "feed_api" ? "json" : source;
  return `bank-statement-${hash.slice(0, 16)}.${extension}`;
}

function sourceEvidence(
  opts: {
    source: StatementSource;
    sourceEvidence?: StatementSourceEvidence | null;
    statementDate?: string | null;
    openingBalance?: string | null;
    closingBalance?: string | null;
    currency?: string | null;
  },
  lines: ParsedStatementLine[],
): {
  auditId: string;
  ref: string;
  sha256: string;
  changes: Record<string, unknown>;
} {
  const supplied = opts.sourceEvidence;
  const bytes = supplied
    ? typeof supplied.content === "string"
      ? Buffer.from(supplied.content, "utf8")
      : Buffer.from(supplied.content)
    : Buffer.from(
        JSON.stringify({
          source: opts.source,
          statementDate: opts.statementDate ?? null,
          openingBalance: opts.openingBalance ?? null,
          closingBalance: opts.closingBalance ?? null,
          currency: opts.currency ?? null,
          lines,
        }),
        "utf8",
      );
  if (bytes.length === 0) {
    throw new BankingError("Statement source evidence is empty");
  }
  if (bytes.length > MAX_STATEMENT_EVIDENCE_BYTES) {
    throw new BankingError("Statement source evidence exceeds the 25 MB limit");
  }
  const sha256 = statementSourceSha256(bytes);
  const requestedContentType = supplied?.contentType?.trim().toLowerCase();
  const contentType =
    requestedContentType &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(requestedContentType)
      ? requestedContentType
      : defaultStatementContentType(opts.source);
  const requestedFilename = supplied?.filename
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^.*[\\/]/, "")
    .trim()
    .slice(0, 240);
  const filename = requestedFilename || defaultStatementFilename(opts.source, sha256);
  const requestedParserVersion = supplied?.parserVersion?.trim();
  if (supplied?.parserVersion != null && !requestedParserVersion) {
    throw new BankingError("Statement parser version evidence is empty");
  }
  if (requestedParserVersion && requestedParserVersion.length > 100) {
    throw new BankingError("Statement parser version evidence exceeds 100 characters");
  }
  const parserVersion = requestedParserVersion ?? BANK_STATEMENT_PARSER_VERSION;
  const csvMapping = supplied?.csvMapping
    ? canonicalCsvMapping(supplied.csvMapping)
    : null;
  if (opts.source === "csv" && !csvMapping) {
    throw new BankingError("CSV source evidence requires the column mapping used to parse it");
  }
  if (opts.source !== "csv" && csvMapping) {
    throw new BankingError("CSV mapping evidence is only valid for CSV statements");
  }
  const auditId = randomUUID();
  return {
    auditId,
    ref: `audit-log:${auditId}#sha256=${sha256}`,
    sha256,
    changes: {
      operation: "statement_import",
      source: opts.source,
      sourceEvidence: {
        encoding: "base64",
        content: bytes.toString("base64"),
        filename,
        contentType,
        byteLength: bytes.length,
        sha256,
        provenance: supplied ? "original_source" : "normalized_import_request",
        parserVersion,
        csvMapping,
      },
    },
  };
}

/**
 * Import normalized statement lines for a reconcilable account. Lines whose
 * source-provided `bankTransactionId` already exists on the account are
 * skipped. An exact retry of source bytes for the same account is skipped as
 * one import even when its lines have no transaction IDs. Different source
 * bytes without transaction IDs cannot be safely content-deduped, so their
 * lines are retained. With `dryRun` nothing is written — used for preview.
 * Committed imports retain their exact source bytes in the append-only audit
 * log and point `rawFileRef` to that evidence. Engine callers without an
 * external file/feed payload retain a canonical copy of the import request.
 */
export async function importStatement(
  opts: {
    accountId: string;
    source: StatementSource;
    lines: ParsedStatementLine[];
    statementDate?: string | null;
    openingBalance?: string | null;
    closingBalance?: string | null;
    currency?: string | null;
    sourceEvidence?: StatementSourceEvidence | null;
    dryRun?: boolean;
  },
  ctx: BankingContext,
): Promise<ImportResult> {
  if (opts.lines.length === 0) throw new BankingError("No statement lines to import");
  // Provenance gate: every persisted statement/line/audit actor comes from
  // ctx.userId, so a no-actor placeholder arriving here would sink into all
  // three evidence surfaces. Fail closed before any write.
  requireActorId(ctx.userId);
  const account = await loadReconcilableAccount(ctx.orgId, opts.accountId);
  const currency = (opts.currency ?? account.currency).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new BankingError("Statement currency must be a three-letter ISO currency code");
  }
  if (account.currency && currency !== account.currency) {
    throw new BankingError(
      `Statement currency ${currency} does not match account currency ${account.currency}`,
    );
  }
  const validated = opts.lines.map((line, index) => {
    const dateMatch = line.postedOn.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dateMatch) throw new BankingError(`Statement line ${index + 1}: posted date must be YYYY-MM-DD`);
    const postedOn = assertRealDate(
      dateMatch[1]!,
      dateMatch[2]!,
      dateMatch[3]!,
      `Statement line ${index + 1} date`,
    );
    const bankTransactionId = line.bankTransactionId?.trim() || null;
    return {
      ...line,
      postedOn,
      amount: normalizeAmount(line.amount, `Statement line ${index + 1} amount`),
      bankTransactionId,
    };
  });
  const openingBalance = opts.openingBalance
    ? normalizeAmount(opts.openingBalance, "Opening balance")
    : null;
  const closingBalance = opts.closingBalance
    ? normalizeAmount(opts.closingBalance, "Closing balance")
    : null;
  // Prepare before opening the transaction so preview exercises the same
  // evidence limits as import and hashing/base64 work never holds the account
  // dedupe lock.
  const evidence = sourceEvidence(opts, opts.lines);

  return db.transaction(async (tx) => {
    // Serialize dedupe decisions for this tenant/account. The unique index is
    // the database backstop; the lock lets a concurrent retry return a clean
    // duplicate result instead of leaking a constraint error.
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`bank-statement-import:${ctx.orgId}:${account.id}`}, 0)
      )
    `);
    const sourceAlreadyImported = Boolean((await tx.execute<{ imported: boolean }>(sql`
      select exists (
        select 1
          from bank_statements
         where org_id = ${ctx.orgId}
           and account_id = ${account.id}
           and source_file_sha256 = ${evidence.sha256}
      ) as imported
    `)).rows[0]?.imported);
    const ids = sourceAlreadyImported
      ? []
      : [
          ...new Set(
            validated.flatMap((line) =>
              line.bankTransactionId ? [line.bankTransactionId] : [],
            ),
          ),
        ];
    const existingIds = new Set<string>();
    if (ids.length > 0) {
      const existing = (await tx.execute<{ id: string }>(sql`
        select bank_transaction_id as id
          from bank_statement_lines
         where org_id = ${ctx.orgId}
           and account_id = ${account.id}
           and bank_transaction_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      `));
      for (const row of existing.rows) existingIds.add(row.id);
    }
    const { lines: fresh, duplicates } = filterDuplicateStatementLines(
      validated,
      existingIds,
      sourceAlreadyImported,
    );
    if (opts.dryRun || fresh.length === 0) {
      return {
        statementId: null,
        sourceEvidenceRef: null,
        imported: opts.dryRun ? fresh.length : 0,
        duplicates,
        lines: fresh,
      };
    }
    const ordered = fresh
      .map((line, index) => ({ ...line, index }))
      .sort((a, b) =>
        a.postedOn < b.postedOn
          ? -1
          : a.postedOn > b.postedOn
            ? 1
            : a.index - b.index,
      );
    const statementDate = opts.statementDate ?? ordered[ordered.length - 1]!.postedOn;
    const statementDateMatch = statementDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!statementDateMatch) {
      throw new BankingError("Statement date must be YYYY-MM-DD");
    }
    assertRealDate(
      statementDateMatch[1]!,
      statementDateMatch[2]!,
      statementDateMatch[3]!,
      "Statement date",
    );
    const [stmt] = await tx
      .insert(schema.bankStatements)
      .values({
        orgId: ctx.orgId,
        accountId: account.id,
        source: opts.source,
        statementDate,
        openingBalance,
        closingBalance,
        rawFileRef: evidence.ref,
        sourceFileSha256: evidence.sha256,
        createdBy: ctx.userId,
      })
      .returning({ id: schema.bankStatements.id });
    const statementId = stmt!.id;
    await tx.insert(schema.bankStatementLines).values(
      ordered.map((l, i) => ({
        orgId: ctx.orgId,
        statementId,
        accountId: account.id,
        lineNumber: i + 1,
        postedOn: l.postedOn,
        amount: l.amount,
        currency,
        description: l.description,
        counterpartyRef: l.counterpartyRef ?? null,
        bankTransactionId: l.bankTransactionId ?? null,
        matchStatus: "unmatched" as const,
        createdBy: ctx.userId,
      })),
    );
    await tx.execute(sql`
      insert into audit_log
        (id, org_id, table_name, row_id, action, changes, actor_id, request_id)
      values
        (${evidence.auditId}, ${ctx.orgId}, 'bank_statements', ${statementId}, 'insert',
         ${JSON.stringify(evidence.changes)}::jsonb, ${ctx.userId}, ${ctx.requestId ?? null})
    `);
    return {
      statementId,
      sourceEvidenceRef: evidence.ref,
      imported: fresh.length,
      duplicates,
      lines: fresh,
    };
  });
}

// ---------------------------------------------------------------------------
// Reconciliation sessions
// ---------------------------------------------------------------------------
type ReconciliationRow = {
  id: string;
  account_id: string;
  through_date: string;
  currency: string;
  statement_balance: string;
  status: "in_progress" | "balanced" | "signed_off";
};

async function loadReconciliation(orgId: string, reconciliationId: string): Promise<ReconciliationRow> {
  const r = (await db.execute<ReconciliationRow>(sql`
    select id, account_id, through_date, currency, statement_balance, status
      from reconciliations
     where id = ${reconciliationId} and org_id = ${orgId}
  `));
  const recon = r.rows[0];
  if (!recon) throw new BankingError("Reconciliation not found");
  return recon;
}

/**
 * Start a reconciliation session. One open session per account: a second
 * concurrent session would double-claim the same journal lines.
 */
export async function startReconciliation(
  opts: { accountId: string; throughDate: string; statementBalance: string },
  ctx: BankingContext,
): Promise<{ id: string }> {
  const account = await loadReconcilableAccount(ctx.orgId, opts.accountId);
  const dateMatch = opts.throughDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) {
    throw new BankingError("Through date must be YYYY-MM-DD");
  }
  assertRealDate(dateMatch[1]!, dateMatch[2]!, dateMatch[3]!, "Through date");
  const statementBalance = normalizeAmount(opts.statementBalance, "Statement balance");
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`bank-reconciliation:${ctx.orgId}:${account.id}`}, 0)
      )
    `);
    const open = (await tx.execute<{ id: string }>(sql`
      select id from reconciliations
       where org_id = ${ctx.orgId} and account_id = ${account.id} and status <> 'signed_off'
       limit 1
    `));
    if (open.rows[0]) {
      throw new BankingError(
        "This account already has an open reconciliation — finish or discard it first",
      );
    }
    const latestSigned = (await tx.execute<{ through_date: string }>(sql`
      select through_date
        from reconciliations
       where org_id = ${ctx.orgId}
         and account_id = ${account.id}
         and status = 'signed_off'
       order by through_date desc
       limit 1
    `));
    if (latestSigned.rows[0] && opts.throughDate <= latestSigned.rows[0].through_date) {
      throw new BankingError(
        `Through date must be after the last signed-off reconciliation (${latestSigned.rows[0].through_date})`,
      );
    }
    const [recon] = await tx
      .insert(schema.reconciliations)
      .values({
        orgId: ctx.orgId,
        accountId: account.id,
        throughDate: opts.throughDate,
        currency: account.currency,
        statementBalance,
        status: "in_progress",
        createdBy: ctx.userId,
      })
      .returning({ id: schema.reconciliations.id });
    return { id: recon!.id };
  });
}

export interface ReconciliationTotals {
  statementBalance: string;
  /** GL balance of previously-reconciled lines + lines matched in this session. */
  clearedBalance: string;
  /** statementBalance − clearedBalance; sign-off requires exactly 0. */
  difference: string;
  matchedStatementLines: number;
  unmatchedStatementLines: number;
  matchedJournalLines: number;
}

type BankingSqlExecutor = SqlExecutor;
type BankingTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function reconciliationTotalsUsing(
  executor: BankingSqlExecutor,
  recon: ReconciliationRow,
  ctx: BankingContext,
): Promise<ReconciliationTotals> {
  const r = (await executor.execute<{ cleared: string; matched_journal: string; matched_stmt: string; unmatched_stmt: string }>(sql`
    select
      coalesce((
        select sum(jl.txn_amount)
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status in ('posted', 'reversed')
         where jl.account_id = ${recon.account_id} and jl.org_id = ${ctx.orgId}
           and jl.currency = ${recon.currency}
           and je.posting_date <= ${recon.through_date}
           and (jl.reconciled_at is not null
                or jl.id in (select journal_line_id from reconciliation_matches
                              where reconciliation_id = ${recon.id}
                                and org_id = ${ctx.orgId}))
      ), 0) as cleared,
      (select count(distinct m.journal_line_id) from reconciliation_matches m
        where m.reconciliation_id = ${recon.id} and m.org_id = ${ctx.orgId}) as matched_journal,
      (select count(distinct m.statement_line_id) from reconciliation_matches m
        where m.reconciliation_id = ${recon.id} and m.org_id = ${ctx.orgId}) as matched_stmt,
      (select count(*)
         from bank_statement_lines l
        where l.account_id = ${recon.account_id} and l.org_id = ${ctx.orgId}
          and l.match_status = 'unmatched' and l.posted_on <= ${recon.through_date}) as unmatched_stmt
  `));
  const row = r.rows[0]!;
  const clearedBalance = fromUnits(toUnits(row.cleared));
  const difference = fromUnits(toUnits(recon.statement_balance) - toUnits(row.cleared));
  return {
    statementBalance: fromUnits(toUnits(recon.statement_balance)),
    clearedBalance,
    difference,
    matchedStatementLines: Number(row.matched_stmt),
    unmatchedStatementLines: Number(row.unmatched_stmt),
    matchedJournalLines: Number(row.matched_journal),
  };
}

/** Running totals for a session — the workspace difference badge and the sign-off gate. */
export async function reconciliationTotals(
  reconciliationId: string,
  ctx: BankingContext,
): Promise<ReconciliationTotals> {
  const recon = await loadReconciliation(ctx.orgId, reconciliationId);
  return reconciliationTotalsUsing(db, recon, ctx);
}

/** Keep `status` honest: balanced ⇔ difference is 0 (signed_off never changes). */
async function refreshStatus(
  recon: ReconciliationRow,
  ctx: BankingContext,
  executor: BankingSqlExecutor = db,
): Promise<ReconciliationTotals> {
  const totals = await reconciliationTotalsUsing(executor, recon, ctx);
  await executor.execute(sql`
    update reconciliations
       set status = ${isZero(totals.difference) ? "balanced" : "in_progress"},
           updated_at = now(), updated_by = ${ctx.userId}
     where id = ${recon.id} and org_id = ${ctx.orgId} and status <> 'signed_off'
  `);
  return totals;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;

export interface AutoMatchResult {
  matched: number;
  highConfidence: number; // exact amount, ≤ 3 days apart → 0.9
  mediumConfidence: number; // exact amount, ≤ 14 days apart → 0.7
  totals: ReconciliationTotals;
}

/**
 * Auto-match unmatched statement lines to unreconciled, unclaimed posted
 * journal lines on the session's account: exact signed amount + posting date
 * within 3 days ⇒ confidence 0.9; within 14 days ⇒ 0.7. Each journal line is
 * used at most once; the closest date wins.
 */
export async function autoMatch(reconciliationId: string, ctx: BankingContext): Promise<AutoMatchResult> {
  return db.transaction(async (tx) => {
    const reconResult = (await tx.execute<ReconciliationRow>(sql`
      select id, account_id, through_date, currency, statement_balance, status
        from reconciliations
       where id = ${reconciliationId} and org_id = ${ctx.orgId}
       for update
    `));
    const recon = reconResult.rows[0];
    if (!recon) throw new BankingError("Reconciliation not found");
    if (recon.status === "signed_off") throw new BankingError("Reconciliation is already signed off");

    const stmtRes = (await tx.execute<{ id: string; posted_on: string; amount: string }>(sql`
      select l.id, l.posted_on, l.amount
       from bank_statement_lines l
       where l.account_id = ${recon.account_id} and l.org_id = ${ctx.orgId}
         and l.currency = ${recon.currency}
         and l.match_status = 'unmatched' and l.posted_on <= ${recon.through_date}
       order by l.posted_on, l.line_number
       for update
    `));
    const glRes = (await tx.execute<{ id: string; posting_date: string; amount: string }>(sql`
      select jl.id, je.posting_date, jl.txn_amount as amount
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status in ('posted', 'reversed')
       where jl.account_id = ${recon.account_id} and jl.org_id = ${ctx.orgId}
         and jl.currency = ${recon.currency}
         and je.posting_date <= ${recon.through_date}
         and jl.reconciled_at is null
         and not exists (select 1 from reconciliation_matches m where m.journal_line_id = jl.id and m.org_id = jl.org_id)
       order by je.posting_date, jl.line_number
       for update of jl
    `));

    // candidates by exact signed amount
    const byAmount = new Map<string, { id: string; date: string }[]>();
    for (const jl of glRes.rows) {
      const key = toUnits(jl.amount).toString();
      const list = byAmount.get(key) ?? [];
      list.push({ id: jl.id, date: jl.posting_date });
      byAmount.set(key, list);
    }

    const pairs: { statementLineId: string; journalLineId: string; confidence: string }[] = [];
    for (const line of stmtRes.rows) {
      const candidates = byAmount.get(toUnits(line.amount).toString());
      if (!candidates?.length) continue;
      let bestIdx = -1;
      let bestDays = Infinity;
      for (let i = 0; i < candidates.length; i++) {
        const days = daysBetween(line.posted_on, candidates[i]!.date);
        if (days < bestDays) {
          bestDays = days;
          bestIdx = i;
        }
      }
      if (bestIdx === -1 || bestDays > 14) continue;
      const [winner] = candidates.splice(bestIdx, 1);
      pairs.push({
        statementLineId: line.id,
        journalLineId: winner!.id,
        confidence: bestDays <= 3 ? "0.9" : "0.7",
      });
    }

    if (pairs.length > 0) {
      await tx.insert(schema.reconciliationMatches).values(
        pairs.map((p) => ({
          orgId: ctx.orgId,
          reconciliationId: recon.id,
          statementLineId: p.statementLineId,
          journalLineId: p.journalLineId,
          matchedBy: "auto" as const,
          confidence: p.confidence,
          createdBy: ctx.userId,
        })),
      );
      await tx.execute(sql`
        update bank_statement_lines
           set match_status = 'matched', updated_at = now(), updated_by = ${ctx.userId}
         where id = any(${sql.param(pairs.map((p) => p.statementLineId))})
           and org_id = ${ctx.orgId}
      `);
    }

    const totals = await refreshStatus(recon, ctx, tx);
    return {
      matched: pairs.length,
      highConfidence: pairs.filter((p) => p.confidence === "0.9").length,
      mediumConfidence: pairs.filter((p) => p.confidence === "0.7").length,
      totals,
    };
  });
}

type MatchOptions = {
  reconciliationId: string;
  statementLineId: string;
};

type MatchOrigin = "auto" | "manual" | "rule";

/**
 * Validate and persist a match on an already-open transaction. The statement
 * line lock is deliberately acquired before the optional journal factory: a
 * concurrent rule invocation therefore waits for the winner and then fails
 * without creating/posting a second journal.
 */
async function createMatchInTransaction(
  tx: BankingTransaction,
  opts: MatchOptions,
  ctx: BankingContext,
  journalLineIdsOrFactory: string[] | (() => Promise<string>),
  matchedBy: MatchOrigin,
): Promise<ReconciliationTotals> {
  const reconResult = (await tx.execute<ReconciliationRow>(sql`
    select id, account_id, through_date, currency, statement_balance, status
      from reconciliations
     where id = ${opts.reconciliationId} and org_id = ${ctx.orgId}
     for update
  `));
  const recon = reconResult.rows[0];
  if (!recon) throw new BankingError("Reconciliation not found");
  if (recon.status === "signed_off") throw new BankingError("Reconciliation is already signed off");

  const stmt = (await tx.execute<{ id: string; amount: string; currency: string }>(sql`
    select l.id, l.amount, l.currency
      from bank_statement_lines l
     where l.id = ${opts.statementLineId} and l.org_id = ${ctx.orgId}
       and l.account_id = ${recon.account_id}
       and l.currency = ${recon.currency}
       and l.posted_on <= ${recon.through_date}
       and l.match_status = 'unmatched'
     for update
  `));
  if (!stmt.rows[0]) {
    throw new BankingError(
      "Statement line is unavailable, outside the reconciliation cutoff, or already matched",
    );
  }

  const journalLineIds = [...new Set(
    typeof journalLineIdsOrFactory === "function"
      ? [await journalLineIdsOrFactory()]
      : journalLineIdsOrFactory,
  )];
  if (journalLineIds.length === 0) throw new BankingError("Select at least one journal line");

  const gl = (await tx.execute<{ id: string; amount: string }>(sql`
    select jl.id, jl.txn_amount as amount
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status in ('posted', 'reversed')
     where jl.id = any(${sql.param(journalLineIds)}::uuid[])
       and jl.org_id = ${ctx.orgId}
       and jl.account_id = ${recon.account_id}
       and jl.currency = ${recon.currency}
       and jl.reconciled_at is null
       and je.posting_date <= ${recon.through_date}
       and not exists (
         select 1 from reconciliation_matches m where m.journal_line_id = jl.id and m.org_id = jl.org_id
       )
     order by jl.id
     for update of jl
  `));
  if (gl.rows.length !== journalLineIds.length) {
    throw new BankingError(
      "One or more journal lines are unavailable, outside the cutoff, already reconciled, or already matched",
    );
  }
  const journalTotal = sum(gl.rows.map((line) => line.amount));
  if (toUnits(journalTotal) !== toUnits(stmt.rows[0].amount)) {
    throw new BankingError(
      `Selected journal lines total ${journalTotal}; the statement line is ${fromUnits(toUnits(stmt.rows[0].amount))}`,
    );
  }

  await tx.insert(schema.reconciliationMatches).values(
    journalLineIds.map((journalLineId) => ({
      orgId: ctx.orgId,
      reconciliationId: recon.id,
      statementLineId: opts.statementLineId,
      journalLineId,
      matchedBy,
      confidence: null,
      createdBy: ctx.userId,
    })),
  );
  await tx.execute(sql`
    update bank_statement_lines
       set match_status = 'matched', updated_at = now(), updated_by = ${ctx.userId}
       where id = ${opts.statementLineId} and org_id = ${ctx.orgId}
  `);
  return refreshStatus(recon, ctx, tx);
}

/**
 * Claim an unmatched statement line and create/match its journal atomically.
 * The callback runs while the line row is locked and inside the transaction
 * pinned by `withOrgTransaction`; engine/web calls that use the shared `db`
 * handle therefore join this exact transaction. If the line was claimed by a
 * concurrent invocation, the callback is never called and no journal exists
 * to orphan.
 */
export async function createMatchWithJournal(
  opts: MatchOptions & { createJournal: () => Promise<string>; matchedBy?: MatchOrigin },
  ctx: BankingContext,
): Promise<ReconciliationTotals> {
  return withOrgTransaction(ctx.orgId, () =>
    inDbTransaction((tx) =>
      createMatchInTransaction(tx, opts, ctx, opts.createJournal, opts.matchedBy ?? "rule"),
    ),
  );
}

/** Manually pair one statement line with one or more journal lines. */
export async function createMatch(
  opts: MatchOptions & { journalLineIds: string[] },
  ctx: BankingContext,
): Promise<ReconciliationTotals> {
  const journalLineIds = [...new Set(opts.journalLineIds)];
  if (journalLineIds.length === 0) throw new BankingError("Select at least one journal line");

  return db.transaction((tx) =>
    createMatchInTransaction(tx, opts, ctx, journalLineIds, "manual"),
  );
}

/** Undo all of a statement line's matches within a session. */
export async function unmatchStatementLine(
  opts: { reconciliationId: string; statementLineId: string },
  ctx: BankingContext,
): Promise<ReconciliationTotals> {
  return db.transaction(async (tx) => {
    const reconResult = (await tx.execute<ReconciliationRow>(sql`
      select id, account_id, through_date, currency, statement_balance, status
        from reconciliations
       where id = ${opts.reconciliationId} and org_id = ${ctx.orgId}
       for update
    `));
    const recon = reconResult.rows[0];
    if (!recon) throw new BankingError("Reconciliation not found");
    if (recon.status === "signed_off") throw new BankingError("Reconciliation is already signed off");

    const deleted = (await tx.execute<{ id: string }>(sql`
      delete from reconciliation_matches
       where reconciliation_id = ${recon.id}
         and statement_line_id = ${opts.statementLineId}
         and org_id = ${ctx.orgId}
      returning id
    `));
    if (deleted.rows.length === 0) {
      throw new BankingError("No matches for that statement line in this reconciliation");
    }
    await tx.execute(sql`
      update bank_statement_lines l
         set match_status = 'unmatched', updated_at = now(), updated_by = ${ctx.userId}
       where l.id = ${opts.statementLineId} and l.org_id = ${ctx.orgId}
         and not exists (
           select 1 from reconciliation_matches m where m.statement_line_id = l.id and m.org_id = l.org_id
         )
    `);
    return refreshStatus(recon, ctx, tx);
  });
}

/**
 * Exclude an unmatched statement line from reconciliation (bank fees you book
 * elsewhere, duplicates, opening entries). Only unmatched lines can be
 * excluded; matched lines must be unmatched first.
 */
export async function excludeStatementLine(
  statementLineId: string,
  reasonInput: string,
  ctx: BankingContext,
): Promise<void> {
  const reason = reasonInput.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new BankingError("Exclusion reason must be between 5 and 500 characters");
  }
  await db.transaction(async (tx) => {
    const res = (await tx.execute<{ id: string }>(sql`
      update bank_statement_lines l
         set match_status = 'excluded',
             exclusion_reason = ${reason},
             excluded_at = now(),
             excluded_by = ${ctx.userId},
             updated_at = now(),
             updated_by = ${ctx.userId}
       where l.id = ${statementLineId}
         and l.org_id = ${ctx.orgId}
         and l.match_status = 'unmatched'
      returning l.id
    `));
    if (!res.rows[0]) throw new BankingError("Only unmatched lines can be excluded");
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${ctx.orgId}, 'bank_statement_lines', ${statementLineId}, 'update',
         ${JSON.stringify({
           operation: "exclude",
           reason,
           before: { matchStatus: "unmatched" },
           after: { matchStatus: "excluded" },
         })}::jsonb,
         ${ctx.userId})
    `);
  });
}

/** Restore an excluded statement line back to the unmatched queue. */
export async function restoreStatementLine(statementLineId: string, ctx: BankingContext): Promise<void> {
  await db.transaction(async (tx) => {
    const lineResult = (await tx.execute<{
        id: string;
        account_id: string;
        posted_on: string;
        exclusion_reason: string;
      }>(sql`
      select l.id, l.account_id, l.posted_on, l.exclusion_reason
        from bank_statement_lines l
       where l.id = ${statementLineId}
         and l.org_id = ${ctx.orgId}
         and l.match_status = 'excluded'
       for update
    `));
    const line = lineResult.rows[0];
    if (!line) throw new BankingError("Only excluded lines can be restored");
    const signed = (await tx.execute<{ id: string }>(sql`
      select id
        from reconciliations
       where org_id = ${ctx.orgId}
         and account_id = ${line.account_id}
         and status = 'signed_off'
         and through_date >= ${line.posted_on}
       limit 1
    `));
    if (signed.rows[0]) {
      throw new BankingError(
        "This exclusion is covered by a signed-off reconciliation and cannot be restored",
      );
    }
    await tx.execute(sql`
      update bank_statement_lines
         set match_status = 'unmatched',
             exclusion_reason = null,
             excluded_at = null,
             excluded_by = null,
             updated_at = now(),
             updated_by = ${ctx.userId}
       where id = ${statementLineId} and org_id = ${ctx.orgId}
    `);
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${ctx.orgId}, 'bank_statement_lines', ${statementLineId}, 'update',
         ${JSON.stringify({
           operation: "restore_exclusion",
           priorReason: line.exclusion_reason,
           before: { matchStatus: "excluded" },
           after: { matchStatus: "unmatched" },
         })}::jsonb,
         ${ctx.userId})
    `);
  });
}

/**
 * Discard an unsigned session: delete its matches and release its statement
 * lines back to unmatched. Signed-off sessions are permanent.
 */
export async function discardReconciliation(reconciliationId: string, ctx: BankingContext): Promise<void> {
  await db.transaction(async (tx) => {
    const reconResult = (await tx.execute<ReconciliationRow>(sql`
      select id, account_id, through_date, currency, statement_balance, status
        from reconciliations
       where id = ${reconciliationId} and org_id = ${ctx.orgId}
       for update
    `));
    const recon = reconResult.rows[0];
    if (!recon) throw new BankingError("Reconciliation not found");
    if (recon.status === "signed_off") {
      throw new BankingError("Signed-off reconciliations cannot be discarded");
    }
    const released = (await tx.execute<{ statement_line_id: string }>(sql`
      delete from reconciliation_matches
       where reconciliation_id = ${recon.id} and org_id = ${ctx.orgId}
      returning statement_line_id
    `));
    const stmtIds = [...new Set(released.rows.map((r) => r.statement_line_id))];
    if (stmtIds.length > 0) {
      await tx.execute(sql`
        update bank_statement_lines l
           set match_status = 'unmatched', updated_at = now(), updated_by = ${ctx.userId}
         where l.id = any(${sql.param(stmtIds)}::uuid[])
           and l.org_id = ${ctx.orgId}
           and not exists (select 1 from reconciliation_matches m where m.statement_line_id = l.id and m.org_id = l.org_id)
      `);
    }
    await tx.execute(sql`
      delete from reconciliations where id = ${recon.id} and org_id = ${ctx.orgId}
    `);
  });
}

// ---------------------------------------------------------------------------
// Sign-off
// ---------------------------------------------------------------------------

/**
 * Sign off a session whose difference is exactly zero: stamp every matched
 * journal line's `reconciled_at`/`reconciliation_id` (allowed on posted lines
 * by jl_guard's metadata carve-out) and mark the session signed_off.
 */
export async function markReconciled(
  reconciliationId: string,
  ctx: BankingContext,
): Promise<{ journalLinesReconciled: number }> {
  return db.transaction(async (tx) => {
    const r = (await tx.execute<ReconciliationRow>(sql`
      select id, account_id, through_date, currency, statement_balance, status
        from reconciliations
       where id = ${reconciliationId} and org_id = ${ctx.orgId}
       for update
    `));
    const recon = r.rows[0];
    if (!recon) throw new BankingError("Reconciliation not found");
    if (recon.status === "signed_off") {
      const existing = (await tx.execute<{ count: number }>(sql`
        select count(*)::int as count
          from journal_lines
         where org_id = ${ctx.orgId} and reconciliation_id = ${recon.id}
      `));
      return { journalLinesReconciled: existing.rows[0]!.count };
    }

    const statementEvidence = (await tx.execute<{ count: number }>(sql`
      select count(*)::int as count
        from bank_statement_lines
       where org_id = ${ctx.orgId}
         and account_id = ${recon.account_id}
         and currency = ${recon.currency}
         and posted_on <= ${recon.through_date}
    `));
    if (statementEvidence.rows[0]!.count === 0) {
      throw new BankingError(
        "Cannot sign off without imported statement evidence through the reconciliation date",
      );
    }

    const unmatched = (await tx.execute<{ count: number }>(sql`
      select count(*)::int as count
        from bank_statement_lines
       where org_id = ${ctx.orgId}
         and account_id = ${recon.account_id}
         and currency = ${recon.currency}
         and posted_on <= ${recon.through_date}
         and match_status = 'unmatched'
    `));
    if (unmatched.rows[0]!.count > 0) {
      throw new BankingError(
        `Cannot sign off: ${unmatched.rows[0]!.count} statement line(s) through the cutoff remain unmatched`,
      );
    }

    const invalidMatches = (await tx.execute<{ statement_line_id: string }>(sql`
      select m.statement_line_id
        from reconciliation_matches m
        join bank_statement_lines l
          on l.id = m.statement_line_id
         and l.org_id = m.org_id
        join journal_lines jl
          on jl.id = m.journal_line_id
         and jl.org_id = m.org_id
        join journal_entries je
          on je.id = jl.entry_id
         and je.org_id = jl.org_id
         and je.status in ('posted', 'reversed')
       where m.reconciliation_id = ${recon.id}
         and m.org_id = ${ctx.orgId}
       group by m.statement_line_id, l.amount, l.account_id, l.currency,
                l.posted_on, l.match_status
      having l.account_id <> ${recon.account_id}
          or l.currency <> ${recon.currency}
          or l.posted_on > ${recon.through_date}
          or l.match_status <> 'matched'
          or bool_or(jl.account_id <> ${recon.account_id})
          or bool_or(jl.currency <> ${recon.currency})
          or bool_or(je.posting_date > ${recon.through_date})
          or bool_or(jl.reconciled_at is not null)
          or sum(jl.txn_amount) <> l.amount
       limit 1
    `));
    if (invalidMatches.rows[0]) {
      throw new BankingError(
        "Cannot sign off: one or more matches fail account, currency, cutoff, availability, or exact-amount cross-footing",
      );
    }

    const bal = (await tx.execute<{ cleared: string }>(sql`
      select coalesce(sum(jl.txn_amount), 0) as cleared
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status in ('posted', 'reversed')
       where jl.account_id = ${recon.account_id} and jl.org_id = ${ctx.orgId}
         and jl.currency = ${recon.currency}
         and je.posting_date <= ${recon.through_date}
         and (jl.reconciled_at is not null
              or jl.id in (select journal_line_id from reconciliation_matches rm
                            where rm.reconciliation_id = ${recon.id}
                              and rm.org_id = ${ctx.orgId}))
    `));
    const difference = fromUnits(toUnits(recon.statement_balance) - toUnits(bal.rows[0]!.cleared));
    if (!isZero(difference)) {
      throw new BankingError(
        `Cannot sign off: difference is ${difference}, not 0.0000 — match or unmatch lines until it balances`,
      );
    }

    // journal_lines carries no row-level audit columns. The reconciliation
    // stamp is its own evidence; transaction amendments are preserved through
    // immutable document + GL snapshots in audit_log.
    const stamped = (await tx.execute<{ id: string }>(sql`
      update journal_lines jl
         set reconciled_at = now(), reconciliation_id = ${recon.id}
       where jl.org_id = ${ctx.orgId} and jl.reconciled_at is null
         and jl.id in (select journal_line_id from reconciliation_matches
                        where reconciliation_id = ${recon.id}
                          and org_id = ${ctx.orgId})
      returning jl.id
    `));

    await tx.execute(sql`
      update reconciliations
         set status = 'signed_off', signed_off_by = ${ctx.userId}, signed_off_at = now(),
             updated_at = now(), updated_by = ${ctx.userId}
       where id = ${recon.id} and org_id = ${ctx.orgId}
    `);
    const excluded = (await tx.execute<{ count: number }>(sql`
      select count(*)::int as count
        from bank_statement_lines
       where org_id = ${ctx.orgId}
         and account_id = ${recon.account_id}
         and currency = ${recon.currency}
         and posted_on <= ${recon.through_date}
         and match_status = 'excluded'
    `));
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${ctx.orgId}, 'reconciliations', ${recon.id}, 'approve',
         ${JSON.stringify({
           operation: "sign_off",
           statementBalance: fromUnits(toUnits(recon.statement_balance)),
           currency: recon.currency,
           throughDate: recon.through_date,
           matchedJournalLines: stamped.rows.length,
           excludedStatementLines: excluded.rows[0]!.count,
           difference: "0.0000",
         })}::jsonb,
         ${ctx.userId})
    `);

    return { journalLinesReconciled: stamped.rows.length };
  });
}
