import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { withdrawApprovalCommand } from "@openbooks/engine/flows/command-approval";

/** The native command permits an authorized withdrawal even when new Flows are disabled. */
export const POST = defineRoute({
  public: "session",
  params: z.strictObject({
    subjectKind: z.string().min(1).max(100),
    id: uuidString(),
  }),
  body: z.strictObject({ reason: z.string().trim().min(3).max(2000) }),
  handler: async ({ authz, params, body }) => {
    await withdrawApprovalCommand({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      subjectKind: params.subjectKind,
      subjectId: params.id,
      reason: body.reason,
    });
    return Response.json({ withdrawn: true });
  },
});
