import { z } from "zod";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import { listSessions, openSession } from "@openbooks/engine/pos";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { uuidId } from "@/lib/api/json";
import { posCountSchema } from "@/lib/api/pos-schemas";
import { posJson } from "@/lib/pos";

export const runtime = "nodejs";

const ListQuery = z.object({
  registerId: uuidId.optional(),
  status: z.enum(["open", "closed"]).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

/** GET /api/pos/sessions — drawer session history (Z reports), newest first. */
export const GET = defineRoute({
  permission: "pos.drawer",
  feature: "posRegister",
  handler: async ({ authz, request }) => {
    const params = new URL(request.url).searchParams;
    const parsed = ListQuery.safeParse(
      Object.fromEntries([...params.entries()].filter(([, value]) => value !== "")),
    );
    if (!parsed.success)
      return NextResponse.json(
        {
          error: "Use a valid register, status (open or closed) and dates (YYYY-MM-DD).",
          code: "invalid_query",
        },
        { status: 422 },
      );
    try {
      return NextResponse.json(
        await listSessions(db, authz.user.orgId, parsed.data, authz.allowedSubsidiaryIds ?? null),
      );
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});

/** POST /api/pos/sessions — open a drawer session on a register with its counted float. */
export const POST = defineRoute({
  permission: "pos.drawer",
  feature: "posRegister",
  body: z.object({ registerId: uuidId, openingCount: posCountSchema }).strict(),
  handler: async ({ authz, body }) => {
    try {
      const session = await openSession({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        registerId: body.registerId,
        openingCount: body.openingCount,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds ?? null,
      });
      return NextResponse.json({ session: posJson(session) }, { status: 201 });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
