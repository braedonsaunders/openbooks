import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  renderPdfDocument,
  renderStatementPdf,
  resolvePdfPageSetup,
  type PdfBranding,
  type PdfColumnAlign,
  type PdfDocumentInput,
  type PdfPageSetup,
  type PdfTableGroup,
  type PdfTableCell,
  type StatementPdfStyle,
} from "@openbooks/pdf";
import { COMPUTED_RETAINED_EARNINGS_PRIOR_ID } from "./computed-earnings";
import type { StatementView } from "./statement-matrix";
import type { AgingDetailRow } from "./reports/aging";
import {
  decimalIsMaterial,
  decimalIsZero,
  decimalScaleWhole,
  decimalSum,
  decimalToNumber,
  marginRatioToPercent,
  type ExactDecimal,
} from "./statement-format";
import {
  reportResultToXlsx,
  reportResultToCsv,
  statementSheetToXlsx,
  type ReportRunResult,
  type XlsxMoneyContext,
} from "@openbooks/office";
import type {
  ReportGroup,
  ReportLayoutConfig,
  ReportMoneyCurrency,
  ReportNumberFormat,
  ReportRunLabels,
  ReportSummaryItem,
} from "@openbooks/reports";
import { perShareFractionDigits, resolveReportLayout } from "@openbooks/reports";
import { resolveOrgId } from "./org-scope";
import { getTranslations } from "next-intl/server";
import { resolveLocale } from "./locale";
import { pdfMoney } from "./report-pdf-detail";
import { formatDecimal } from "./money-format";
import { formatCivilDate, formatExactPercent } from "./format";
export { generalLedgerExportData } from "./report-pdf-detail";

/**
 * Export pipeline for reports: a single intermediate shape (ExportData) feeds
 * PDF, Excel and CSV. Custom reports arrive as a ReportRunResult (numbers
 * preserved for Excel); financial statements are shaped by the adapters below.
 *
 * Money columns carry the ledger's exact decimal STRINGS and are marked with
 * per-group `money` flags (mirroring ReportGroup.money). The PDF formats them
 * through Intl mathematical values — never IEEE-754, which loses precision
 * past 2^53; see report-pdf-detail.ts. CSV retains those strings verbatim;
 * .xlsx writes each as a numeric cell in its currency's number format, only
 * when the number reads back as the same decimal, and refuses an amount
 * beyond a numeric cell's exact precision rather than rounding it. Counts
 * stay plain numbers.
 *
 * Quantity columns (share counts, hours, percentages) carry per-group
 * `numberFormats` (mirroring ReportGroup.numberFormats): the PDF formats them
 * per the viewer's locale and right-aligns them, Excel stores them as numeric
 * cells with a thousands-separated format, and CSV keeps the exact plain
 * value so the file stays machine-readable.
 */

export type Translator = (key: string, values?: Record<string, string | number>) => string;

/** PdfTableGroup plus per-column currency markers: flagged columns hold exact
 *  ledger decimal strings that must reach print without an IEEE-754 round-trip.
 *  `numberFormats` types the non-money quantity columns the same way. */
type ExportTableGroup = PdfTableGroup & {
  money?: boolean[];
  /** Per money column, its currency when it is not the report's own (see ReportGroup.moneyCurrencies). */
  moneyCurrencies?: (ReportMoneyCurrency | null)[];
  numberFormats?: (ReportNumberFormat | null)[];
  /** Per column, ISO calendar dates the PDF prints in the viewer's locale (see ReportGroup.dates). */
  dates?: boolean[];
};

export type ExportData = {
  title: string;
  dateRangeLabel: string;
  summary: ReportSummaryItem[];
  groups: ExportTableGroup[];
};

// --- branding ---------------------------------------------------------------

export async function orgBranding(
  orgId?: string,
): Promise<PdfBranding & { reportPdfStyle: StatementPdfStyle; baseCurrency: string }> {
  const activeOrgId = await resolveOrgId(orgId);
  const r = await db.execute<{
    name: string;
    base_currency: string;
    brand_primary: string | null;
    report_pdf_style: string | null;
  }>(
    sql`
    select name, base_currency,
           settings ->> 'brandPrimary' as brand_primary,
           settings ->> 'reportPdfStyle' as report_pdf_style
      from orgs
     where id = ${activeOrgId}
  `,
    "objects",
  );
  const row = r[0];
  return {
    orgName: row?.name ?? "openbooks",
    primaryColor: row?.brand_primary || null,
    reportPdfStyle: row?.report_pdf_style === "formal" ? "formal" : "modern",
    baseCurrency: row?.base_currency ?? "USD",
  };
}

// --- layout -----------------------------------------------------------------

export function resolveLayout(layout?: Partial<ReportLayoutConfig> | null): {
  page: PdfPageSetup;
  showSummary: boolean;
} {
  const resolved = resolveReportLayout(layout);
  return {
    page: resolvePdfPageSetup({
      paperSize: resolved.paperSize,
      orientation: resolved.orientation,
      marginMm: resolved.marginMm,
      density: resolved.density,
    }),
    showSummary: resolved.showSummary !== false,
  };
}

