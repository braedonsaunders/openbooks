import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/api/error-response";
import "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { withScopeSnapshot } from "@openbooks/engine/organization/scope";
import { apCaptureSubsidiaryScope } from "@openbooks/engine/records/file-cabinet-access";
import { can } from "../../../../../lib/authz";
import { isMaskedFileContentError } from "../../../../../lib/file-storage";
import { getFileBlob } from "../../../../../lib/file-cabinet";
import { blobResponse } from "../../../../../lib/blob-response";
import { isUuid } from "../../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "ap.read",
  feature: { none: "No optional feature applies to this permission-governed endpoint." },
  params: z.object({ id: z.string() }),
  handler: async ({ request: request, authz: gate, params: routeParams }) => {
    const params = Promise.resolve(routeParams);
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    return withScopeSnapshot(gate.user.orgId, async () => {
      const capture = await db.execute<{ file_id: string }>(
        sql`
      select ci.file_id
        from ap_capture_items ci
        left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
        left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
       where ci.org_id = ${gate.user.orgId} and ci.id = ${id}
       ${apCaptureSubsidiaryScope(gate.allowedSubsidiaryIds)}
    `,
        "objects",
      );
      const fileId = capture[0]?.file_id;
      if (!fileId) return notFound("record");
      let blob: Awaited<ReturnType<typeof getFileBlob>>;
      try {
        blob = await getFileBlob(gate.user.orgId, fileId, {
          userId: gate.user.id,
          isAdmin: can(gate, "*"),
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        });
      } catch (err) {
        // Masked-clone tombstone: refuse by name, never as an anonymous 500.
        if (isMaskedFileContentError(err)) {
          return apiErrorResponse(err, { safeStatus: 403 });
        }
        throw err;
      }
      if (!blob) return notFound("record");
      return blobResponse(request, blob, { fallbackName: "document" });
    });
  },
});
