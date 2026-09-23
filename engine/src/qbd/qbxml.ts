import { XMLParser } from "fast-xml-parser";

export const QBXML_VERSION = "17.0";
export const QBD_PAGE_SIZE = 1_000;

export interface QbdRequestSpec {
  family: string;
  requestKind: string;
  requestXml: string;
}

export interface QbdReportRow {
  rowType: string;
  columns: Record<string, string>;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
});

export function xmlEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function qbxml(inner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><?qbxml version="${QBXML_VERSION}"?><QBXML><QBXMLMsgsRq onError="stopOnError">${inner}</QBXMLMsgsRq></QBXML>`;
}

/** Use the highest qbXML version supported by both the app and this company. */
export function negotiateQbxmlVersion(xml: string, supportedMajor?: number, supportedMinor?: number): string {
  const major = Number.isInteger(supportedMajor) && supportedMajor! > 0
    ? Math.min(Number(QBXML_VERSION.split(".")[0]), supportedMajor!)
    : Number(QBXML_VERSION.split(".")[0]);
  const minor = major === Number(QBXML_VERSION.split(".")[0])
    ? Math.min(Number(QBXML_VERSION.split(".")[1]), Number.isInteger(supportedMinor) ? supportedMinor! : 0)
    : 0;
  return xml.replace(/<\?qbxml version="[^"]+"\?>/, `<?qbxml version="${major}.${minor}"?>`);
}

function listQuery(name: string): string {
  return qbxml(`<${name}QueryRq iterator="Start"><MaxReturned>${QBD_PAGE_SIZE}</MaxReturned></${name}QueryRq>`);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function endOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month + 1, 0));
}

export function calendarMonths(from: string, through: Date): Array<{ month: string; from: string; to: string }> {
  const start = new Date(`${from}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new Error(`invalid QuickBooks history start date: ${from}`);
  const stop = new Date(Date.UTC(through.getUTCFullYear(), through.getUTCMonth(), through.getUTCDate()));
  if (start > stop) throw new Error("QuickBooks history start date is after the capture date");
  const out: Array<{ month: string; from: string; to: string }> = [];
  for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); y < stop.getUTCFullYear() || (y === stop.getUTCFullYear() && m <= stop.getUTCMonth()); ) {
    const first = new Date(Date.UTC(y, m, 1));
    const last = endOfMonth(y, m);
    const rangeFrom = first < start ? start : first;
    const rangeTo = last > stop ? stop : last;
    out.push({ month: isoDate(first).slice(0, 7), from: isoDate(rangeFrom), to: isoDate(rangeTo) });
    m += 1;
    if (m === 12) { y += 1; m = 0; }
  }
  return out;
}

function generalLedgerRequest(from: string, to: string): string {
  const columns = ["TxnType", "Date", "RefNumber", "Name", "Memo", "Account", "SplitAccount", "Debit", "Credit", "Amount", "TxnID", "ModifiedTime"];
  return qbxml(`<GeneralDetailReportQueryRq><GeneralDetailReportType>GeneralLedger</GeneralDetailReportType><ReportPeriod><FromReportDate>${from}</FromReportDate><ToReportDate>${to}</ToReportDate></ReportPeriod><ReportDetailLevelFilter>AllExceptSummary</ReportDetailLevelFilter><ReportPostingStatusFilter>Posting</ReportPostingStatusFilter>${columns.map((c) => `<IncludeColumn>${c}</IncludeColumn>`).join("")}<IncludeAccounts>All</IncludeAccounts><ReportBasis>Accrual</ReportBasis></GeneralDetailReportQueryRq>`);
}

function trialBalanceRequest(through: Date): string {
  return qbxml(`<GeneralSummaryReportQueryRq><GeneralSummaryReportType>TrialBalance</GeneralSummaryReportType><ReportPeriod><ToReportDate>${isoDate(through)}</ToReportDate></ReportPeriod><ReportBasis>Accrual</ReportBasis><SummarizeColumnsBy>TotalOnly</SummarizeColumnsBy><IncludeAccounts>All</IncludeAccounts></GeneralSummaryReportQueryRq>`);
}

