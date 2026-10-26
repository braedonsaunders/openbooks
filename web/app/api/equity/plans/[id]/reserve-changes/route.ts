import { NextResponse } from "next/server";
import { z } from "zod";
import { changePlanReserve } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";
import { reason, signedShares } from "../../../_schema";

export const runtime = "nodejs";

const params = z.object({ id: uuidId });
const body = z.object({ effectiveOn: isoDate(), shareDelta: signedShares, reason });

/**
 * Increase or reduce a plan's reserve from a date (equity.manage). It is submitted to any enabled Equity action Flow: it applies at once (201)
 * when no Flow gates it, and otherwise waits for the Flow's decision (202,
 * status pending_approval).
 */
export const POST = defineRoute({
  permission: "equity.manage",
  feature: "equity",
  params,
  invalidParamsNotFound: "record",
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz, params: { id }, body }) => {
    const result = await changePlanReserve({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      planId: id,
      ...body,
    });
    return NextResponse.json(result, { status: result.status === "pending_approval" ? 202 : 201 });
  },
});
