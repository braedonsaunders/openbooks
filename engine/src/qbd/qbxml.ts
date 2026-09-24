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

/**
 * UTC-midnight Date for civil (year, monthIndex, day) parts. Local copy of
 * the platform/business-date.ts utcDateFromParts idiom (`new Date(0)` +
 * setUTCFullYear, which keeps literal years 0001-0099 that Date.UTC would
 * remap onto 1900-1999): this connector module loads no platform stack.
 */
function utcCivilDate(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

function endOfMonth(year: number, month: number): Date {
  return utcCivilDate(year, month + 1, 0);
}

export function calendarMonths(from: string, through: Date): Array<{ month: string; from: string; to: string }> {
  const start = new Date(`${from}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new Error(`invalid QuickBooks history start date: ${from}`);
  const stop = utcCivilDate(through.getUTCFullYear(), through.getUTCMonth(), through.getUTCDate());
  if (start > stop) throw new Error("QuickBooks history start date is after the capture date");
  const out: Array<{ month: string; from: string; to: string }> = [];
  for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); y < stop.getUTCFullYear() || (y === stop.getUTCFullYear() && m <= stop.getUTCMonth()); ) {
    const first = utcCivilDate(y, m, 1);
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
  const months = calendarMonths(historyStartDate, through);
  for (const month of months) {
    requests.push({ family: `ledger:${month.month}`, requestKind: "GeneralLedger", requestXml: generalLedgerRequest(month.from, month.to) });
  }
  // A dated opening trial balance as of the day before the history window.
  // Ledger months cover historyStartDate onward while the cumulative trial
  // balance runs through today, so without this an account whose balance
  // predates the window (and never moves inside it) has no imported leg and
  // no source month row — parity could never reconcile. calendarMonths above
  // already validated historyStartDate, so the day-before arithmetic is safe.
  const windowStart = new Date(`${historyStartDate}T00:00:00.000Z`);
  requests.push({
    family: "opening-trial-balance",
    requestKind: "TrialBalance",
    requestXml: trialBalanceRequest(new Date(windowStart.getTime() - 86_400_000)),
  });
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

export interface QbdReportAmount {
  /** Canonical decimal text: no grouping, `.` decimal, sign preserved. */
  text: string;
  /** Inferred decimal separator, or null when the value pins none. */
  decimal: "." | "," | null;
  /** Grouping separator present, or null when none. */
  grouping: "." | "," | null;
}

/**
 * Locale-aware parse of a QuickBooks report amount cell into canonical
 * decimal text for `toUnits`. Every QBD amount consumer must read through
 * this — never by stripping commas.
 *
 * CompanyQuery/PreferencesQuery expose no number-format field (the only
 * preferences value read anywhere is ClosingDate), so the company file's
 * separators cannot be looked up and must be inferred per value. The
 * previous shared helper stripped every comma unconditionally, so a
 * German-locale company file's `12,34` (twelve-thirty-four) imported as
 * 1234 — a silent 100x overstatement on small amounts — while `1.234,56`
 * threw: small amounts corrupted while large ones refused.
 *
 * Inference rules (strict; anything else refuses by name):
 * - Both `.` and `,`: the LAST one is the decimal separator (US `1,234.56`
 *   and German `1.234,56` agree on this); the other may only appear as valid
 *   thousands grouping (first group 1–3 digits, the rest exactly 3).
 * - One separator kind: a single mark with a 3-digit tail (`12,345`,
 *   `1.234`) is genuinely ambiguous (US thousands vs European decimal) and
 *   refuses naming both readings. Repeated marks must be valid grouping; a
 *   lone mark with any other tail length is that locale's decimal mark.
 * - All-zero values (`0.000`, `0,000`) are zero in every locale and stay
 *   locale-neutral. Empty cells are zero (headings/blanks).
 * - Anything else (spaces, apostrophes, Indian-style `1,00,000`, misplaced
 *   grouping) refuses by name rather than guessing.
 */
export function parseQbdReportAmount(value: unknown, scope = "QuickBooks report"): QbdReportAmount {
  const raw = String(value ?? "").trim();
  if (raw === "") return { text: "0", decimal: null, grouping: null };
  let sign = "";
  let body = raw;
  if (body[0] === "-" || body[0] === "+") {
    if (body[0] === "-") sign = "-";
    body = body.slice(1);
  }
  const fail = (reason: string): never => {
    throw new Error(`QuickBooks amount ${JSON.stringify(raw)} in ${scope} ${reason}`);
  };
  const remedy = "confirm the company file's regional number format and re-run the capture";
  if (body === "" || !/^[0-9]/.test(body) || /[^0-9.,]/.test(body)) {
    fail(`is not a recognized number — ${remedy}`);
  }
  // Zero in every locale: the separators cannot change the value, so no
  // locale is pinned and zero-shaped rows never refuse over formatting.
  if (/^0+$/.test(body.replaceAll(".", "").replaceAll(",", ""))) {
    return { text: "0", decimal: null, grouping: null };
  }
  const finish = (text: string, decimal: "." | "," | null, grouping: "." | "," | null): QbdReportAmount =>
    ({ text: `${sign}${text}`, decimal, grouping });
  const validGrouping = (int: string, sep: "." | ","): boolean => {
    if (!int.includes(sep)) return false;
    const groups = int.split(sep);
    return groups.length > 1 && /^\d{1,3}$/.test(groups[0]!) && groups.slice(1).every((g) => /^\d{3}$/.test(g));
  };
  const dots = (body.match(/\./g) ?? []).length;
  const commas = (body.match(/,/g) ?? []).length;
  if (dots > 0 && commas > 0) {
    const decimal: "." | "," = body.lastIndexOf(".") > body.lastIndexOf(",") ? "." : ",";
    const grouping: "." | "," = decimal === "." ? "," : ".";
    const cut = body.lastIndexOf(decimal);
    const int = body.slice(0, cut);
    const frac = body.slice(cut + 1);
    if (!/^\d+$/.test(frac) || !validGrouping(int, grouping)) {
      fail(`has misplaced separators — ${remedy}`);
    }
    return finish(`${int.replaceAll(grouping, "")}.${frac}`, decimal, grouping);
  }
  if (commas > 0) {
    if (commas > 1) {
      if (!/^\d{1,3}(,\d{3})+$/.test(body)) fail(`has misplaced separators — ${remedy}`);
      return finish(body.replaceAll(",", ""), null, ",");
    }
    const [int = "", frac = ""] = body.split(",");
    if (!/^\d+$/.test(int) || !/^\d+$/.test(frac)) fail(`is not a recognized number — ${remedy}`);
    if (frac.length === 3) {
      fail(
        `is ambiguous: it reads as ${int}${frac} with US thousands separators and as ${int}.${frac} with a European decimal comma — ${remedy}`,
      );
    }
    return finish(`${int}.${frac}`, ",", null);
  }
  if (dots > 0) {
    if (dots > 1) {
      if (!/^\d{1,3}(\.\d{3})+$/.test(body)) fail(`has misplaced separators — ${remedy}`);
      return finish(body.replaceAll(".", ""), null, ".");
    }
    const [int = "", frac = ""] = body.split(".");
    if (!/^\d+$/.test(int) || !/^\d+$/.test(frac)) fail(`is not a recognized number — ${remedy}`);
    if (frac.length === 3) {
      fail(
        `is ambiguous: it reads as ${int}.${frac} with a US decimal point and as ${int}${frac} with European thousands separators — ${remedy}`,
      );
    }
    return finish(body, ".", null);
  }
  return finish(body, null, null);
}

/**
 * A single company file formats every amount one way. When one report
 * carries both US-shaped (`1,234.56`) and European-shaped (`1.234,56`)
 * evidence — including the cross case of US grouping beside a European
 * decimal mark — the capture is refused by name instead of importing half
 * its amounts at 100x. This is what lets the trial-balance verification
 * catch a locale scale error rather than staying green on two
 * identically-misparsed sides.
 */
export function assertUniformReportLocale(
  amounts: ReadonlyArray<Pick<QbdReportAmount, "decimal" | "grouping">>,
  scope: string,
): void {
  const decimals = new Set(amounts.map((a) => a.decimal).filter((d) => d !== null));
  const groupings = new Set(amounts.map((a) => a.grouping).filter((g) => g !== null));
  const mixed =
    decimals.size > 1 ||
    groupings.size > 1 ||
    [...decimals].some((d) => groupings.has(d)) ||
    [...groupings].some((g) => decimals.has(g));
  if (mixed) {
    throw new Error(
      `QuickBooks ${scope} mixes US-style (1,234.56) and European-style (1.234,56) number formats — confirm the company file's regional number format and re-run the capture`,
    );
  }
}

