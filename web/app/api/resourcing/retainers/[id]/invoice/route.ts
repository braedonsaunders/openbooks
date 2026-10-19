import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { generateRetainerInvoice } from "@openbooks/engine/resourcing/retainer-billing";
import { defineRoute } from "@/lib/api/route";

const Params = z.object({ id: uuidString() });

export const POST = defineRoute({
  permission: "retainers.manage",
  feature: "retainerBilling",
  params: Params,
  handler: async ({ authz, params: { id } }) => {
    const result = await generateRetainerInvoice({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      retainerId: id,
    });
    return Response.json(result, { status: 201 });
  },
});
