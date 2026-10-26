import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { civilDateInput } from "@/lib/api/civil-date";
import { portalHome, resolvePortalSession } from "@openbooks/engine/portal";
import { db, withOrgContext } from "@openbooks/engine/platform/database";
import { createPortalServiceRequest } from "@openbooks/engine/service/requests";
import { isFeatureEnabled } from "@/lib/features";

export const runtime = "nodejs";

const bodySchema = z.strictObject({
  sessionToken: z.string().min(16).max(256),
  id: uuidString(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(8000).nullable().optional(),
  preferredOn: civilDateInput().nullable().optional(),
  preferredTime: z.enum(["any", "morning", "afternoon", "evening"]).optional(),
  urgent: z.boolean().optional(),
  serviceAddressId: uuidString().nullable().optional(),
});

/**
 * Public: a customer asks for service from the portal. The session token
 * names the customer; the request lands in the organization's queue as new,
 * and the client key makes a resubmitted form return the same request.
 */
export const POST = defineRoute({
  public: "token",
  body: bodySchema,
  handler: async ({ body }) => {
    const session = await resolvePortalSession(body.sessionToken);
    if (!session) return notFound("record");
    const open = await withOrgContext(
      session.orgId,
      async () =>
        (await isFeatureEnabled(session.orgId, "serviceDispatch")) &&
        (await portalHome(session.orgId, session.partyId, db)).settings.sections.serviceRequests,
    );
    if (!open) return notFound("route");
    const request = await createPortalServiceRequest({
      orgId: session.orgId,
      partyId: session.partyId,
      linkId: session.linkId,
      id: body.id,
      request: {
        title: body.title,
        description: body.description ?? null,
        preferredOn: body.preferredOn ?? null,
        preferredTime: body.preferredTime ?? "any",
        urgent: body.urgent ?? false,
        serviceAddressId: body.serviceAddressId ?? null,
      },
    });
    return NextResponse.json(
      { id: request.id, requestNumber: request.requestNumber, status: request.status },
      { status: 201 },
    );
  },
});
