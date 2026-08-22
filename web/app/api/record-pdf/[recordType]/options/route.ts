import { NextResponse } from "next/server";
import { guardPermission } from "../../../../../lib/authz";
import { isDocKindEnabled } from "../../../../../lib/documents";
import { PDF_RECORD_TYPE_BY_KEY } from "../../../../../lib/pdf-templates/catalog";
import { listPdfTemplates } from "../../../../../lib/pdf-templates/store";

export const runtime = "nodejs";

/** GET /api/records/[recordType]/pdf-options — template choices for the PDF menu. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ recordType: string }> },
) {
  const { recordType } = await params;
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType];
  if (!meta) return NextResponse.json({ error: "unknown record type" }, { status: 400 });
  const gate = await guardPermission(meta.readPermission);
  if (gate instanceof NextResponse) return gate;
  if (!(await isDocKindEnabled(gate.user.orgId, recordType))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const rows = await listPdfTemplates(gate.user.orgId, recordType);
  return NextResponse.json({
    rows: rows
      .filter((r) => r.isActive)
      .map((r) => ({ id: r.id, name: r.name, isDefault: r.isDefault })),
  });
}
