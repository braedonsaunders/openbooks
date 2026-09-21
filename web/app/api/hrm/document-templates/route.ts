import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { listTemplates, saveTemplate } from "@openbooks/engine/src/hrm/documents/templates.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { hrmDocumentsErrorResponse } from "../documents/_lib";
import { saveTemplateBody } from "./bodies";

async function gateDocuments(orgId: string): Promise<NextResponse | null> {
  // Feature-off reads and writes 404: a disabled surface is
  // indistinguishable from a missing one, and the service refuses anyway.
  if (!(await isFeatureEnabled(orgId, "hrm"))) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!(await isFeatureEnabled(orgId, "hrmDocuments"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return null;
}

export async function GET(req: Request) {
  const gate = await guardPermission("hrm.documents.read");
  if (gate instanceof NextResponse) return gate;
  const off = await gateDocuments(gate.user.orgId);
  if (off) return off;
  try {
    const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
    const templates = await listTemplates({ orgId: gate.user.orgId, actorId: gate.user.id, includeInactive });
    return NextResponse.json({ templates });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.documents.manage");
  if (gate instanceof NextResponse) return gate;
  const off = await gateDocuments(gate.user.orgId);
  if (off) return off;
  const parsedBody = await parseJsonBody(req, saveTemplateBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const template = await saveTemplate({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      templateId: body.templateId,
      name: body.name,
      categoryKey: body.categoryKey,
      bodyTemplate: body.bodyTemplate,
      mergeFields: body.mergeFields,
      requiresSignature: body.requiresSignature,
      signerRoles: body.signerRoles,
      acknowledgmentOnly: body.acknowledgmentOnly,
      isActive: body.isActive,
    });
    return NextResponse.json({ template }, { status: body.templateId ? 200 : 201 });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