/**
 * Pre-authentication bound for the Web Connector SOAP endpoint. Every method
 * except a ticket-authenticated receiveResponseXML must fit inside this head:
 * the method and ticket are identified from these bytes, and anything larger
 * from an unauthenticated caller is refused with 413 before the rest is
 * buffered. 64 KiB comfortably holds any handshake, authenticate, or
 * sendRequestXML envelope (a few hundred bytes); only receiveResponseXML
 * carries company-sized payloads.
 */
export const QBD_PREAUTH_MAX_BYTES = 64 * 1024;

/** Outermost Web Connector SOAP methods dispatched by the endpoint. */
const QBD_SOAP_METHODS = [
  "serverVersion",
  "clientVersion",
  "authenticate",
  "sendRequestXML",
  "receiveResponseXML",
  "getLastError",
  "closeConnection",
  "connectionError",
] as const;

/**
 * Identify the SOAP method and ticket from a bounded envelope head — a cheap
 * regex scan, never a full parse — so the endpoint can authenticate BEFORE
 * buffering or parsing a large body. Returns null when no known method
 * element opens in the head. The head may be a truncated prefix: matching
 * needs only the opening element and the ticket element, which lead every
 * real envelope.
 */
export function identifyQbdSoapCall(head: string): { method: string; ticket: string | null } | null {
  const method = QBD_SOAP_METHODS.find((name) => new RegExp(`<${name}(?=[\\s>/])`).test(head));
  if (!method) return null;
  const ticket = head.match(/<ticket>([^<]{1,200})<\/ticket>/)?.[1] ?? null;
  return { method, ticket };
}

