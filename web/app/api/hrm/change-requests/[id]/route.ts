import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  getChangeRequest,
  updateChangeRequestPayload,
} from "@openbooks/engine/src/hrm/change-requests.ts";
import { isUuid } from "../../../../../lib/list-params";
import { changeRequestErrorResponse } from "../_lib";
import { patchChangeRequestBody } from "../bodies";
/** Single employment change request: GET reads, PATCH edits the draft payload. */
export const GET = defineRoute({
  permission: "hrm.employment.read",
  feature: "hrm",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    const { id } = params;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "request id must be a uuid" },
        { status: 400 },
      );
    try {
      const request = await getChangeRequest({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        requestId: id,
      });
      return NextResponse.json({ request });
    } catch (e) {
      return changeRequestErrorResponse(e);
    }
  },
});
export const PATCH = defineRoute({
  permission: "hrm.employment.manage",
  feature: "hrm",
  body: patchChangeRequestBody,
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params, body }) => {
    const { id } = params;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "request id must be a uuid" },
        { status: 400 },
      );
    try {
      const request = await updateChangeRequestPayload({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        requestId: id,
        payload: body.payload,
      });
      return NextResponse.json({ request });
    } catch (e) {
      return changeRequestErrorResponse(e);
    }
  },
});
