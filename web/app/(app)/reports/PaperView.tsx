"use client";

import Link from "next/link";
import { useFormatter, useLocale } from "next-intl";
import { useMoney } from "@/components/money-provider";
import { formatCivilDate, formatExactPercent } from "@/lib/format";
import { formatDecimal } from "@/lib/money-format";
import { cn } from "@openbooks/ui";
import {
  perShareFractionDigits,
  type ReportCellLink,
  type ReportNumberFormat,
} from "@openbooks/reports";
import { ReportPaper } from "./ReportPaper";
import { ReportDrillLink } from "./ReportDrillLink";
import { TxnLink } from "./TxnLink";
import type { ReportDrillTarget } from "../../../lib/report-drill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  reportTotalRowClass,
} from "./ReportTable";

/**
 * The ONE on-screen renderer for the unified report shape — the common
 * `{ title, groups }` contract that BOTH engines emit (statements via
 * statementViewToExportData, custom reports via ReportRunResult). It draws the
 * result as a printed "sheet of paper" (centred company/title/period header,
 * section tables, right-aligned tabular numbers) so the in-app view matches the
 * PDF. Used by the report editor's live preview AND the standard report pages,
 * so standard and custom reports look identical.
 *
 * Fidelity for statement pages: optional per-cell drill `links`, per-column
 * `money` flags (currency-formatted), per-column `numberFormats` (exact
 * quantities in the viewer's digits and separators), and negative colouring —
 * so a flattened page keeps its drill-through and polish.
 */

export type PaperCell = string | number | null | undefined;

export type PaperGroup = {
  title?: string;
  subtitle?: string;
  columns: string[];
  rows: PaperCell[][];
  /** Explanation for undefined formula cells, aligned to the rendered rows. */
  undefinedCells?: (string | null)[][];
  align?: ("left" | "right" | "center")[];
  /** Per-column: format the cell as currency (else plain number/text). */
  money?: boolean[];
  /** Per-column: an exact quantity ('number') or percentage points ('percent'). */
  numberFormats?: (ReportNumberFormat | null)[];
  /** Per-column: ISO calendar dates, read in the viewer's locale. */
  dates?: boolean[];
  /** Per-cell drill href (parallel to `rows`); null/absent ⇒ plain cell. */
  links?: (string | null | undefined)[][];
  /** Per-cell report drill target (parallel to `rows`). */
  drills?: (ReportDrillTarget | null | undefined)[][];
  /** Per-cell native record navigation supplied by the report engine. */
  cellLinks?: (ReportCellLink | null)[][];
  /** Group-level drill fallback for numeric cells (e.g. scoped to this
   *  section's rows); wins over the paper-wide defaultDrillTarget. */
  drillTarget?: ReportDrillTarget;
  /** Explicit total row. Ordinary custom result sets must not style their last data row as a total. */
  totalRowIndex?: number;
  /** Multiple subtotal/total rows (sectioned-summarize level totals). */
  totalRows?: number[];
  isEmpty?: boolean;
};

export type PaperData = {
  title: string;
  periodPhrase?: string;
  note?: string;
  summary?: { label: string; value: PaperCell; money?: boolean; number?: boolean }[];
  groups: PaperGroup[];
  /** Custom reports use one source-row drill target for every numeric result. */
  defaultDrillTarget?: ReportDrillTarget;
};

function isNumericCell(v: PaperCell): boolean {
  if (typeof v === "number") return true;
  if (typeof v !== "string") return false;
  return /^-?[$(]?-?[\d,]+(\.\d+)?\)?%?$/.test(v.trim());
}

const EXACT_QUANTITY = /^-?\d+(?:\.(\d+))?$/;

/** An exact quantity in the viewer's locale at its own decimal places, or
 *  null when the cell is not a plain decimal (it then renders as written). */
export function paperQuantity(
  value: PaperCell,
  locale: string,
  format: ReportNumberFormat,
): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  const match = EXACT_QUANTITY.exec(text);
  if (!match) return null;
  const places = format === "per_share" ? perShareFractionDigits(text) : (match[1]?.length ?? 0);
  return format === "percent"
    ? formatExactPercent(text, locale, places)
    : formatDecimal(locale, text, { minimumFractionDigits: places, maximumFractionDigits: places });
}

