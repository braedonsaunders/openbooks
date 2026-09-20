import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  fulfilPayInformationRequest,
  refusePayInformationRequest,
  requestPayInformation,
} from "@openbooks/engine/src/hrm/compensation/pay-transparency.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { compensationErrorResponse } from "../compensation/_lib";
import { requestPayInfoBody } from "../compensation/bodies";

export const runtime = "nodejs";

/**
 * Pay-information requests. POST files one for the caller's own
 * employment (hrm.self.request in the service — HR files nobody
 * else's); POST /[id] fulfils (from the latest snapshot covering the
 * worker's category, refusing when none does) or refuses with a
 * reason. Fulfil/refuse ride comp.manage. The client checks res.ok
 * before parsing.
 */
export async function POST(req: Request) {
  const gate = await guardPermission("hrm.self.request");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmPayTransparency"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, requestPayInfoBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const request = await requestPayInformation({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      employmentId: parsedBody.data.employmentId,
    });
    return NextResponse.json({ request }, { status: 201 });
  } catch (e) {
    return compensationErrorResponse(e);
  }
}
