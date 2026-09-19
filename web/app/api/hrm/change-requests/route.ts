import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  createChangeRequestDraft,
  listChangeRequests,
} from "@openbooks/engine/src/hrm/change-requests.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { changeRequestErrorResponse, createChangeRequestBody } from "./_lib";

export const runtime = "nodejs";

/**
 * Employment change requests collection. GET lists this org's requests
 * (employment read gate applied per row in the service); POST files a draft
 * proposal (employment manage gate in the service). Decisions ride the
 * existing native gate routes, never a new endpoint.
 */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.employment.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const employmentId = url.searchParams.get("employment");
  const status = url.searchParams.get("status");
  if (employmentId !== null && !isUuid(employmentId)) {
    return NextResponse.json({ error: "employment must be a uuid" }, { status: 400 });
  }
  try {
    const requests = await listChangeRequests({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      ...(employmentId ? { employmentId } : {}),
      ...(status ? { status } : {}),
    });
    return NextResponse.json({ requests });
  } catch (e) {
    return changeRequestErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.employment.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createChangeRequestBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const request = await createChangeRequestDraft({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      employmentId: body.employmentId,
      payload: body.payload,
    });
    return NextResponse.json({ request }, { status: 201 });
  } catch (e) {
    return changeRequestErrorResponse(e);
  }
}