// --- shared converters ------------------------------------------------------

/** Format a number for the PDF: counts stay clean, money gets 2 decimals. */
function pdfNum(v: number, locale = "en"): string {
  return formatDecimal(locale, String(v), { maximumFractionDigits: Number.isInteger(v) ? 0 : 2 });
}

const EXACT_QUANTITY_TEXT = /^-?\d+(?:\.(\d+))?$/;

/** An exact quantity for print, in the locale's digits and separators at the
 *  value's own decimal places; percent values are percentage points. Text
 *  that is not a plain decimal (an undefined-formula label) prints as is. */
export function pdfQuantity(v: string, locale: string, format: ReportNumberFormat): string {
  const text = v.trim();
  const match = EXACT_QUANTITY_TEXT.exec(text);
  if (!match) return v;
  const places = format === "per_share" ? perShareFractionDigits(text) : (match[1]?.length ?? 0);
  return format === "percent"
    ? formatExactPercent(text, locale, places)
    : formatDecimal(locale, text, { minimumFractionDigits: places, maximumFractionDigits: places });
}

function pdfCell(
  v: string | number | null | undefined,
  locale: string,
  isMoney = false,
  numberFormat: ReportNumberFormat | null = null,
): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number")
    return numberFormat === "percent"
      ? pdfQuantity(String(v), locale, numberFormat)
      : pdfNum(v, locale);
  // pdfMoney self-guards: non-numeric text in a flagged column renders raw.
  if (isMoney) return pdfMoney(v, locale);
  if (numberFormat) return pdfQuantity(v, locale, numberFormat);
  return String(v);
}

function formattedPdfCell(
  cell: PdfTableCell,
  locale: string,
  isMoney: boolean,
  numberFormat: ReportNumberFormat | null,
): PdfTableCell {
  if (cell !== null && typeof cell === "object") {
    return {
      ...cell,
      text: pdfCell(cell.text, locale, isMoney, numberFormat),
      ...(cell.segments
        ? {
            segments: cell.segments.map((segment) => ({
              ...segment,
              text: pdfCell(segment.text, locale, isMoney, numberFormat),
            })),
          }
        : {}),
    };
  }
  return pdfCell(cell, locale, isMoney, numberFormat);
}

const ISO_CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A date cell for print: an ISO calendar date in the viewer's locale; any other text prints as is. */
function pdfDateCell(cell: PdfTableCell, locale: string): PdfTableCell {
  const date = (text: string | number | null | undefined) =>
    typeof text === "string" && ISO_CIVIL_DATE.test(text)
      ? formatCivilDate(text, locale)
      : (text ?? "");
  if (cell !== null && typeof cell === "object") return { ...cell, text: String(date(cell.text)) };
  return typeof cell === "string" ? String(date(cell)) : cell;
}

/** Column alignment for print: the group's own, else money and quantity
 *  columns right-aligned and everything else left. */
function pdfGroupAlign(g: ExportTableGroup): PdfColumnAlign[] | undefined {
  if (g.align) return g.align;
  if (!g.money?.some(Boolean) && !g.numberFormats?.some(Boolean)) return undefined;
  return g.columns.map((_, i) =>
    g.money?.[i] === true || g.numberFormats?.[i] ? "right" : "left",
  );
}

function pdfSummary(s: ReportSummaryItem, locale: string): { label: string; value: string } {
  return {
    label: s.label,
    value:
      typeof s.value === "number"
        ? pdfNum(s.value, locale)
        : s.money === true
          ? pdfMoney(s.value, locale)
          : s.number === true
            ? pdfQuantity(s.value, locale, "number")
            : String(s.value),
  };
}

/** Turn a ReportRunResult into the shared ExportData (title/range from caller). */
export function runResultToExportData(
  result: ReportRunResult,
  opts: { title: string; dateRangeLabel: string },
): ExportData {
  return {
    title: opts.title,
    dateRangeLabel: opts.dateRangeLabel,
    summary: result.summary,
    groups: result.groups.map((g) => ({
      kind: g.kind,
      title: g.title,
      subtitle: g.subtitle,
      columns: g.columns,
      rows: g.rows,
      ...(g.money ? { money: g.money } : {}),
      ...(g.moneyCurrencies ? { moneyCurrencies: g.moneyCurrencies } : {}),
      ...(g.numberFormats ? { numberFormats: g.numberFormats } : {}),
      ...(g.dates ? { dates: g.dates } : {}),
      align: g.align,
      isEmpty: g.isEmpty,
    })),
  };
}

/** Tabular renderers print groups only, so a summary carried solely in
 *  `summary` would vanish from CSV/XLSX — including truncation notices, which
 *  would then read as complete files. Repeat it as trailing footer rows (raw
 *  values, matching the file's own exact-decimal cells). Shared by the
 *  buffered adapter below and the page-streaming exporters, which append the
 *  same rows to their last slot/sheet. */
