import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { compileTemplateHtml, sanitizeTokenizedFragment } from "@openbooks/pdf";
import { guardPermission } from "../../../../lib/authz";
import { isDocKindEnabled } from "../../../../lib/documents";
import { pdfResponse } from "../../../../lib/export";
import { PDF_RECORD_TYPE_BY_KEY, sampleValues } from "../../../../lib/pdf-templates/catalog";
import { mergeAndPrintPdf } from "../../../../lib/pdf-templates/render";
import { findSamplePdfRecordId, loadPdfRecordValues } from "../../../../lib/pdf-templates/values";

export const runtime = "nodejs";

/**
 * POST /api/pdf-templates/preview — render draft (unsaved) template HTML as an
 * exact PDF against the record type's most recent real record, falling back to
 * the catalog's sample values. This IS the editor's preview: what Chromium
 * prints here is byte-identical to what the record's PDF button produces.
 */
export async function POST(req: Request) {
  const gate = await guardPermission("admin.customization.manage");
  if (gate instanceof NextResponse) return gate;
  const { user } = gate;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    recordType?: string;
    sourceHtml?: string;
    headerHtml?: string | null;
    footerHtml?: string | null;
    paperSize?: string;
    orientation?: string;
    marginMm?: number;
  };
  const meta = body.recordType ? PDF_RECORD_TYPE_BY_KEY[body.recordType] : undefined;
  if (!meta) return NextResponse.json({ error: "unknown record type" }, { status: 400 });
  if (!(await isDocKindEnabled(user.orgId, meta.key))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let compiledHtml: string;
  let header: string;
  let footer: string;
  try {
    compiledHtml = compileTemplateHtml(body.sourceHtml ?? "").compiledHtml;
    header = body.headerHtml ? sanitizeTokenizedFragment(body.headerHtml) : "";
    footer = body.footerHtml ? sanitizeTokenizedFragment(body.footerHtml) : "";
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const sampleId = await findSamplePdfRecordId(meta.key, user.orgId);
  const real = sampleId ? await loadPdfRecordValues(meta.key, user.orgId, sampleId) : null;
  const values = real?.values ?? sampleValues(meta);

  try {
    const pdf = await mergeAndPrintPdf(
      {
        compiledHtml,
        paperSize: (["letter", "a4", "legal"].includes(body.paperSize ?? "") ? body.paperSize : "letter") as "letter" | "a4" | "legal",
        orientation: body.orientation === "landscape" ? "landscape" : "portrait",
        marginMm: Math.min(50, Math.max(0, Math.round(Number(body.marginMm ?? 14)) || 0)),
        headerHtml: header || null,
        footerHtml: footer || null,
      },
      values,
    );
    return pdfResponse(pdf, `${meta.label} preview`);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
