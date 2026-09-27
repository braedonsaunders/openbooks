import { z } from "zod";
import { draftFeeDrawdown, draftHoursDrawdown } from "@openbooks/engine/src/resourcing/retainers.ts";
import { created } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";

const Params = z.object({ id: z.string().uuid() }).strict();
const Body = z.union([
  z.object({ sunday: z.string() }).strict(),
  z.object({ sunday: z.string(), amount: z.string() }).strict(),
]);

export const POST = defineRoute({
  permission: "retainers.manage",
  feature: "retainerBilling",
  params: Params,
  body: Body,
  handler: async ({ authz, params, body }) => {
    const input = {
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      retainerId: params.id,
    };
    const result = "amount" in body
      ? await draftFeeDrawdown({ ...input, sunday: body.sunday, rawAmount: body.amount })
      : await draftHoursDrawdown({ ...input, sunday: body.sunday });
    return created({ ...result });
  },
});
