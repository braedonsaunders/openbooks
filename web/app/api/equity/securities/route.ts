import { NextResponse } from "next/server";
import { z } from "zod";
import { issueSecurity, listSecurities } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";
import { issueSecurityBody, parseQuery } from "../_schema";

export const runtime = "nodejs";

const listQuery = z.object({
  subsidiaryId: uuidId,
  asOf: isoDate(),
  kind: z.enum(["share", "option", "rsu", "warrant", "safe", "note"]).optional(),
  holderPartyId: uuidId.optional(),
});

/** Securities of a legal entity with their state as of a date. */
export const GET = defineRoute({
  permission: "equity.read",
  feature: "equity",
  handler: async ({ authz, request }) => {
    const query = parseQuery(request, listQuery);
    if (!query.ok) return query.response;
    return NextResponse.json(
      await listSecurities({ orgId: authz.user.orgId, actorId: authz.user.id, ...query.data }),
    );
  },
});

/**
 * Issue a share certificate, option, RSU, warrant, SAFE or convertible note.
 * Cash consideration posts to the general ledger under the legal entity's
 * equity account policy; awards record their grant-date valuation.
 */
export const POST = defineRoute({
  permission: "equity.manage",
  feature: "equity",
  body: issueSecurityBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) => {
    const issued = await issueSecurity({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      ...body,
    });
    return NextResponse.json(issued, { status: issued.replayed ? 200 : 201 });
  },
});
