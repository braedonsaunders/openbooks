import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  createOfferTemplate,
  listOfferTemplates,
} from "@openbooks/engine/src/hrm/recruiting/offers-signing.ts";

import { recruitingErrorResponse } from "../_lib";
import { createOfferTemplateBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Offer-template collection: GET lists templates, POST creates one
 * (manage gate in the service). 404s while HRM or Recruiting is
 * off — the Setup surface hides with the same switch.
 */
export const GET = defineRoute({
  permission: "hrm.recruiting.read",
  feature: "hrmRecruiting",
  handler: async ({ request: req, authz: gate }) => {
    try {
      const includeInactive =
        new URL(req.url).searchParams.get("includeInactive") === "1";
      const templates = await listOfferTemplates({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        includeInactive,
      });
      return NextResponse.json({ templates });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmRecruiting",
  body: createOfferTemplateBody,
  handler: async ({ authz: gate, body: body }) => {
    try {
      const template = await createOfferTemplate({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        name: body.name,
        bodyTemplate: body.bodyTemplate,
        clauses: body.clauses,
        approvalRequired: body.approvalRequired,
      });
      return NextResponse.json({ template }, { status: 201 });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
