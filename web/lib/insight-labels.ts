import "server-only";
import { getTranslations } from "next-intl/server";
import type { InsightCompileErrorCode, InsightLabelResolver } from "@openbooks/analytics";

/**
 * Bridge between the request locale and the analytics engine's injectable
 * label hooks: column labels compiled into a QueryResult come out in the
 * caller's language.
 *
 * Field labels resolve through the REPORT catalog namespace
 * (reports.catalog.columns.<entity>.<column>) because insight sources are the
 * report entities — one catalog, one set of headings, so a field is worded the
 * same in a card, a custom report and a saved view. Everything else is
 * insights-only chrome (insights.measureLabels.*).
 */
export async function insightLabelResolver(): Promise<InsightLabelResolver> {
  const [t, tCatalog] = await Promise.all([
    getTranslations("insights"),
    getTranslations("reports"),
  ]);
  return {
    field: (sourceKey, field) => tCatalog(`catalog.columns.${sourceKey}.${field.key}`),
    count: () => t("measureLabels.count"),
    measure: (agg, fieldLabel) => t(`measureLabels.${agg}`, { field: fieldLabel }),
    binnedDimension: (fieldLabel, bin) =>
      t("measureLabels.binned", { field: fieldLabel, bin: t(`measureLabels.bins.${bin}`) }),
  };
}

/** Localized studio-facing message for a coded compile/validation failure. */
export async function insightCompileErrorMessage(e: {
  code: InsightCompileErrorCode;
  subject?: string;
}): Promise<string> {
  const t = await getTranslations("insights");
  return t(`compileErrors.${e.code}`, { subject: e.subject ?? "" });
}