export function exportSummaryFooterRows(summary: ReportSummaryItem[]): string[][] {
  return summary
    .map((item) =>
      item.value === "" || item.value === null || item.value === undefined
        ? item.label
        : `${item.label}: ${String(item.value)}`,
    )
    .filter((text) => text !== "")
    .map((text) => [text]);
}

/** ExportData → ReportRunResult for Excel/CSV. Flagged money columns retain
 *  the ledger's exact decimal strings so CSV text and XLSX text cells cannot
 *  silently replace them with the nearest IEEE-754 value. */
export function exportDataToRunResult(data: ExportData): ReportRunResult {
  const groups: ReportGroup[] = data.groups.map((g) => ({
    kind: g.kind,
    title: g.title,
    subtitle: g.subtitle,
    columns: g.columns,
    rows: g.rows.map((row) =>
      row.map((cell) => (cell !== null && typeof cell === "object" ? cell.text : cell)),
    ),
    ...(g.money ? { money: g.money } : {}),
    ...(g.moneyCurrencies ? { moneyCurrencies: g.moneyCurrencies } : {}),
    ...(g.numberFormats ? { numberFormats: g.numberFormats } : {}),
    ...(g.dates ? { dates: g.dates } : {}),
    isEmpty: g.isEmpty,
  }));
  const rowCount = data.groups.reduce((n, g) => n + g.rows.length, 0);
  const footers = exportSummaryFooterRows(data.summary);
  if (footers.length > 0) {
    const last = groups[groups.length - 1];
    if (last) last.rows.push(...footers);
    else
      groups.push({
        kind: "results",
        title: data.title,
        columns: [],
        rows: footers,
        isEmpty: false,
      });
  }
  return { groups, summary: data.summary, rowCount };
}

/** ExportData → PDF input (numbers formatted for human reading). */
export function exportDataToPdfInput(
  data: ExportData,
  branding: PdfBranding,
  page: PdfPageSetup,
  opts: {
    showSummary?: boolean;
    generatedAt?: Date;
    footerLeft?: string;
    locale?: string;
    pageLabel?: (page: number, total: number) => string;
  } = {},
): PdfDocumentInput {
  const locale = opts.locale ?? "en";
  const groups: PdfTableGroup[] = data.groups.map((g) => ({
    kind: g.kind,
    title: g.title,
    subtitle: g.subtitle,
    columns: g.columns,
    rows: g.rows.map((row) =>
      row.map((cell, i) =>
        g.dates?.[i] === true
          ? pdfDateCell(cell, locale)
          : formattedPdfCell(cell, locale, g.money?.[i] === true, g.numberFormats?.[i] ?? null),
      ),
    ),
    align: pdfGroupAlign(g),
    isEmpty: g.isEmpty,
  }));
  return {
    title: data.title,
    dateRangeLabel: data.dateRangeLabel,
    generatedAt: opts.generatedAt ?? new Date(),
    branding,
    summary:
      opts.showSummary === false ? undefined : data.summary.map((item) => pdfSummary(item, locale)),
    groups,
    layout: page,
    footerLeft: opts.footerLeft,
    // The header and footer stamps and the page numbering read in the viewer's locale.
    locale,
    pageLabel: opts.pageLabel,
  };
}

export async function exportDataToPdf(
  data: ExportData,
  branding: PdfBranding,
  page: PdfPageSetup,
  opts?: { showSummary?: boolean; generatedAt?: Date },
): Promise<Buffer> {
  const locale = await resolveLocale();
  const t = await getTranslations({ locale, namespace: "reports" });
  return renderPdfDocument(
    exportDataToPdfInput(data, branding, page, {
      ...opts,
      locale,
      pageLabel: (n, total) => t("export.pageOf", { page: n, total }),
    }),
  );
}

/**
 * ExportData → .xlsx. `money` names the currency the report's money is in
 * and the registry's minor units (see xlsxMoneyContext); null declares an
 * export with no money columns.
 */
export async function exportDataToXlsx(
  data: ExportData,
  opts: {
    reportName: string;
    dateRangeLabel?: string;
    generatedAt?: Date;
    money: XlsxMoneyContext | null;
  },
): Promise<Buffer> {
  return reportResultToXlsx(exportDataToRunResult(data), opts);
}

export function exportDataToCsv(data: ExportData, opts: { sectionHeader?: string }): string {
  return reportResultToCsv(exportDataToRunResult(data), opts);
}

// --- financial-statement adapters ------------------------------------------
// Each returns an ExportData with exact money strings. Financial aggregation
// and every export adapter therefore remain exact through the final cell.
// Section/group titles and column headers come through the reports translator
// (keys under reports.* — see web/messages/<locale>/reports.json).

function indent(d: number): string {
  return d > 0 ? " ".repeat(d * 2) : "";
}

