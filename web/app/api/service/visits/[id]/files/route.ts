import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { MULTIPART_FRAMING_BYTES, parseFormDataBody } from "@/lib/api/form-data";
import { authorizeService } from "@/lib/service/authority";
import { attachVisitFile, listVisitFiles, MAX_VISIT_FILE_BYTES } from "@/lib/service/files";
import { idParams } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** Photos and documents attached to a visit, stored in the File Cabinet. */
export const GET = defineRoute({
  authorize: authorizeService("service.read", "service.manage", "service.dispatch", "service.self"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  handler: async ({ authz, params }) =>
    NextResponse.json({ files: await listVisitFiles(authz, params.id) }),
});

/** Attach a photo or PDF to a visit (multipart form field `file`). */
export const POST = defineRoute({
  authorize: authorizeService("service.self", "service.manage", "service.dispatch"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  handler: async ({ authz, params, request }) => {
    const parsed = await parseFormDataBody(request, {
      maxBodyBytes: MAX_VISIT_FILE_BYTES + MULTIPART_FRAMING_BYTES,
      invalid: { error: "Choose a photo or PDF to attach." },
      tooLarge: {
        error: "Attachments are at most 10 MB.",
        remedy: "Reduce the photo size and attach it again.",
      },
    });
    if (!parsed.ok) return parsed.response;
    const file = parsed.data.get("file");
    if (!(file instanceof File))
      return NextResponse.json({ error: "Choose a photo or PDF to attach." }, { status: 400 });
    const attached = await attachVisitFile(authz, {
      visitId: params.id,
      filename: file.name,
      contentType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    return NextResponse.json(attached, { status: 201 });
  },
});
