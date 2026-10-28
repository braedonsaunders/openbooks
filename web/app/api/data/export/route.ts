import { apiErrorResponse } from "@/lib/api/error-response";
import { notFound } from "@/lib/api/responses";
import { ApplicationError } from "@/lib/application/errors";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { toCsv, toJson, toXlsx } from "@/lib/data-io/serialize";
import { csvResponse, safeName, xlsxResponse } from "@/lib/export";
import { EXPORT_FORMATS, requestedExportFormat, type ExportFormat } from "@/lib/data-io/types";
import { readDataExport } from "../../../../lib/data-io/export-data";

export const runtime = "nodejs";

const exportBody = z
  .object({
    resource: z.string().min(1),
    columns: z.array(z.string()).optional(),
    format: z.enum(EXPORT_FORMATS).optional(),
  })
  .strict();

/**
 * Generic export: any registered resource → CSV / XLSX / JSON. The resource
 * key selects a DataResource (Setup entity, master-data table, or custom
 * record type); its own read permission is enforced on top of data.export.
 * Reference columns are emitted as human natural keys, not UUIDs.
 */
export const POST = defineRoute({
  permission: "data.export",
  feature: {
    none: "Data import and export are permission-gated and have no organization feature switch.",
  },
  body: exportBody,
  handler: async ({ request: req, authz, body }) => {
    const resourceKey = String(body.resource ?? "");
    const format: ExportFormat | null = requestedExportFormat(body.format);
    if (format === null) {
      return NextResponse.json({ error: "format must be csv, xlsx or json" }, { status: 400 });
    }

    let exportData: Awaited<ReturnType<typeof readDataExport>>;
    try {
      exportData = await readDataExport(authz, resourceKey, body.columns);
    } catch (error) {
      // The route keeps its established refusal bodies: an unknown resource is
      // {"error":"not_found"}, a missing read grant {"error":"forbidden"}, and a
      // column choice it cannot honour names the problem; the over-cap refusal
      // and anything unexpected keep their sanitized mapping.
      if (error instanceof ApplicationError) {
        if (error.code === "not_found") return notFound("record");
        if (error.code === "forbidden") {
          return NextResponse.json({ error: "forbidden" }, { status: 403 });
        }
        if (error.code === "invalid_input" && error.status === 422) {
          return NextResponse.json({ error: error.message }, { status: 400 });
        }
      }
      return apiErrorResponse(error, { request: req });
    }
    const cols = exportData.columns;
    const rows = exportData.rows;

    const title = safeName(exportData.descriptor.label || exportData.descriptor.key);
    const stamp = await businessToday(authz.user.orgId);
    const filename = `${title}-${stamp}`;

    if (format === "csv") return csvResponse(toCsv(title, cols, rows), filename);
    if (format === "xlsx") {
      return xlsxResponse(
        await toXlsx(title, cols, rows, new Date(`${stamp}T00:00:00Z`)),
        filename,
      );
    }
    // json
    return new NextResponse(new TextEncoder().encode(toJson(cols, rows)), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeName(filename)}.json"`,
        "Cache-Control": "no-store",
      },
    });
  },
});
