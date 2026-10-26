import { NextResponse } from "next/server";
import { z } from "zod";
import { reverseMfnElection } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";
import { idempotencyKey, reason } from "../../../../../_schema";

export const runtime = "nodejs";

const params = z.object({ id: uuidId, amendmentId: uuidId });
const body = z.object({ effectiveOn: isoDate(), reason, idempotencyKey });

/**
 * Reverse an MFN election recorded in error (equity.manage): from the
 * reversal date the SAFE carries the terms in force before the election. The
 * reversal is submitted to any enabled Equity action Flow: it applies at once
 * (201) when no Flow gates it, and otherwise waits for the Flow's decision
 * (202, status pending_approval).
 */
export const POST = defineRoute({
  permission: "equity.manage",
  feature: "equity",
  params,
  invalidParamsNotFound: "record",
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz, params: { id, amendmentId }, body }) => {
    const result = await reverseMfnElection({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      securityId: id,
      amendmentId,
      ...body,
    });
    return NextResponse.json(result, {
      status: result.replayed ? 200 : result.status === "pending_approval" ? 202 : 201,
    });
  },
});
