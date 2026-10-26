import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { assignGlAuditNumbers } from "@openbooks/engine/close/gl-audit-numbering";
import { uuidId } from "@/lib/api/json";
export const POST = defineRoute({
  permission: "close.run",
  feature: { none: "GL audit numbering is a core accounting control." },
  body: z.object({
    periodId: uuidId,
    bookId: uuidId,
    subsidiaryId: uuidId,
    reason: z.string().trim().min(5).max(2000),
  }),
  handler: async ({ body, authz }) =>
    Response.json(
      await assignGlAuditNumbers({
        ...body,
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      }),
    ),
});
