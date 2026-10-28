import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { can } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import {
  loadStatementParty,
  sendPartyStatement,
  statementPartyInScope,
  statementRecipient,
  type StatementSide,
} from "@/lib/party-statement";

export const runtime = "nodejs";

const statementBody = z
  .object({
    side: z.enum(["ar", "ap"]).optional(),
    to: z.string().optional(),
    message: z.string().optional(),
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    toDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict()
  .optional();

function sideOf(request: Request, body?: { side?: unknown }): StatementSide {
  const raw =
    typeof body?.side === "string" ? body.side : new URL(request.url).searchParams.get("side");
  return raw === "ap" ? "ap" : "ar";
}

export const GET = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  handler: async ({ request, authz, params }) => {
    const side = sideOf(request);
    const permission = side === "ap" ? "ap.read" : "ar.read";
    if (!can(authz, permission)) {
      return NextResponse.json({ error: `missing permission: ${permission}` }, { status: 403 });
    }
    if (!isUuid(params.id)) return notFound("record");
    const party = await loadStatementParty(authz.user.orgId, params.id);
    if (!party || !statementPartyInScope(authz.allowedSubsidiaryIds, party)) {
      return notFound("record");
    }
    return NextResponse.json({
      to: await statementRecipient(authz.user.orgId, party),
      partyName: party.display_name,
    });
  },
});

export const POST = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  body: statementBody,
  handler: async ({ request, authz, params, body }) => {
    if (body === undefined)
      return NextResponse.json({ error: "invalid request body" }, { status: 400 });
    const result = await sendPartyStatement(authz, params.id, {
      ...body,
      side: sideOf(request, body),
    });
    return result instanceof NextResponse ? result : NextResponse.json(result);
  },
});
