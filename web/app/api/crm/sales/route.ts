import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { salesCommandSchema } from "@/lib/crm/sales-schema";
import { writeSalesCommand } from "@openbooks/engine/crm/sales";
import { canonicalizeSalesGeography } from "@/lib/crm/territory-boundaries";

export const runtime = "nodejs";
export const POST = defineRoute({
  permission: "crm.setup.manage",
  feature: "salesManagement",
  body: salesCommandSchema,
  invalidBodyStatus: 422,
  maxBodyBytes: 8 * 1024 * 1024,
  handler: async ({ authz, body }) => {
    const command =
      body.action === "territory"
        ? {
            ...body,
            geography: await canonicalizeSalesGeography(body.geography),
          }
        : body;
    const result = await writeSalesCommand(
      {
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      },
      command,
    );
    return NextResponse.json(result);
  },
});
