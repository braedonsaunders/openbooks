import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { voidDocument } from "@openbooks/engine/src/hrm/documents/documents.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { hrmDocumentsErrorResponse } from "../../_lib";
import { gateDocuments } from "../../route";
import { voidDocumentBody } from "../../bodies";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.documents.manage");
  if (gate instanceof NextResponse) return gate;
  const off = await gateDocuments(gate.user.orgId);
  if (off) return off;
  const parsedBody = await parseJsonBody(req, voidDocumentBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const { id } = await ctx.params;
    const document = await voidDocument({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      documentId: id,
      reason: parsedBody.data.reason,
    });
    return NextResponse.json({ document });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
