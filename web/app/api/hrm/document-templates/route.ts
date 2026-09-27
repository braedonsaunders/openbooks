import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  listTemplates,
  saveTemplate,
} from "@openbooks/engine/src/hrm/documents/templates.ts";
import { hrmDocumentsErrorResponse } from "../documents/_lib";
import { saveTemplateBody } from "./bodies";
export const GET = defineRoute({
  permission: "hrm.documents.read",
  feature: "hrmDocuments",
  handler: async ({ request: req, authz: gate }) => {
    try {
      const includeInactive =
        new URL(req.url).searchParams.get("includeInactive") === "1";
      const templates = await listTemplates({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        includeInactive,
      });
      return NextResponse.json({ templates });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
export const POST = defineRoute({
  permission: "hrm.documents.manage",
  feature: "hrmDocuments",
  body: saveTemplateBody,
  handler: async ({ request: req, authz: gate, body }) => {
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
      return NextResponse.json(
        { template },
        { status: body.templateId ? 200 : 201 },
      );
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
