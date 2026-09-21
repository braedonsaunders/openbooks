import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  fulfilPayInformationRequest,
  refusePayInformationRequest,
} from "@openbooks/engine/src/hrm/compensation/pay-transparency.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { compensationErrorResponse } from "../../compensation/_lib";

export const runtime = "nodejs";

/**
 * One pay-information request: PUT {action: fulfil} answers from the
 * latest snapshot covering the worker's category (refusing when none
 * does); PUT {action: refuse} refuses with a reason the worker reads.
 * Both ride comp.manage. The client checks res.ok before parsing.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.compensation.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmPayTransparency"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const parsedBody = await parseJsonBody(
    req,
    z.object({
      action: z.enum(["fulfil", "refuse"]),
      reason: z.string().trim().min(1).max(2000).nullable().optional(),
    }),
  );
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    if (body.action === "fulfil") {
      const request = await fulfilPayInformationRequest({ orgId: gate.user.orgId, actorId: gate.user.id, requestId: id });
      return NextResponse.json({ request });
    }
    if (!body.reason) return NextResponse.json({ error: "reason required" }, { status: 400 });
    const request = await refusePayInformationRequest({ orgId: gate.user.orgId, actorId: gate.user.id, requestId: id, reason: body.reason });
    return NextResponse.json({ request });
  } catch (e) {
    return compensationErrorResponse(e);
  }
}
