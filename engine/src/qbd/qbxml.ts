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

export function responseStatus(xml: string): {
  code: number;
  severity: string;
  message: string;
  iteratorId: string | null;
  iteratorRemaining: number;
} {
  const parsed = parseXml(xml);
  let response: Record<string, unknown> | null = null;
  walk(parsed, (key, value) => { if (!response && key.endsWith("Rs") && "statusCode" in value) response = value; });
  if (!response) throw new Error("QuickBooks response contains no status-bearing response node");
  const node = response as Record<string, unknown>;
  return {
    code: Number(node.statusCode ?? -1),
    severity: String(node.statusSeverity ?? "Error"),
    message: String(node.statusMessage ?? "Unknown QuickBooks error"),
    iteratorId: node.iteratorID ? String(node.iteratorID) : null,
    iteratorRemaining: Number(node.iteratorRemainingCount ?? 0),
  };
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

export function soapText(parsed: unknown, method: string, argument: string): string {
  const methodNode = firstNode(parsed, method);
  if (!methodNode) return "";
  const value = methodNode[argument];
  if (value && typeof value === "object" && "#text" in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)["#text"] ?? "");
  }
  return value == null ? "" : String(value);
}
