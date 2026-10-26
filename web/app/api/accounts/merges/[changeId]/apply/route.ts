import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { can } from "@/lib/authz";
import { applyApprovedAccountMerge } from "@openbooks/engine/chart/account-merge";

export const runtime = "nodejs";

/** Apply an approved account merge proposal against its unchanged preview. */
export const POST = defineRoute({
  permission: "gl.manage",
  feature: "accountMerges",
  scope: "unrestricted",
  params: z.object({ changeId: uuidString() }),
  handler: async ({ authz, params: { changeId } }) => {
    if (!can(authz, "gl.post")) {
      return NextResponse.json(
        {
          error: "Applying an account merge posts reclass journal entries.",
          code: "forbidden",
          remedy: "Ask a user who can post journal entries to apply the merge.",
        },
        { status: 403 },
      );
    }
    try {
      return NextResponse.json(
        await applyApprovedAccountMerge(authz.user.orgId, {
          changeId,
          actorId: authz.user.id,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        }),
      );
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
