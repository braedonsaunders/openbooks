import { NextResponse } from "next/server";
import { getDocumentDetail } from "@openbooks/engine/src/hrm/documents/documents.ts";
import { guardPermission } from "../../../../../lib/authz";
import { hrmDocumentsErrorResponse } from "../_lib";
import { gateDocuments } from "../route";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.documents.read");
  if (gate instanceof NextResponse) return gate;
  const off = await gateDocuments(gate.user.orgId);
  if (off) return off;
  try {
    const { id } = await ctx.params;
    const document = await getDocumentDetail({ orgId: gate.user.orgId, actorId: gate.user.id, documentId: id });
    return NextResponse.json({ document });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
