import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { getServiceVisit } from "@openbooks/engine/service/reads";
import { updateVisitPlan } from "@openbooks/engine/service/visits";
import { idParams, visitPlanBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** A visit with its work, history and sign-off; technicians reading their own visit see no prices. */
export const GET = defineRoute({
  authorize: authorizeService("service.read", "service.manage", "service.dispatch", "service.self"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  handler: async ({ authz, params }) =>
    NextResponse.json(await getServiceVisit({ ...serviceActor(authz), visitId: params.id })),
});

export const PATCH = defineRoute({
  authorize: authorizeService("service.manage", "service.dispatch"),
  feature: "serviceDispatch",
  params: idParams,
  invalidParamsNotFound: "record",
  body: visitPlanBody,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await updateVisitPlan({
        ...serviceActor(authz),
        visitId: params.id,
        expectedRevision: body.expectedRevision,
        input: body.visit,
        reason: body.reason ?? null,
      }),
    ),
});
