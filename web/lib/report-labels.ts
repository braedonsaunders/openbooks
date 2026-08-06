import "server-only";
import { getTranslations } from "next-intl/server";
import type { ReportRunLabels } from "@openbooks/reports";

/**
 * Bridge between the request locale and the custom-report executor's
 * injectable label hooks — group titles, column headings, summary-band labels
 * and boolean cells all shape in the caller's language (including the CSV
 * artifact recorded with the run). Message keys live in reports.catalog.* /
 * reports.run.*; every entity and column is enumerated there. A measure's
 * user-authored `label` (stored in the plan) is data and renders verbatim.
 */
export async function reportRunLabels(): Promise<ReportRunLabels> {
  const t = await getTranslations("reports");
  const column = (entityKey: string, key: string) => t(`catalog.columns.${entityKey}.${key}`);
  return {
    column: (entity, key) => column(entity.key, key),
    measure: (entity, m) => {
      if (m.label) return m.label;
      if (m.fn === "count" || !m.column) return t(`aggs.${m.fn}`);
      return t("run.measureOf", { fn: t(`aggs.${m.fn}`), column: column(entity.key, m.column) });
    },
    breakout: (entity, b) =>
      b.bin
        ? t("run.breakoutBy", { column: column(entity.key, b.column), bin: t(`run.bins.${b.bin}`) })
        : column(entity.key, b.column),
    resultsTitle: () => t("run.results"),
    summaryTitle: () => t("run.summary"),
    sectionTitle: (label, value) => t("run.section", { label, value }),
    rowCount: (n) => t("run.rowCount", { count: n }),
    groupCount: (n) => t("run.groupCount", { count: n }),
    summaryRows: () => t("run.summaryRows"),
    summaryGroups: () => t("run.summaryGroups"),
    summarySource: () => t("run.summarySource"),
    summaryTotal: (measureHeading) => t("run.summaryTotal", { measure: measureHeading }),
    none: () => t("run.none"),
    subtotal: (level: string) => t("run.subtotal", { level }),
    grandTotalsTitle: () => t("run.grandTotals"),
    bool: (v) => t(v ? "run.yes" : "run.no"),
    enumValue: (v) => (t.has(`catalog.enumValues.${v}`) ? t(`catalog.enumValues.${v}`) : null),
    entityLabel: (entity) => t(`catalog.entities.${entity.key}.label`),
  };
}

/** Localized options for the CSV artifact serializer. */
export async function reportCsvOptions(): Promise<{ sectionHeader: string }> {
  const t = await getTranslations("reports");
  return { sectionHeader: t("run.csvSection") };
}
