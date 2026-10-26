import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { blobResponse } from "@/lib/blob-response";
import { authorizeService } from "@/lib/service/authority";
import { readVisitFile } from "@/lib/service/files";
import { visitFileParams } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** A file attached to a visit the caller may read; it opens with the visit and grants no cabinet-wide access. */
export const GET = defineRoute({
  authorize: authorizeService("service.read", "service.manage", "service.dispatch", "service.self"),
  feature: "serviceDispatch",
  params: visitFileParams,
  invalidParamsNotFound: "record",
  handler: async ({ authz, params, request }) => {
    const blob = await readVisitFile(authz, params.id, params.fileId);
    if (!blob) return notFound("record");
    return blobResponse(request, blob, { fallbackName: "attachment" });
  },
});