export function projectProfitabilityExportData(
  result: {
    rows: {
      projectId: string;
      projectName: string;
      customerName: string | null;
      revenue: ExactDecimal;
      cogs: ExactDecimal;
      grossProfit: ExactDecimal;
      expenses: ExactDecimal;
      net: ExactDecimal;
      margin: ExactDecimal | null;
      hours: number;
    }[];
    customers: {
      customerId: string | null;
      customerName: string | null;
      rows: {
        projectId: string;
        projectName: string;
        revenue: ExactDecimal;
        cogs: ExactDecimal;
        grossProfit: ExactDecimal;
        expenses: ExactDecimal;
        net: ExactDecimal;
        margin: ExactDecimal | null;
        hours: number;
      }[];
      totals: {
        revenue: ExactDecimal;
        cogs: ExactDecimal;
        grossProfit: ExactDecimal;
        expenses: ExactDecimal;
        net: ExactDecimal;
        margin: ExactDecimal | null;
        hours: number;
      };
    }[];
    totals: {
      revenue: ExactDecimal;
      cogs: ExactDecimal;
      grossProfit: ExactDecimal;
      expenses: ExactDecimal;
      net: ExactDecimal;
      margin: ExactDecimal | null;
      hours: number;
    };
    from: string;
    to: string;
  },
  t: Translator,
): ExportData {
  // Margins are canonical decimalRatio ratios (0.2500 = 25%). Scale exactly
  // once through the shared helper so the export prints what the table
  // displays; toFixed(1) then only formats the already-scaled percent units.
  const pct = (m: ExactDecimal | null) =>
    m === null ? "" : `${decimalToNumber(marginRatioToPercent(m)).toFixed(1)}%`;
  const cols = [
    t("projectProfitability.columns.customerJob"),
    t("projectProfitability.columns.revenue"),
    t("projectProfitability.columns.cogs"),
    t("projectProfitability.columns.grossProfit"),
    t("projectProfitability.columns.expenses"),
    t("projectProfitability.columns.net"),
    t("projectProfitability.columns.margin"),
    t("projectProfitability.columns.hours"),
  ];
  // The Unassigned tie-out bucket keeps its translated label in exports (the
  // data row carries the English fallback; the view layer localizes it).
  const unassignedLabel = t("projectProfitability.unassignedProject");
  const data = result.customers.flatMap(
    (customer) =>
      [
        [
          isUnassignedProjectGroup(customer)
            ? unassignedLabel
            : (customer.customerName ?? t("projectProfitability.noCustomer")),
          customer.totals.revenue,
          customer.totals.cogs,
          customer.totals.grossProfit,
          customer.totals.expenses,
          customer.totals.net,
          pct(customer.totals.margin),
          customer.totals.hours,
        ],
        ...customer.rows.map((row) => [
          `  ${row.projectId === UNASSIGNED_PROJECT_ID ? unassignedLabel : row.projectName}`,
          row.revenue,
          row.cogs,
          row.grossProfit,
          row.expenses,
          row.net,
          pct(row.margin),
          row.hours,
        ]),
      ] as (string | number)[][],
  );
  data.push([
    t("trialBalance.totals"),
    result.totals.revenue,
    result.totals.cogs,
    result.totals.grossProfit,
    result.totals.expenses,
    result.totals.net,
    pct(result.totals.margin),
    result.totals.hours,
  ]);
  return {
    title: t("projectProfitability.title"),
    dateRangeLabel: t("pnl.dateRange", { from: result.from, to: result.to }),
    summary: [
      {
        label: t("projectProfitability.columns.revenue"),
        value: result.totals.revenue,
        money: true,
      },
      { label: t("projectProfitability.columns.net"), value: result.totals.net, money: true },
    ],
    groups: [
      {
        kind: "results",
        title: t("projectProfitability.title"),
        columns: cols,
        rows: data,
        align: ["left", "right", "right", "right", "right", "right", "right", "right"],
        money: [false, true, true, true, true, true, false, false],
      },
    ],
  };
}

export function trialBalanceExportData(
  rows: {
    id?: string;
    number: string | null;
    name: string;
    type: string;
    debits: string;
    credits: string;
    balance: string;
  }[],
  asOf: string,
  t: Translator,
): ExportData {
  const data = rows.map(
    (r) =>
      [
        r.number ?? "",
        r.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID
          ? t("statement.retainedEarningsPrior")
          : r.name,
        r.debits,
        r.credits,
        r.balance,
      ] as (string | number)[],
  );
  const totalDebits = decimalSum(rows.map((row) => row.debits));
  const totalCredits = decimalSum(rows.map((row) => row.credits));
  const totalBalance = decimalSum(rows.map((row) => row.balance));
  data.push(["", t("trialBalance.totals"), totalDebits, totalCredits, totalBalance]);
  return {
    title: t("trialBalance.title"),
    dateRangeLabel: t("trialBalance.description", { date: asOf, count: rows.length }),
    summary: [
      { label: t("trialBalance.columns.debits"), value: totalDebits, money: true },
      { label: t("trialBalance.columns.credits"), value: totalCredits, money: true },
    ],
    groups: [
      {
        kind: "results",
        title: t("trialBalance.title"),
        columns: [
          t("export.columns.accountNumber"),
          t("export.columns.accountName"),
          t("trialBalance.columns.debits"),
          t("trialBalance.columns.credits"),
          t("export.columns.balance"),
        ],
        rows: data,
        align: ["left", "left", "right", "right", "right"],
        money: [false, false, true, true, true],
      },
    ],
  };
}

