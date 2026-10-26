import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { submitPeriodReopen } from "@openbooks/engine/close/reopening";

export const runtime = "nodejs";
export const POST = defineRoute({
  permission: "close.reopen",
  feature: { none: "Period reopening retains its native controlled-scope and Flow authorization." },
  params: z.object({ id: uuidString() }),
  body: z.strictObject({}),
  handler: async ({ authz, params }) => {
    try {
      return NextResponse.json(
        await submitPeriodReopen({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          requestId: params.id,
        }),
      );
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
