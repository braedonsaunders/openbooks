import { NextResponse } from "next/server";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { guardPermission, guardSubsidiaryScope } from "../../../../../lib/authz";
import { isDocKindEnabled } from "../../../../../lib/documents";
import { pdfResponse, safeName } from "../../../../../lib/export";
import { PDF_RECORD_TYPE_BY_KEY } from "../../../../../lib/pdf-templates/catalog";
import { mergeAndPrintPdf } from "../../../../../lib/pdf-templates/render";
import { resolvePdfTemplate } from "../../../../../lib/pdf-templates/store";
import { loadPdfRecordValues } from "../../../../../lib/pdf-templates/values";
import { loadRecordSubsidiaryScope } from "../../lib";

export const runtime = "nodejs";

/**
 * GET /api/records/[recordType]/[id]/pdf?template=<id> — print one record with
 * the chosen template (default: the org default, else the built-in starter).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ recordType: string; id: string }> },
) {
  const { recordType, id } = await params;
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType];
  if (!meta) return NextResponse.json({ error: "unknown record type" }, { status: 400 });

  const gate = await guardPermission(meta.readPermission);
  if (gate instanceof NextResponse) return gate;
  const { user } = gate;
  if (!(await isDocKindEnabled(user.orgId, recordType))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const templateId = new URL(req.url).searchParams.get("template");
  const owned = await loadRecordSubsidiaryScope(recordType, user.orgId, id);
  if (!owned) return NextResponse.json({ error: "record not found" }, { status: 404 });
  const denied = guardSubsidiaryScope(gate, owned.subsidiaryId);
  if (denied) return denied;
  const [tpl, record] = await Promise.all([
    resolvePdfTemplate(user.orgId, recordType, templateId),
    loadPdfRecordValues(recordType, user.orgId, id),
  ]);
  if (!tpl) return NextResponse.json({ error: "template not found" }, { status: 404 });
  if (!record) return NextResponse.json({ error: "record not found" }, { status: 404 });

  try {
    const pdf = await mergeAndPrintPdf(tpl, record.values);
    const stamp = await businessToday(user.orgId);
    return pdfResponse(pdf, safeName(`${meta.docTitle} ${record.reference}-${stamp}`));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
