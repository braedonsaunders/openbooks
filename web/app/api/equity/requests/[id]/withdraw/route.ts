import { NextResponse } from "next/server";
import { z } from "zod";
import { withdrawEquityAction } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";
import { uuidId } from "@/lib/api/json";
import { reason } from "../../../_schema";

export const runtime = "nodejs";

const params = z.object({ id: uuidId });
const body = z.object({ reason });

/**
 * Withdraw a governed equity action that awaits its Flow decision. Only its
 * requester withdraws it (the engine refuses anyone else by name); the open
 * approval runs and gates are cancelled, nothing applies, and the reason is
 * recorded and audited.
 */
export const POST = defineRoute({
  permission: "equity.read",
  feature: "equity",
  params,
  invalidParamsNotFound: "record",
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz, params: { id }, body }) => {
    const result = await withdrawEquityAction({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      requestId: id,
      reason: body.reason,
    });
    return NextResponse.json(result);
  },
});