/**
 * Parser complexity guard, run on the buffered text BEFORE full parsing. Caps
 * nesting depth and tag count so a deeply nested or tag-bloated envelope
 * cannot exhaust the parser, and refuses DTD/entity declarations outright
 * (the same refusal parseXml applies, but before the parse rather than
 * inside it). CDATA sections are skipped as opaque so escaped payload text
 * can never inflate the depth count.
 */
export function assertSoapEnvelopeComplexity(
  text: string,
  limits: { maxTags: number; maxDepth: number } = { maxTags: 10_000_000, maxDepth: 128 },
): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("QuickBooks SOAP envelope may not define a DTD or entity");
  let depth = 0;
  let tags = 0;
  const token = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^<>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(text)) !== null) {
    const tag = match[0];
    if (tag.startsWith("<![CDATA[") || tag.startsWith("<!--") || tag.startsWith("<?")) continue;
    tags += 1;
    if (tags > limits.maxTags) {
      throw new Error(`QuickBooks SOAP envelope exceeds the ${limits.maxTags}-tag parser budget; the request was not parsed`);
    }
    if (tag.startsWith("</")) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (tag.endsWith("/>")) continue;
    depth += 1;
    if (depth > limits.maxDepth) {
      throw new Error(`QuickBooks SOAP envelope nests deeper than ${limits.maxDepth} elements; the request was not parsed`);
    }
  }
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

function exactNode(root: unknown, key: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  const collect = (value: unknown): void => {
    if (found) return;
    if (Array.isArray(value)) { for (const child of value) collect(child); return; }
    if (!value || typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      if (childKey === key && child && typeof child === "object" && !Array.isArray(child)) {
        found = child as Record<string, unknown>;
        return;
      }
      collect(child);
    }
  };
  collect(root);
  return found;
}

/** Response elements whose success payload is a column-based report. */
const REPORT_RESPONSE_ELEMENTS = new Set(["GeneralDetailReportQueryRs", "GeneralSummaryReportQueryRs"]);

/**
 * Structural payload check for a statusCode=0 response. A successful ledger
 * or trial-balance response must carry a structurally present report
 * (ReportRet plus the column descriptors) — a missing ReportRet is a
 * truncated response, never an empty month, and storing it as complete would
 * let the next sync reverse every prior document for that month as a
 * source deletion. List and account families get the same missing-container
 * validation on their answering `*Rs` node, while a genuinely empty list or
 * report (container present, zero rows) stays valid.
 */
export function assertQbdResponsePayload(input: {
  family: string;
  requestKind: string;
  expectedRs: string;
  responseXml: string;
}): void {
  const parsed = parseXml(input.responseXml);
  const rs = exactNode(parsed, input.expectedRs);
  if (!rs) {
    throw new Error(`QuickBooks ${input.requestKind} capture for ${input.family} returned success but carries no ${input.expectedRs} payload; the response was not stored — resubmit the outstanding request and check the company file`);
  }
  if (REPORT_RESPONSE_ELEMENTS.has(input.expectedRs)) {
    const report = exactNode(rs, "ReportRet");
    const columns = report ? asArray(report.ColDesc).filter((d) => d && typeof d === "object") : [];
    if (!report || columns.length === 0) {
      throw new Error(`QuickBooks ${input.requestKind} capture for ${input.family} returned success but carries no report (ReportRet with column descriptors is absent); the response was not stored — a missing report is never an empty month, resubmit the outstanding request`);
    }
  }
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