export function partnersExportData(
  kind: "receivable" | "payable",
  rows: {
    id: string | null;
    display_name: string | null;
    balance: string;
    line_count: string;
    latest_due: string | null;
  }[],
  t: Translator,
): ExportData {
  const title =
    kind === "receivable" ? t("partners.receivablesTitle") : t("partners.payablesTitle");
  const total = decimalSum(rows.map((row) => row.balance));
  const data = rows.map(
    (r) =>
      [
        r.display_name ?? t("partners.noPartyOnLines"),
        r.balance,
        Number(r.line_count),
        r.latest_due ?? "",
      ] as (string | number)[],
  );
  return {
    title,
    dateRangeLabel: t("partners.description"),
    summary: [
      { label: t("partners.totalOutstanding"), value: total, money: true },
      { label: t("partners.partiesWithBalance"), value: rows.length },
    ],
    groups: [
      {
        kind: "results",
        title,
        columns: [
          t("export.columns.party"),
          t("partners.columns.outstanding"),
          t("partners.columns.glLines"),
          t("export.columns.latestDue"),
        ],
        rows: data,
        align: ["left", "right", "right", "left"],
        money: [false, true, false, false],
      },
    ],
  };
}

export function agingExportData(
  side: "ar" | "ap",
  result: {
    rows: {
      partyName: string | null;
      reconciling?: boolean;
      current: ExactDecimal;
      b1: ExactDecimal;
      b2: ExactDecimal;
      b3: ExactDecimal;
      b4: ExactDecimal;
      total: ExactDecimal;
    }[];
    totals: {
      current: ExactDecimal;
      b1: ExactDecimal;
      b2: ExactDecimal;
      b3: ExactDecimal;
      b4: ExactDecimal;
      total: ExactDecimal;
    };
    asOf: string;
  },
  t: Translator,
): ExportData {
  const title = side === "ar" ? t("aging.receivablesTitle") : t("aging.payablesTitle");
  const cols = [
    t("export.columns.party"),
    t("aging.buckets.current"),
    t("aging.buckets.b1"),
    t("aging.buckets.b2"),
    t("aging.buckets.b3"),
    t("aging.buckets.b4"),
    t("aging.columns.total"),
  ];
  const data = result.rows.map(
    (r) =>
      [
        r.reconciling ? t("aging.controlEntries.label") : (r.partyName ?? t("aging.noParty")),
        r.current,
        r.b1,
        r.b2,
        r.b3,
        r.b4,
        r.total,
      ] as (string | number)[],
  );
  data.push([
    t("trialBalance.totals"),
    result.totals.current,
    result.totals.b1,
    result.totals.b2,
    result.totals.b3,
    result.totals.b4,
    result.totals.total,
  ]);
  return {
    title,
    dateRangeLabel: t("aging.asOf", { date: result.asOf }),
    summary: [{ label: t("aging.columns.total"), value: result.totals.total, money: true }],
    groups: [
      {
        kind: "results",
        title,
        columns: cols,
        rows: data,
        align: ["left", "right", "right", "right", "right", "right", "right"],
        money: [false, true, true, true, true, true, true],
      },
    ],
  };
}

export function agingDetailExportData(
  side: "ar" | "ap",
  result: {
    rows: Pick<
      AgingDetailRow,
      | "partyName"
      | "reference"
      | "dueDate"
      | "ageBasisDate"
      | "ageBasisSource"
      | "ageDays"
      | "bucket"
      | "open"
      | "docCurrency"
      | "txnOpen"
    >[];
    totals: {
      current: ExactDecimal;
      b1: ExactDecimal;
      b2: ExactDecimal;
      b3: ExactDecimal;
      b4: ExactDecimal;
      total: ExactDecimal;
    };
    asOf: string;
  },
  t: Translator,
): ExportData {
  const title = side === "ar" ? t("aging.receivablesTitle") : t("aging.payablesTitle");
  const bucketLabel = (bucket: "current" | "b1" | "b2" | "b3" | "b4") =>
    t(`aging.buckets.${bucket}`);
  const rows = result.rows.map(
    (row) =>
      [
        row.partyName ?? t("aging.noParty"),
        row.reference ?? "",
        row.dueDate ?? "",
        row.ageBasisDate,
        t(`aging.dateSources.${row.ageBasisSource}`),
        row.ageDays,
        bucketLabel(row.bucket),
        row.open,
        row.docCurrency,
        row.txnOpen,
      ] as (string | number)[],
  );
  rows.push([t("trialBalance.totals"), "", "", "", "", "", "", result.totals.total, "", ""]);
  return {
    title,
    dateRangeLabel: t("aging.asOf", { date: result.asOf }),
    summary: [{ label: t("aging.columns.total"), value: result.totals.total, money: true }],
    groups: [
      {
        kind: "results",
        title,
        columns: [
          t("export.columns.party"),
          t("export.columns.type"),
          t("aging.columns.due"),
          t("aging.columns.ageBasisDate"),
          t("aging.columns.ageBasisSource"),
          t("aging.columns.age"),
          t("aging.columns.bucket"),
          t("aging.columns.total"),
          t("aging.columns.currency"),
          t("aging.columns.txnOpen"),
        ],
        rows,
        align: ["left", "left", "left", "left", "left", "right", "left", "right", "left", "right"],
        money: [false, false, false, false, false, false, false, true, false, true],
      },
    ],
  };
}

