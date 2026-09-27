import type { Authz } from "@/lib/authz";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { rendererUnavailableResponse } from "@/lib/api/pdf-renderer";
import { assertPrintablePage, compileTemplateHtml, sanitizeTokenizedFragment } from "@openbooks/pdf";
import { can } from "../../../../lib/authz";
import { unexpectedServerError } from "../../../../lib/api/unexpected";
import { isDocKindEnabled } from "../../../../lib/documents.ts";
import { pdfResponse } from "../../../../lib/export";
import { PDF_RECORD_TYPE_BY_KEY, sampleValues } from "../../../../lib/pdf-templates/catalog";
import { mergeAndPrintPdf } from "../../../../lib/pdf-templates/render";
import { findSamplePdfRecordId, loadPdfRecordValues } from "../../../../lib/pdf-templates/values";
import { notFound } from "@/lib/api/responses";


export const runtime = "nodejs";

const bodyObjectSchema = z.object({
  recordType: z.string().min(1),
  sourceHtml: z.string().optional(),
  headerHtml: z.string().nullable().optional(),
  footerHtml: z.string().nullable().optional(),
  paperSize: z.enum(['letter', 'a4', 'legal']).optional(),
  orientation: z.enum(["landscape", "portrait"]).optional(),
  marginMm: z.number().optional(),
}).strict();

/**
 * POST /api/pdf-templates/preview — render draft (unsaved) template HTML as an
 * exact PDF against the record type's most recent real record, falling back to
 * the catalog's sample values. This IS the editor's preview: what Chromium
 * prints here is byte-identical to what the record's PDF button produces.
 *
 * Because the sample is a REAL record, the preview is a disclosure surface:
 * the designer must also hold the record family's read permission (the same
 * gate the record's own PDF route applies), and the sample is chosen inside
 * the designer's subsidiary scope — never from a legal entity hidden from
 * them. A designer who cannot read any real record still previews against
 * the catalog's synthetic sample values.
 */
async function legacyPOST(req: Request, ctx: { params: Promise<unknown> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;

  const { user } = gate;
  const parsedBody = await parseJsonBody(req, bodyObjectSchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  const meta = body.recordType ? PDF_RECORD_TYPE_BY_KEY[body.recordType] : undefined;
  if (!meta) return NextResponse.json({ error: "unknown record type" }, { status: 400 });
  if (!can(gate, meta.readPermission)) {
    return NextResponse.json({ error: `missing permission: ${meta.readPermission}` }, { status: 403 });
  }
  if (!(await isDocKindEnabled(user.orgId, meta.key))) {
    return notFound("record");
  }

  let compiledHtml: string;
  let header: string;
  let footer: string;
  try {
    compiledHtml = compileTemplateHtml(body.sourceHtml ?? "").compiledHtml;
    header = body.headerHtml ? sanitizeTokenizedFragment(body.headerHtml) : "";
    footer = body.footerHtml ? sanitizeTokenizedFragment(body.footerHtml) : "";
  } catch (e) {
    return apiErrorResponse(e, { safeStatus: 400 });
  }

  const scope = gate.allowedSubsidiaryIds ?? null
  const sampleId = await findSamplePdfRecordId(meta.key, user.orgId, scope);
  // The scope is enforced again INSIDE the load: the sample was chosen in
  // scope, but a record moved to a hidden subsidiary between the two awaits
  // must read as not found (and fall back to synthetic sample values),
  // never render a legal entity hidden from the designer.
  const real = sampleId ? await loadPdfRecordValues(meta.key, user.orgId, sampleId, scope) : null;
  const values = real?.values ?? sampleValues(meta);

  // Preview geometry is refused like saved geometry: a misspelled size must
  // not preview as Letter while the saved template would print the same lie.
  const paperSizeInput = body.paperSize ?? "letter";
  const marginMmInput = body.marginMm ?? 14;
  try {
    assertPrintablePage(paperSizeInput, marginMmInput);
  } catch (e) {
    return apiErrorResponse(e, { safeStatus: 400 });
  }
  if (body.orientation !== undefined && body.orientation !== "landscape" && body.orientation !== "portrait") {
    return NextResponse.json({ error: `Unknown orientation "${body.orientation}" — use portrait or landscape.` }, { status: 400 });
  }

  try {
    const pdf = await mergeAndPrintPdf(
      {
        compiledHtml,
        // assertPrintablePage narrows paperSizeInput to the supported set.
        paperSize: paperSizeInput,
        orientation: body.orientation === "landscape" ? "landscape" : "portrait",
        marginMm: marginMmInput,
        headerHtml: header || null,
        footerHtml: footer || null,
      },
      values,
    );
    // Download filename uses the stable record key, never a localized label:
    // Content-Disposition filenames must stay ASCII and stable across locales.
    return pdfResponse(pdf, `${meta.key} preview`);
  } catch (e) {
    const rendererRefusal = rendererUnavailableResponse(e);
    if (rendererRefusal) return rendererRefusal;
    return unexpectedServerError('pdf-templates/preview', e);
  }
}

export const POST = defineRoute({
  permission: "admin.customization.manage", feature: { none: "This route is governed by its permission and service authorization." },

  handler: ({ request, params, authz }) => legacyPOST(request, { params: Promise.resolve(params) }, authz),
});
