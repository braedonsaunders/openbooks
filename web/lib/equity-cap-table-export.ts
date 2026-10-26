import type { CapTableView } from "@openbooks/engine/equity";
import { capTableLayout, type CapTableColumn, type CapTableFilters } from "./equity-cap-table";
import type { ExportData } from "./report-pdf";

export type CapTableExportFormat = "pdf" | "xlsx" | "csv";

export interface CapTableExportLabels {
  title: string;
  dateRange: string;
  class: string;
  kind: (kind: "common" | "preferred") => string;
  holder: string;
  /** The holder basis's unallocated pool line. */
  pool: string;
  /** A measure column's header, by the cap table's column key. */
  column: (key: Exclude<CapTableColumn["key"], `class:${string}`>) => string;
  total: string;
}

/**
 * The export of the cap table exactly as the page shows it: the same as-of
 * date and the same filters (view, instrument and search) travel to it.
 */
export function capTableExportHref(
  subsidiaryId: string,
  asOf: string,
  filters: CapTableFilters,
): string {
  const query = new URLSearchParams({ subsidiaryId, asOf, by: filters.dimension });
  if (filters.instrument !== "all") query.set("instrument", filters.instrument);
  if (filters.query) query.set("q", filters.query);
  return `/api/equity/cap-table/export?${query}`;
}

/**
 * The as-of cap table as export data, built from the same layout the page
 * renders for the same filters: its lines, its columns and its totals row.
 * Share counts and percentages travel as the exact strings the engine
 * computed, typed as quantities: the PDF prints them in the viewer's locale,
 * Excel stores numeric cells, and CSV keeps the plain values (percentages as
 * percentage points under a "%" heading).
 */
export function capTableExportData(
  view: CapTableView,
  filters: CapTableFilters,
  labels: CapTableExportLabels,
): ExportData {
  const { table } = view;
  const layout = capTableLayout(table, filters, view.parties);
  const classes = new Map(table.classes.map((row) => [row.shareClassId, row]));
  const header = (column: CapTableColumn) =>
    "code" in column
      ? column.code
      : labels.column(column.key as Exclude<CapTableColumn["key"], `class:${string}`>);
  const value = (raw: string | undefined) => raw ?? "";
  const rows = layout.lines.map((line) => {
    const shareClass = line.shareClassId ? classes.get(line.shareClassId) : undefined;
    const lead = line.pool
      ? labels.pool
      : shareClass
        ? `${shareClass.code} · ${shareClass.name} (${labels.kind(shareClass.kind)})`
        : (view.parties[line.holderPartyId ?? ""] ?? line.holderPartyId ?? "");
    return [lead, ...layout.columns.map((column) => value(line.values[column.key]))];
  });
  const totals =
    layout.lines.length > 0 && Object.keys(layout.totals).length > 0
      ? [[labels.total, ...layout.columns.map((column) => layout.totals[column.key] ?? "")]]
      : [];
  return {
    title: labels.title,
    dateRangeLabel: labels.dateRange,
    summary: [],
    groups: [
      {
        kind: "results",
        title: labels.title,
        columns: [
          filters.dimension === "class" ? labels.class : labels.holder,
          ...layout.columns.map(header),
        ],
        rows: [...rows, ...totals],
        align: ["left", ...layout.columns.map(() => "right" as const)],
        numberFormats: [
          null,
          ...layout.columns.map((column) =>
            column.kind === "percent" ? ("percent" as const) : ("number" as const),
          ),
        ],
      },
    ],
  };
}