export function cashFlowExportData(
  cf: {
    sections: {
      section: string;
      lines: { type: string; label: string; amount: ExactDecimal }[];
      subtotal: ExactDecimal;
    }[];
    fxEffectOnCash: ExactDecimal;
    netChange: ExactDecimal;
    openingCash: ExactDecimal;
    closingCash: ExactDecimal;
  },
  from: string,
  to: string,
  t: Translator,
): ExportData {
  const sectionLabel = (s: string) => t(`cashFlow.sections.${s}`);
  const groups: ExportTableGroup[] = cf.sections.map((s) => {
    const label = sectionLabel(s.section);
    return {
      kind: "section",
      title: label,
      columns: [t("export.columns.type"), t("export.columns.amount")],
      rows: [
        ...s.lines.map((l) => [l.label, l.amount] as (string | number)[]),
        // Same placement as the indirect export: the FX-effect line rides the
        // financing group while financingTotal stays section-pure.
        ...(s.section === "financing" && decimalIsMaterial(cf.fxEffectOnCash)
          ? [[t("cashFlow.fxEffect"), cf.fxEffectOnCash] as (string | number)[]]
          : []),
        [t("cashFlow.subtotal", { section: label }), s.subtotal] as (string | number)[],
      ],
      align: ["left", "right"],
      money: [false, true],
    };
  });
  return {
    title: t("cashFlow.title"),
    dateRangeLabel: t("cashFlow.dateRange", { from, to }),
    summary: [
      { label: t("cashFlow.openingCash"), value: cf.openingCash, money: true },
      { label: t("cashFlow.netChange"), value: cf.netChange, money: true },
      { label: t("cashFlow.closingCash"), value: cf.closingCash, money: true },
    ],
    groups,
  };
}

export function cashFlowIndirectExportData(
  cf: {
    netIncome: ExactDecimal;
    adjustments: { key: string; label?: string; amount: ExactDecimal }[];
    workingCapital: { name: string; number: string | null; amount: ExactDecimal }[];
    operating: ExactDecimal;
    investing: { name: string; number: string | null; amount: ExactDecimal }[];
    investingTotal: ExactDecimal;
    financing: { name: string; number: string | null; amount: ExactDecimal }[];
    financingTotal: ExactDecimal;
    fxEffectOnCash: ExactDecimal;
    netChange: ExactDecimal;
    openingCash: ExactDecimal;
    closingCash: ExactDecimal;
  },
  from: string,
  to: string,
  t: Translator,
): ExportData {
  const line = (l: { name: string; number: string | null; amount: ExactDecimal }) =>
    [`${l.number ? `${l.number} · ` : ""}${l.name}`, l.amount] as (string | number)[];
  const groups: ExportTableGroup[] = [
    {
      kind: "section",
      title: t("cashFlowIndirect.sections.operating"),
      columns: [t("export.columns.accountName"), t("export.columns.amount")],
      rows: [
        [t("cashFlowIndirect.netIncome"), cf.netIncome],
        ...cf.adjustments.map(
          (a) =>
            [a.label ?? t(`cashFlowIndirect.adjustments.${a.key}`), a.amount] as (
              string | number
            )[],
        ),
        ...cf.workingCapital.map(line),
        [t("cashFlowIndirect.subtotals.operating"), cf.operating],
      ],
      align: ["left", "right"],
      money: [false, true],
    },
    {
      kind: "section",
      title: t("cashFlowIndirect.sections.investing"),
      columns: [t("export.columns.accountName"), t("export.columns.amount")],
      rows: [
        ...cf.investing.map(line),
        [t("cashFlowIndirect.subtotals.investing"), cf.investingTotal],
      ],
      align: ["left", "right"],
      money: [false, true],
    },
    {
      kind: "section",
      title: t("cashFlowIndirect.sections.financing"),
      columns: [t("export.columns.accountName"), t("export.columns.amount")],
      rows: [
        ...cf.financing.map(line),
        ...(decimalIsMaterial(cf.fxEffectOnCash)
          ? [[t("cashFlowIndirect.fxEffect"), cf.fxEffectOnCash] as (string | number)[]]
          : []),
        [t("cashFlowIndirect.subtotals.financing"), cf.financingTotal],
      ],
      align: ["left", "right"],
      money: [false, true],
    },
  ];
  return {
    title: t("cashFlowIndirect.title"),
    dateRangeLabel: t("cashFlowIndirect.dateRange", { from, to }),
    summary: [
      { label: t("cashFlowIndirect.openingCash"), value: cf.openingCash, money: true },
      { label: t("cashFlowIndirect.netChange"), value: cf.netChange, money: true },
      { label: t("cashFlowIndirect.closingCash"), value: cf.closingCash, money: true },
    ],
    groups,
  };
}