export function PaperView({
  company,
  data,
  emptyLabel,
  currency = "",
}: {
  company: string;
  data: PaperData;
  emptyLabel: string;
  currency?: string;
}) {
  const format = useFormatter();
  const locale = useLocale();
  const { money } = useMoney();
  const fmt = (
    value: PaperCell,
    isMoney: boolean,
    numberFormat?: ReportNumberFormat | null,
    isDate = false,
  ): string => {
    if (value === null || value === undefined || value === "") return "";
    if (isDate && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
      return formatCivilDate(value, locale);
    if (isMoney) return money(value, { currency: currency || undefined, accounting: true });
    const quantity = numberFormat ? paperQuantity(value, locale, numberFormat) : null;
    if (quantity !== null) return quantity;
    if (typeof value === "number") return format.number(value, { maximumFractionDigits: 2 });
    return value;
  };
  const wide = data.groups.some((group) => group.columns.length > 5);
  return (
    <ReportPaper
      company={company}
      title={data.title}
      periodPhrase={data.periodPhrase}
      note={data.note}
      wide={wide}
    >
      {data.summary?.length ? (
        <div className="mb-6 grid grid-flow-col auto-cols-fr divide-x divide-slate-200 border-y border-slate-200 py-3 dark:divide-slate-700 dark:border-slate-700">
          {data.summary.map((item, index) => (
            <div key={index} className="min-w-0 px-3 text-center">
              <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                {item.label}
              </div>
              <div className="truncate font-semibold tabular-nums">
                {data.defaultDrillTarget && isNumericCell(item.value) ? (
                  <ReportDrillLink
                    target={data.defaultDrillTarget}
                    className="hover:text-teal-700 hover:underline dark:hover:text-teal-300"
                  >
                    {fmt(item.value, item.money === true, item.number === true ? "number" : null)}
                  </ReportDrillLink>
                ) : (
                  fmt(item.value, item.money === true, item.number === true ? "number" : null)
                )}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="space-y-7">
        {data.groups.map((group, gi) => {
          const showTitle = group.title && (data.groups.length > 1 || !!group.subtitle);
          const alignOf = (ci: number, cell: PaperCell): "left" | "right" | "center" =>
            group.align?.[ci] ?? (isNumericCell(cell) ? "right" : "left");
          return (
            <section key={gi} className="space-y-1.5">
              {showTitle ? (
                <div className="flex items-baseline gap-2">
                  <h3 className="pt-2 text-xs font-semibold tracking-wide uppercase">
                    {group.title}
                  </h3>
                  {group.subtitle ? (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {group.subtitle}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {group.isEmpty || group.rows.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-400 italic">{emptyLabel}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      {group.columns.map((c, ci) => (
                        <TableHead
                          key={ci}
                          className={cn(
                            (group.align?.[ci] ?? (ci === 0 ? "left" : "right")) === "right"
                              ? "text-right"
                              : "text-left",
                          )}
                        >
                          {c}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.rows.map((row, ri) => {
                      const total =
                        group.totalRowIndex === ri || group.totalRows?.includes(ri) === true;
                      return (
                        <TableRow
                          key={ri}
                          className={cn(total && reportTotalRowClass, total && "font-semibold")}
                        >
                          {row.map((cell, ci) => {
                            const a = alignOf(ci, cell);
                            const isMoney = !!group.money?.[ci];
                            const negative = typeof cell === "number" && cell < 0;
                            const href = group.links?.[ri]?.[ci];
                            const cellLink = group.cellLinks?.[ri]?.[ci];
                            const undefinedLabel = group.undefinedCells?.[ri]?.[ci] ?? undefined;
                            const drill =
                              group.drills?.[ri]?.[ci] ??
                              (isNumericCell(cell)
                                ? (group.drillTarget ?? data.defaultDrillTarget)
                                : undefined);
                            const text = fmt(
                              cell,
                              isMoney,
                              group.numberFormats?.[ci],
                              group.dates?.[ci] === true,
                            );
                            return (
                              <TableCell
                                key={ci}
                                aria-label={undefinedLabel}
                                className={cn(
                                  a === "right" && "text-right tabular-nums",
                                  a === "center" && "text-center",
                                  negative && "text-red-600 dark:text-red-400",
                                  undefinedLabel && "text-slate-400 dark:text-slate-500",
                                )}
                              >
                                {cellLink?.kind === "transaction" ? (
                                  <TxnLink
                                    target={cellLink}
                                    className="hover:text-teal-700 hover:underline dark:hover:text-teal-300"
                                  >
                                    {text}
                                  </TxnLink>
                                ) : drill ? (
                                  <ReportDrillLink
                                    target={drill}
                                    className="hover:text-teal-700 hover:underline dark:hover:text-teal-300"
                                  >
                                    {text}
                                  </ReportDrillLink>
                                ) : href ? (
                                  <Link
                                    href={href}
                                    className="hover:text-teal-700 hover:underline dark:hover:text-teal-300"
                                  >
                                    {text}
                                  </Link>
                                ) : (
                                  text
                                )}
                              </TableCell>
                            );
                          })}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </section>
          );
        })}
      </div>
    </ReportPaper>
  );
}
