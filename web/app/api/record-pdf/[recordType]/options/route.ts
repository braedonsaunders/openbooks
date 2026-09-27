import { NextResponse } from "next/server";
import { guardPermission } from "../../../../../lib/authz";
import { isDocKindEnabled } from "../../../../../lib/documents.ts";
import { PDF_RECORD_TYPE_BY_KEY } from "../../../../../lib/pdf-templates/catalog";
import { listPdfTemplates } from "../../../../../lib/pdf-templates/store";
import { notFound } from "@/lib/api/responses";
import { defineRoute } from '@/lib/api/route'
import { z } from 'zod'


export const runtime = "nodejs";

/** GET /api/records/[recordType]/pdf-options — template choices for the PDF menu. */
async function listRecordPdfOptions(
  _req: Request,
  { params }: { params: Promise<{ recordType: string }> },
) {
  const { recordType } = await params;
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType];
  if (!meta) return NextResponse.json({ error: "unknown record type" }, { status: 400 });
  const gate = await guardPermission(meta.readPermission);
  if (gate instanceof NextResponse) return gate;
  if (!(await isDocKindEnabled(gate.user.orgId, meta.docKind ?? meta.key))) {
    return notFound("record");
  }
  const rows = await listPdfTemplates(gate.user.orgId, recordType);
  return NextResponse.json({
    rows: rows
      .filter((r) => r.isActive)
      .map((r) => ({ id: r.id, name: r.name, isDefault: r.isDefault })),
  });
}

export const GET = defineRoute({
  authorize: async ({ params }) => {
    const recordType = (params as { recordType?: string } | undefined)?.recordType ?? ''
    const meta = PDF_RECORD_TYPE_BY_KEY[recordType]
    if (!meta) return NextResponse.json({ error: 'unknown record type' }, { status: 400 })
    return guardPermission(meta.readPermission)
  },
  feature: { none: 'Record-type availability is enforced by the document-kind gate in the PDF options handler.' },
  params: z.object({ recordType: z.string() }),
  handler: async ({ request, params }) => listRecordPdfOptions(request, { params: Promise.resolve(params) }),
})
