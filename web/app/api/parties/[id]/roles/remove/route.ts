import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { removePartyRoleFromParty } from "@/lib/party-role-actions";

export const runtime = "nodejs";

const removeBody = z.object({ role: z.enum(["customer", "vendor", "employee"]) }).strict();

/** Remove one native party role after checking its open operational history. */
export const POST = defineRoute({
  permission: "parties.manage",
  feature: { none: "Parties are shared master records; CRM capabilities do not gate their roles." },
  params: z.object({ id: z.string() }),
  body: removeBody,
  invalidBodyStatus: 422,
  handler: async ({ body, authz, params }) => {
    const result = await removePartyRoleFromParty(authz, params.id, body.role);
    return result instanceof NextResponse ? result : NextResponse.json(result);
  },
});
