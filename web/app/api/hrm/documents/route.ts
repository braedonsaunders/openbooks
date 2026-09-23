import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  generateDocument,
  listDocuments,
  resolveMergeFields,
  uploadDocument,
} from "@openbooks/engine/src/hrm/documents/documents.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { hrmDocumentsErrorResponse } from "./_lib";
import { generateDocumentBody, previewMergeBody, uploadDocumentBody } from "./bodies";

export async function gateDocuments(orgId: string): Promise<NextResponse | null> {
  if (!(await isFeatureEnabled(orgId, "hrm"))) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!(await isFeatureEnabled(orgId, "hrmDocuments"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return null;
}

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

export async function GET(req: Request) {
  const gate = await guardPermission("hrm.documents.read");
  if (gate instanceof NextResponse) return gate;
  const off = await gateDocuments(gate.user.orgId);
  if (off) return off;
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
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.documents.manage");
  if (gate instanceof NextResponse) return gate;
  const off = await gateDocuments(gate.user.orgId);
  if (off) return off;
  const params = new URL(req.url).searchParams;
  const mode = params.get("mode") ?? "generate";
  try {
    // Merge preview: resolve the subject's merge values without writing
    // anything, so the generate dialog shows what the template will say.
    if (mode === "preview") {
      const parsedBody = await parseJsonBody(req, previewMergeBody);
      if (!parsedBody.ok) return parsedBody.response;
      const today = await businessToday(gate.user.orgId);
      const mergeValues = await resolveMergeFields(
        db,
        gate.user.orgId,
        { employmentId: parsedBody.data.employmentId ?? null, partyId: parsedBody.data.partyId },
        today,
      );
      return NextResponse.json({ mergeValues });
    }
    if (mode === "upload") {
      // HR letters ride this body as base64 (bodies.ts caps fileBase64 at
      // 14M chars ≈ 10 MB decoded), so the body cap is that cap plus
      // headroom — the house 1 MiB default would refuse every real upload.
      const parsedBody = await parseJsonBody(req, uploadDocumentBody, {
        maxBodyBytes: MAX_UPLOAD_BODY_BYTES,
      });
      if (!parsedBody.ok) return parsedBody.response;
      const body = parsedBody.data;
      let bytes: Buffer;
      try {
        bytes = Buffer.from(body.fileBase64, "base64");
      } catch {
        return NextResponse.json({ error: "fileBase64 is not valid base64" }, { status: 400 });
      }
      const document = await uploadDocument({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        employmentId: body.employmentId ?? null,
        partyId: body.partyId,
        categoryKey: body.categoryKey,
        title: body.title,
        filename: body.filename,
        contentType: body.contentType,
        bytes,
        expiresAt: body.expiresAt ?? null,
      });
      return NextResponse.json({ document }, { status: 201 });
    }
    const parsedBody = await parseJsonBody(req, generateDocumentBody);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.data;
    const today = await businessToday(gate.user.orgId);
    const { document } = await generateDocument({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      templateId: body.templateId,
      employmentId: body.employmentId ?? null,
      partyId: body.partyId,
      title: body.title,
      expiresAt: body.expiresAt ?? null,
      today,
    });
    return NextResponse.json({ document }, { status: 201 });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
