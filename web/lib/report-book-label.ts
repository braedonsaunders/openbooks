import type { ExportData } from "./report-pdf";

/** CSV has no paper header, so its accounting basis travels with each row. */
export function withReportBookColumn(
  data: ExportData,
  book: { label: string; value: string },
): ExportData {
  return {
    ...data,
    groups: data.groups.map((group) => ({
      ...group,
      columns: [book.label, ...group.columns],
      rows: group.rows.map((row) => [book.value, ...row]),
      ...(group.money ? { money: [false, ...group.money] } : {}),
      // A currency carried in another column moves one place with it.
      ...(group.moneyCurrencies
        ? {
            moneyCurrencies: [
              null,
              ...group.moneyCurrencies.map((spec) =>
                spec && typeof spec === "object" ? { column: spec.column + 1 } : spec,
              ),
            ],
          }
        : {}),
      ...(group.numberFormats ? { numberFormats: [null, ...group.numberFormats] } : {}),
      ...(group.dates ? { dates: [false, ...group.dates] } : {}),
      ...(group.align ? { align: ["left" as const, ...group.align] } : {}),
    })),
  };
}
