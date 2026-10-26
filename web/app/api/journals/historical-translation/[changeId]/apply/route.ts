import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { historicalTranslationChangeParams } from "@/lib/api/historical-translation-schema";
import { applyHistoricalTranslationContribution } from "@openbooks/engine/journal/historical-translation-evidence";

export const runtime = "nodejs";

export const POST = defineRoute({
  permission: "close.run",
  feature: "multiCurrency",
  params: historicalTranslationChangeParams,
  invalidParamsNotFound: "record",
  handler: async ({ authz, params }) =>
    NextResponse.json(
      await applyHistoricalTranslationContribution({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        changeId: params.changeId,
      }),
    ),
});
