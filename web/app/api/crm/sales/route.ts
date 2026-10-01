import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { can } from "@/lib/authz";
import { salesCommandSchema } from "@/lib/crm/sales-schema";
import { SalesError, writeSalesCommand } from "@openbooks/engine/crm/sales";
import { canonicalizeSalesGeography } from "@/lib/crm/territory-boundaries";

export const runtime = "nodejs";
export const POST = defineRoute({
  permission: "crm.setup.manage",
  feature: "salesManagement",
  body: salesCommandSchema,
  invalidBodyStatus: 422,
  maxBodyBytes: 8 * 1024 * 1024,
  handler: async ({ authz, body }) => {
    if (
      body.action === "quota-transition" &&
      body.lifecycle === "approved" &&
      !can(authz, "crm.forecasts.override")
    )
      throw new SalesError(
        "Quota approval requires the sales manager approval permission.",
        403,
      );
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
