import { getLocale, getTranslations } from "next-intl/server";
import { z } from "zod";
import { resolvePdfPageSetup } from "@openbooks/pdf";
import { loadCapTableView } from "@openbooks/engine/equity";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";
import { capTableExportData } from "@/lib/equity-cap-table-export";
import { CAP_TABLE_INSTRUMENTS, capTableFilters } from "@/lib/equity-cap-table";
import { csvResponse, pdfResponse, safeName, xlsxResponse } from "@/lib/export";
import { formatCivilDate } from "@/lib/format";
import { exportDataToCsv, exportDataToPdf, exportDataToXlsx, orgBranding } from "@/lib/report-pdf";
import { reportCsvOptions } from "@/lib/report-labels";
import { parseQuery } from "../../_schema";

export const runtime = "nodejs";

const query = z.object({
  subsidiaryId: uuidId,
  asOf: isoDate(),
  by: z.enum(["class", "holder"]).default("class"),
  instrument: z.enum(["all", ...CAP_TABLE_INSTRUMENTS]).default("all"),
  q: z.string().max(200).optional(),
  format: z.enum(["pdf", "xlsx", "csv"]),
});

/**
 * The legal entity's cap table as of a date as PDF, Excel or CSV, with the
 * page's filters (view, instrument and search) applied, so the file holds
 * exactly the lines and totals the page shows.
 */
export const GET = defineRoute({
  permission: "equity.read",
  feature: "equity",
  handler: async ({ authz, request }) => {
    const parsed = parseQuery(request, query);
    if (!parsed.ok) return parsed.response;
    const { subsidiaryId, asOf, format } = parsed.data;
    const filters = capTableFilters({
      by: parsed.data.by,
      instrument: parsed.data.instrument,
      q: parsed.data.q,
    });
    const view = await loadCapTableView({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      subsidiaryId,
      asOf,
    });
    const t = await getTranslations("equity");
    const locale = await getLocale();
    const data = capTableExportData(view, filters, {
      title: t("capTable.exportTitle", { entity: view.entity.name }),
      dateRange: t("capTable.exportAsOf", { date: formatCivilDate(asOf, locale) }),
      class: t("capTable.columns.class"),
      kind: (kind) => t(`classKind.${kind}`),
      holder: t("capTable.columns.holder"),
      pool: t("overview.ownership.pool"),
      column: (key) =>
        t(
          `capTable.columns.${key === "instrumentOutstanding" ? `${filters.instrument as "option" | "rsu" | "warrant"}Outstanding` : key}`,
        ),
      total: t("waterfall.columns.total"),
    });
    const stamp = await businessToday(authz.user.orgId);
    const filename = safeName(
      `${view.entity.name}-cap-table-${filters.dimension}${filters.instrument === "all" ? "" : `-${filters.instrument}`}-${asOf}`,
    );
    if (format === "csv") {
      const { sectionHeader } = await reportCsvOptions();
      return csvResponse(exportDataToCsv(data, { sectionHeader }), filename);
    }
    if (format === "xlsx") {
      // The cap table holds share counts and percentages, never money.
      return xlsxResponse(
        await exportDataToXlsx(data, {
          reportName: data.title,
          dateRangeLabel: data.dateRangeLabel,
          generatedAt: new Date(`${stamp}T00:00:00Z`),
          money: null,
        }),
        filename,
      );
    }
    const page = resolvePdfPageSetup({
      paperSize: "letter",
      orientation: "landscape",
      marginMm: 12,
      density: "compact",
    });
    return pdfResponse(
      await exportDataToPdf(data, await orgBranding(authz.user.orgId), page, {
        generatedAt: new Date(`${stamp}T00:00:00Z`),
      }),
      filename,
    );
  },
});
