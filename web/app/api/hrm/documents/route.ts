import { defineRoute } from "@/lib/api/route";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  generateDocument,
  listDocuments,
  resolveMergeFields,
  uploadDocument,
} from "@openbooks/engine/hrm/documents/documents";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { applicationContextFromSession } from "@/lib/application/context";
import { executeIdempotent } from "@/lib/application/idempotency";
import { hrmDocumentsErrorResponse } from "./_lib";
import { generateDocumentBody, previewMergeBody, uploadDocumentBody } from "./bodies";
function appBaseUrl(req: Request): string {
  const env = process.env.OPENBOOKS_APP_URL?.trim().replace(/\/+$/, "");
  if (env) return env;
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}
export function resolveAppBaseUrl(req: Request): string {
  return appBaseUrl(req);
}
/** Body ceiling for mode=upload only; preview/generate stay on the house default. */
export const MAX_UPLOAD_BODY_BYTES = 15 * 1024 * 1024;
export const GET = defineRoute({
  permission: "hrm.documents.read",
  feature: "hrmDocuments",
  handler: async ({ request: req, authz: gate }) => {
    try {
      const params = new URL(req.url).searchParams;
      const documents = await listDocuments({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        partyId: params.get("partyId") ?? undefined,
        status: params.get("status") ?? undefined,
        categoryKey: params.get("category") ?? undefined,
      });
      return NextResponse.json({ documents });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
export const POST = defineRoute({
  permission: "hrm.documents.manage",
  feature: "hrmDocuments",
  body: ({ request }) => {
    const mode = new URL(request.url).searchParams.get("mode") ?? "generate";
    if (mode === "preview") return previewMergeBody;
    if (mode === "upload") return uploadDocumentBody;
    if (mode === "generate") return generateDocumentBody;
    return undefined;
  },
  // The upload schema admits base64 files larger than the shared JSON limit.
  maxBodyBytes: ({ request }) =>
    new URL(request.url).searchParams.get("mode") === "upload" ? MAX_UPLOAD_BODY_BYTES : undefined,
  handler: async ({ request: req, authz: gate, body }) => {
    const params = new URL(req.url).searchParams;
    const mode = params.get("mode") ?? "generate";
    if (mode !== "preview" && mode !== "upload" && mode !== "generate") {
      return NextResponse.json(
        { error: "mode must be preview, upload, or generate" },
        { status: 400 },
      );
    }
    try {
      // Merge preview: resolve the subject's merge values without writing
      // anything, so the generate dialog shows what the template will say.
      if (mode === "preview") {
        const parsedBody = body as z.output<typeof previewMergeBody>;
        const today = await businessToday(gate.user.orgId);
        const mergeValues = await resolveMergeFields(
          db,
          gate.user.orgId,
          {
            employmentId: parsedBody.employmentId ?? null,
            partyId: parsedBody.partyId,
          },
          today,
        );
        return NextResponse.json({ mergeValues });
      }
      if (mode === "upload") {
        const upload = body as z.output<typeof uploadDocumentBody>;
        let bytes: Buffer;
        try {
          bytes = Buffer.from(upload.fileBase64, "base64");
        } catch {
          return NextResponse.json({ error: "fileBase64 is not valid base64" }, { status: 400 });
        }
        const document = await uploadDocument({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          employmentId: upload.employmentId ?? null,
          partyId: upload.partyId,
          categoryKey: upload.categoryKey,
          title: upload.title,
          filename: upload.filename,
          contentType: upload.contentType,
          bytes,
          expiresAt: upload.expiresAt ?? null,
        });
        return NextResponse.json({ document }, { status: 201 });
      }
      const generateBody = body as z.output<typeof generateDocumentBody>;
      const outcome = await executeIdempotent({
        context: applicationContextFromSession(
          gate,
          "api",
          req.headers.get("x-request-id") || randomUUID(),
        ),
        operation: "hrm_document.generate",
        idempotencyKey: generateBody.idempotencyKey,
        request: {
          templateId: generateBody.templateId,
          employmentId: generateBody.employmentId ?? null,
          partyId: generateBody.partyId,
          title: generateBody.title,
          expiresAt: generateBody.expiresAt ?? null,
        },
        successStatus: () => 201,
        execute: async () => {
          const today = await businessToday(gate.user.orgId);
          const { document } = await generateDocument({
            orgId: gate.user.orgId,
            actorId: gate.user.id,
            templateId: generateBody.templateId,
            employmentId: generateBody.employmentId ?? null,
            partyId: generateBody.partyId,
            title: generateBody.title,
            expiresAt: generateBody.expiresAt ?? null,
            today,
          });
          return { document };
        },
      });
      return NextResponse.json(outcome.value, { status: 201 });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
