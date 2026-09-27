import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  createChangeRequestDraft,
  listChangeRequests,
} from "@openbooks/engine/src/hrm/change-requests.ts";
import { isUuid } from "../../../../lib/list-params";
import { changeRequestErrorResponse } from "./_lib";
import { createChangeRequestBody } from "./bodies";
/**
 * Employment change requests collection. GET lists this org's requests
 * (employment read gate applied per row in the service); POST files a draft
 * proposal (employment manage gate in the service). Decisions ride the
 * existing native gate routes, never a new endpoint.
 */
export const GET = defineRoute({
  permission: "hrm.employment.read",
  feature: "hrm",
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url);
    const employmentId = url.searchParams.get("employment");
    const status = url.searchParams.get("status");
    if (employmentId !== null && !isUuid(employmentId)) {
      return NextResponse.json(
        { error: "employment must be a uuid" },
        { status: 400 },
      );
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
  },
});
export const POST = defineRoute({
  permission: "hrm.employment.manage",
  feature: "hrm",
  body: createChangeRequestBody,
  handler: async ({ request: _req, authz: gate, body }) => {
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
  },
});