/**
 * Full, deterministic capture plan. Ledger reports are split by calendar month
 * because report requests are not iterator-capable. Master lists use SDK
 * iterators and may use modified timestamps on mirrors.
 */
export function buildCapturePlan(historyStartDate: string, through: Date): QbdRequestSpec[] {
  const requests: QbdRequestSpec[] = [
    { family: "company", requestKind: "CompanyQuery", requestXml: qbxml("<CompanyQueryRq/>") },
    { family: "preferences", requestKind: "PreferencesQuery", requestXml: qbxml("<PreferencesQueryRq/>") },
  ];
  for (const name of ["Account", "Customer", "Vendor", "Employee", "Item", "Terms", "SalesTaxCode"]) {
    // A complete list is intentional: ledger rows identify accounts/entities
    // by full name, so each capture needs the full ListID mapping even when the
    // transaction sweep is being used for a mirror.
    requests.push({ family: name.toLowerCase(), requestKind: `${name}Query`, requestXml: listQuery(name) });
  }
  for (const month of calendarMonths(historyStartDate, through)) {
    requests.push({ family: `ledger:${month.month}`, requestKind: "GeneralLedger", requestXml: generalLedgerRequest(month.from, month.to) });
  }
  requests.push({ family: "trial-balance", requestKind: "TrialBalance", requestXml: trialBalanceRequest(through) });
  return requests;
}

/** Turn an iterator Start request into its next Continue page. */
export function continueRequestXml(requestXml: string, iteratorId: string): string {
  const attrs = `iterator="Continue" iteratorID="${xmlEscape(iteratorId)}"`;
  if (/iterator="Start"/.test(requestXml)) return requestXml.replace('iterator="Start"', attrs);
  if (/iterator="Continue" iteratorID="[^"]*"/.test(requestXml)) {
    return requestXml.replace(/iterator="Continue" iteratorID="[^"]*"/, attrs);
  }
  throw new Error("request is not iterator-capable");
}

/**
 * Normalize a QuickBooks report cell date to an ISO calendar date.
 *
 * Report columns carry locale display strings (amounts arrive with thousands
 * separators, dates as M/D/YYYY), while every downstream consumer — the native
 * document contract, canonical change keys, month-bucketed verification —
 * requires ISO yyyy-mm-dd. Passing the display string through stores a
 * non-canonical date that can never match its own stored key (perpetual
 * re-amendment) and breaks month slicing. Two-digit years are refused rather
 * than guessed: a financial importer must not invent a century.
 */
