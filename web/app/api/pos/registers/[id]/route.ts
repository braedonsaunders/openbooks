import { z } from "zod";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import { readRegisterContext } from "@openbooks/engine/pos";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { uuidId } from "@/lib/api/json";
import { posJson } from "@/lib/pos";

export const runtime = "nodejs";

/** GET /api/pos/registers/[id] — what the register screen needs: configuration, accepted tenders, open session, quick keys and cash reasons. */
export const GET = defineRoute({
  permission: "pos.sell",
  feature: "posRegister",
  params: z.object({ id: uuidId }),
  invalidParamsNotFound: "record",
  handler: async ({ authz, params }) => {
    try {
      return NextResponse.json(
        posJson(
          await readRegisterContext(
            db,
            authz.user.orgId,
            params.id,
            authz.allowedSubsidiaryIds ?? null,
          ),
        ),
      );
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
