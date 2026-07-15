import "server-only";
import { getTranslations } from "next-intl/server";
import type { InsightCompileErrorCode, InsightLabelResolver } from "@openbooks/analytics";

/**
 * Bridge between the request locale and the analytics engine's injectable
 * label hooks: column labels compiled into a QueryResult come out in the
 * caller's language. Message keys live in insights.catalog.* /
 * insights.measureLabels.* — every catalog source/field is enumerated there
 * (English source, fr/es translated), so lookups never miss.
 */
export async function insightLabelResolver(): Promise<InsightLabelResolver> {
  const t = await getTranslations("insights");
  return {
    field: (sourceKey, field) => t(`catalog.fields.${sourceKey}.${field.key}`),
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
