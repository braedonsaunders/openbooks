import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  listOfferVersions,
  renderOfferVersion,
} from "@openbooks/engine/src/hrm/recruiting/offers-signing.ts";

import { recruitingErrorResponse } from "../../../_lib";
import { renderOfferVersionBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Offer versions: GET lists the regeneration history, POST renders a new
 * version (never an overwrite — manage gate in the service). 404s while
 * hrm, hrmRecruiting, or hrmOfferSigning is off.
 */
export const GET = defineRoute({
  permission: "hrm.recruiting.read",
  feature: "hrmRecruiting",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const { id } = routeParams;
    try {
      const versions = await listOfferVersions({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        offerId: id,
      });
      return NextResponse.json({ versions });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmRecruiting",
  params: z.object({ id: z.string().min(1) }),
  body: renderOfferVersionBody,
  handler: async ({
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;

    try {
      const version = await renderOfferVersion({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        offerId: id,
        templateId: body.templateId,
        selectedClauseKeys: body.selectedClauseKeys,
        renderedFileId: body.renderedFileId,
      });
      return NextResponse.json({ version }, { status: 201 });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