// --- multi-column statement view (P&L / Balance Sheet) ----------------------
// The new matrix engine produces a StatementView (columns + typed lines). These
// adapters render it as a professional statement PDF, and flatten it for the
// existing XLSX/CSV pipeline.

function scaleForExport(scale: "actual" | "thousands" | "millions"): {
  divisor: number;
  note: string;
} {
  if (scale === "thousands") return { divisor: 1000, note: "In thousands" };
  if (scale === "millions") return { divisor: 1_000_000, note: "In millions" };
  return { divisor: 1, note: "" };
}

/** Render a StatementView to a professional statement PDF Buffer. */
export async function renderStatementViewPdf(
  view: StatementView,
  branding: PdfBranding & { reportPdfStyle: StatementPdfStyle; baseCurrency: string },
  page: PdfPageSetup,
  opts: {
    title: string;
    periodPhrase: string;
    scale: "actual" | "thousands" | "millions";
    generatedAt?: Date;
  },
): Promise<Buffer> {
  const { divisor, note } = scaleForExport(opts.scale);
  const locale = await resolveLocale();
  const t = await getTranslations({ locale, namespace: "reports" });
  return renderStatementPdf({
    companyName: branding.orgName,
    title: opts.title,
    periodPhrase: opts.periodPhrase,
    scaleNote: note || undefined,
    decimals: divisor === 1 ? undefined : 0,
    locale,
    currency: branding.baseCurrency,
    columns: view.columns.map((c) => ({
      label: c.group ? `${c.group} · ${c.label}` : c.label,
      kind: c.kind,
    })),
    rows: view.lines.map((l) => ({
      kind: l.kind,
      label: l.label,
      indent: l.kind === "account" ? l.depth : 0,
      values: l.values?.map((v, i) =>
        view.columns[i]!.kind === "variance_pct"
          ? (v ?? null)
          : v == null
            ? null
            : divisor === 1
              ? v
              : decimalScaleWhole(v, divisor),
      ),
    })),
    style: branding.reportPdfStyle,
    branding,
    page,
    generatedAt: opts.generatedAt ?? new Date(),
    pageLabel: (n, total) => t("export.pageOf", { page: n, total }),
    footnote: divisor !== 1 ? "Amounts are rounded; columns may not sum exactly." : undefined,
  });
}

/** A StatementView → a properly-formatted statement .xlsx: real cell
 *  indentation, bold section/subtotal/total rows with rules, accounting number
 *  formats. Numbers stay raw (unscaled) — a spreadsheet wants real figures. */
export async function statementViewToXlsx(
  view: StatementView,
  opts: {
    company: string;
    title: string;
    periodPhrase: string;
    accountLabel: string;
    note?: string;
    generatedAt?: Date;
  },
): Promise<Buffer> {
  return statementSheetToXlsx(
    {
      company: opts.company,
      title: opts.title,
      periodPhrase: opts.periodPhrase,
      note: opts.note,
      accountLabel: opts.accountLabel,
      columns: view.columns.map((c) => ({
        label: c.group ? `${c.group} · ${c.label}` : c.label,
        kind: c.kind,
      })),
      rows: view.lines.map((l) => ({
        kind: l.kind,
        label: l.label,
        indent: l.depth,
        values: l.values?.map((v) => v ?? null),
      })),
    },
    { generatedAt: opts.generatedAt },
  );
}

/** Flatten a StatementView into ExportData (one table) for XLSX/CSV. Amount
 *  columns are flagged money and keep their exact decimal strings; the account
 *  column is indented to preserve hierarchy. */
export function statementViewToExportData(
  view: StatementView,
  opts: { title: string; dateRangeLabel: string; accountLabel: string },
): ExportData {
  const columns = [
    opts.accountLabel,
    ...view.columns.map((c) => (c.group ? `${c.group} · ${c.label}` : c.label)),
  ];
  const rows: (string | number | null)[][] = view.lines.map((l) => {
    const label = l.kind === "account" ? `${indent(l.depth)}${l.label}` : l.label;
    if (!l.values) return [label, ...view.columns.map(() => null)];
    return [label, ...l.values.map((v) => v ?? null)];
  });
  return {
    title: opts.title,
    dateRangeLabel: opts.dateRangeLabel,
    summary: [],
    groups: [
      {
        kind: "results",
        title: opts.title,
        columns,
        rows,
        align: ["left", ...view.columns.map(() => "right" as PdfColumnAlign)],
        money: [false, ...view.columns.map((c) => c.kind !== "variance_pct")],
      },
    ],
  };
}