export function parseQbdReportDate(value: unknown): string {
  const raw = String(value ?? "").trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    if (!isCalendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))) {
      throw new Error(`QuickBooks report date is not a calendar date: "${raw}"`);
    }
    return raw;
  }
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const year = Number(us[3]);
    const month = Number(us[1]);
    const day = Number(us[2]);
    if (!isCalendarDate(year, month, day)) {
      throw new Error(`QuickBooks report date is not a calendar date: "${raw}"`);
    }
    return `${us[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  throw new Error(`QuickBooks report date is not a recognized date: "${raw}"`);
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return Number.isInteger(day) && day >= 1 && day <= days;
}

export function parseXml(xml: string): Record<string, unknown> {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("QuickBooks XML declarations may not define a DTD or entity");
  const parsed = parser.parse(xml) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("QuickBooks returned invalid XML");
  return parsed as Record<string, unknown>;
}

function walk(value: unknown, visit: (key: string, value: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child && typeof child === "object" && !Array.isArray(child)) visit(key, child as Record<string, unknown>);
    walk(child, visit);
  }
}

export function firstNode<T extends Record<string, unknown> = Record<string, unknown>>(parsed: unknown, suffix: string): T | null {
  let found: T | null = null;
  walk(parsed, (key, value) => {
    if (!found && key.endsWith(suffix)) found = value as T;
  });
  return found;
}

/**
 * Element-presence check for dispatching on childless or text-only elements.
 * firstNode only matches object-valued nodes (elements with children or
 * attributes), so handshake elements such as `<serverVersion/>` or
 * `<clientVersion>1.5</clientVersion>` never match it and would fall through
 * to the unsupported-method fault. Presence is all the dispatcher needs.
 */
export function hasNode(parsed: unknown, suffix: string): boolean {
  if (Array.isArray(parsed)) return parsed.some((item) => hasNode(item, suffix));
  if (!parsed || typeof parsed !== "object") return false;
  return Object.keys(parsed as Record<string, unknown>).some(
    (key) => key.endsWith(suffix) || hasNode((parsed as Record<string, unknown>)[key], suffix),
  );
}

export function nodes<T extends Record<string, unknown> = Record<string, unknown>>(parsed: unknown, suffix: string): T[] {
  const out: T[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { for (const child of value) collect(child); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key.endsWith(suffix)) {
        for (const node of Array.isArray(child) ? child : [child]) {
          if (node && typeof node === "object") out.push(node as T);
        }
      }
      collect(child);
    }
  };
  collect(parsed);
  return out;
}

/**
 * A response whose statusCode or iteratorRemainingCount is not a strict
 * integer token. The bridge refuses these before completing the request (and
 * fails the capture with a named error) instead of reading a blank status as
 * success or a garbage iterator count as the last page.
 */
export class MalformedQbxmlResponseError extends Error {
  readonly name = "MalformedQbxmlResponseError";
  readonly attribute: string;
  readonly raw: string;
  constructor(attribute: string, raw: string) {
    super(`QuickBooks returned an invalid ${attribute} ${JSON.stringify(raw)}`);
    this.attribute = attribute;
    this.raw = raw;
  }
}

/**
 * Strict integer-token validation for numeric qbXML attributes. No trimming
 * (whitespace is malformed, not zero), no floats, no non-finite values, and
 * within the safe-integer range so the value survives the Number conversion
 * exactly. Returns null for anything else, including a missing attribute.
 */
function strictIntegerToken(raw: unknown, pattern: RegExp): number | null {
  if (raw == null) return null;
  const text = String(raw);
  if (!pattern.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

export function responseStatus(xml: string): {
  code: number;
  severity: string;
  message: string;
  iteratorId: string | null;
  iteratorRemaining: number;
  kind: string;
  requestId: string | null;
} {
  const parsed = parseXml(xml);
  let kind: string | null = null;
  let response: Record<string, unknown> | null = null;
  walk(parsed, (key, value) => { if (!response && key.endsWith("Rs") && "statusCode" in value) { response = value; kind = key; } });
  if (!response) {
    // An Rs element with no statusCode at all is a malformed status, not an
    // absent response: refusing it here fails the capture with a named error
    // instead of leaving the request in flight.
    let bareKind: string | null = null;
    walk(parsed, (key) => { if (!bareKind && key.endsWith("Rs")) bareKind = key; });
    if (bareKind) throw new MalformedQbxmlResponseError("statusCode", "");
    throw new Error("QuickBooks response contains no status-bearing response node");
  }
  const node = response as Record<string, unknown>;
  const rawRequestId = node.requestID ?? node.requestId ?? null;
  // statusCode must be present as a strict signed integer token: a blank or
  // whitespace status previously coerced to 0 (SUCCESS) via Number(""), which
  // could store a response and complete a capture that never succeeded.
  const code = strictIntegerToken(node.statusCode ?? null, /^-?\d+$/);
  if (code === null) {
    const raw = node.statusCode == null ? "" : String(node.statusCode);
    throw new MalformedQbxmlResponseError("statusCode", raw);
  }
  // iteratorRemainingCount is absent when the response is not paged (0
  // remaining). When present it must be a strict non-negative integer: NaN,
  // negative, fractional or infinite counts previously read as falsy or
  // positive and could complete a capture with pages missing.
  let iteratorRemaining = 0;
  if (node.iteratorRemainingCount != null) {
    const parsed = strictIntegerToken(node.iteratorRemainingCount, /^\d+$/);
    if (parsed === null) {
      throw new MalformedQbxmlResponseError("iteratorRemainingCount", String(node.iteratorRemainingCount));
    }
    iteratorRemaining = parsed;
  }
  return {
    code,
    severity: String(node.statusSeverity ?? "Error"),
    message: String(node.statusMessage ?? "Unknown QuickBooks error"),
    iteratorId: node.iteratorID ? String(node.iteratorID) : null,
    iteratorRemaining,
    kind: kind ?? "UnknownRs",
    requestId: rawRequestId == null ? null : String(rawRequestId),
  };
}

/**
 * The single request element (e.g. `CompanyQueryRq`) inside a QBXMLMsgsRq
 * envelope. The envelope wrapper `QBXMLMsgsRq` itself also ends in "Rq" and
 * is explicitly excluded: correlating against it would stamp and verify the
 * wrong element.
 */
const REQUEST_ELEMENT = /<((?!QBXMLMsgsRq)[A-Za-z][A-Za-z0-9]*Rq)(?=[\s/>])/;

export function requestElementName(requestXml: string): string | null {
  return requestXml.match(REQUEST_ELEMENT)?.[1] ?? null;
}

/** The response element that answers a request element (`CompanyQueryRq` → `CompanyQueryRs`). */
export function responseElementForRequest(requestXml: string): string | null {
  const element = requestElementName(requestXml);
  return element ? element.replace(/Rq$/, "Rs") : null;
}

/**
 * Stamp (or replace) the qbXML `requestID` correlation attribute on the
 * request element. QuickBooks echoes the attribute on the answering `*Rs`
 * element, which is what lets receiveResponseXML prove a response answers
 * the outstanding request instead of a superseded one. The id is the
 * qbd_requests row id: stable across tickets and sessions, so a re-queued
 * request keeps its identity.
 */
export function stampRequestId(requestXml: string, requestId: string): string {
  const without = requestXml.replace(/ requestID="[^"]*"/g, "");
  let stamped = false;
  const out = without.replace(REQUEST_ELEMENT, (_match, tag: string) => {
    stamped = true;
    return `<${tag} requestID="${requestId}"`;
  });
  if (!stamped) throw new Error("QuickBooks request contains no request element to correlate");
  return out;
}

/** The `requestID` a stamped outgoing request carries, or null when unstamped (pre-correlation rows). */
export function requestIdFromRequestXml(requestXml: string): string | null {
  return requestXml.match(/<((?!QBXMLMsgsRq)[A-Za-z][A-Za-z0-9]*Rq)(?=[\s/>])[^>]*\srequestID="([^"]*)"/)?.[2] ?? null;
}

function asArray(value: unknown): unknown[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

/** Parse the column-id based report format into stable ColType-keyed rows. */
export function parseReportRows(xml: string): QbdReportRow[] {
  const parsed = parseXml(xml);
  const report = firstNode(parsed, "ReportRet");
  if (!report) return [];
  const byId = new Map<string, string>();
  for (const desc of asArray(report.ColDesc)) {
    if (!desc || typeof desc !== "object") continue;
    const d = desc as Record<string, unknown>;
    if (d.colID && d.ColType) byId.set(String(d.colID), String(d.ColType));
  }
  const rows: QbdReportRow[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { for (const v of value) collect(v); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/^(DataRow|SubtotalRow|TotalRow|TextRow)$/.test(key)) {
        for (const row of asArray(child)) {
          if (!row || typeof row !== "object") continue;
          const record = row as Record<string, unknown>;
          const columns: Record<string, string> = {};
          for (const col of asArray(record.ColData)) {
            if (!col || typeof col !== "object") continue;
            const c = col as Record<string, unknown>;
            const name = byId.get(String(c.colID ?? ""));
            if (name) columns[name] = String(c.value ?? "");
          }
          rows.push({ rowType: key, columns });
        }
      }
      collect(child);
    }
  };
  collect(report.ReportData);
  return rows;
}