// --- detail-report adapters (General Ledger, Journal, Registers, Statement) --

import type { JournalReportResult, RegisterResult, PartnerStatementResult } from "./reports";
import { UNASSIGNED_PROJECT_ID, isUnassignedProjectGroup } from "./reports/projects";

export function journalExportData(
  j: JournalReportResult,
  title: string,
  t: Translator,
): ExportData {
  const columns = [
    t("generalLedger.columns.entry"),
    t("generalLedger.columns.date"),
    t("export.columns.accountName"),
    t("journal.columns.detail"),
    t("trialBalance.columns.debits"),
    t("trialBalance.columns.credits"),
  ];
  const rows: (string | number | null)[][] = [];
  for (const e of j.entries) {
    for (const l of e.lines) {
      rows.push([
        e.entryNumber ?? "",
        e.date,
        `${l.accountNumber ?? ""} ${l.accountName}`.trim(),
        [l.party, l.memo].filter(Boolean).join(" · "),
        decimalIsZero(l.debit) ? null : l.debit,
        decimalIsZero(l.credit) ? null : l.credit,
      ]);
    }
  }
  return {
    title,
    dateRangeLabel: t("pnl.dateRange", { from: j.from, to: j.to }),
    summary: j.truncated ? [{ label: t("journal.truncated"), value: "" }] : [],
    groups: [
      {
        kind: "results",
        title,
        columns,
        rows,
        align: ["left", "left", "left", "left", "right", "right"],
        money: [false, false, false, false, true, true],
      },
    ],
  };
}

export function registerExportData(reg: RegisterResult, title: string, t: Translator): ExportData {
  const columns = [
    t("export.columns.party"),
    t("generalLedger.columns.date"),
    t("generalLedger.columns.entry"),
    t("trialBalance.columns.debits"),
    t("trialBalance.columns.credits"),
    t("export.columns.balance"),
  ];
  const rows: (string | number | null)[][] = [];
  for (const pt of reg.parties) {
    const name = pt.partyName ?? "—";
    rows.push([name, "", t("generalLedger.opening"), null, null, pt.opening]);
    for (const l of pt.lines)
      rows.push([
        name,
        l.date,
        l.entryNumber ?? "",
        decimalIsZero(l.debit) ? null : l.debit,
        decimalIsZero(l.credit) ? null : l.credit,
        l.balance,
      ]);
    rows.push([name, "", t("registers.closing"), null, null, pt.closing]);
  }
  return {
    title,
    dateRangeLabel: t("pnl.dateRange", { from: reg.from, to: reg.to }),
    summary: reg.truncated ? [{ label: t("registers.truncated"), value: "" }] : [],
    groups: [
      {
        kind: "results",
        title,
        columns,
        rows,
        align: ["left", "left", "left", "right", "right", "right"],
        money: [false, false, false, true, true, true],
      },
    ],
  };
}

export function partnerStatementExportData(st: PartnerStatementResult, t: Translator): ExportData {
  const title = st.party.name ?? t("statements.title");
  const columns = [
    t("generalLedger.columns.date"),
    t("generalLedger.columns.entry"),
    t("trialBalance.columns.debits"),
    t("trialBalance.columns.credits"),
    t("export.columns.balance"),
  ];
  const rows: (string | number | null)[][] = [
    ["", t("statements.opening"), null, null, st.opening],
  ];
  for (const l of st.lines)
    rows.push([
      l.date,
      l.entryNumber ?? "",
      decimalIsZero(l.debit) ? null : l.debit,
      decimalIsZero(l.credit) ? null : l.credit,
      l.balance,
    ]);
  rows.push(["", t("statements.closing"), null, null, st.closing]);
  return {
    title,
    dateRangeLabel: t("pnl.dateRange", { from: st.from, to: st.to }),
    summary: [
      ...(st.truncated ? [{ label: t("registers.truncated"), value: "" }] : []),
      { label: t("aging.buckets.current"), value: st.aging.current, money: true },
      { label: t("aging.buckets.b1"), value: st.aging.b1, money: true },
      { label: t("aging.buckets.b2"), value: st.aging.b2, money: true },
      { label: t("aging.buckets.b3"), value: st.aging.b3, money: true },
      { label: t("aging.buckets.b4"), value: st.aging.b4, money: true },
      { label: t("aging.columns.total"), value: st.aging.total, money: true },
    ],
    groups: [
      {
        kind: "results",
        title,
        columns,
        rows,
        align: ["left", "left", "right", "right", "right"],
        money: [false, false, true, true, true],
      },
    ],
  };
}

// Re-export the run-result label bridge so the export route can localize CSV.
export type { ReportRunLabels };
