import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import {
  historicalTranslationProposalBody,
  historicalTranslationSourceParams,
} from "@/lib/api/historical-translation-schema";
import { notFound } from "@/lib/api/responses";
import {
  proposeHistoricalTranslationContribution,
  readHistoricalTranslationAuthoringContext,
} from "@openbooks/engine/journal/historical-translation-evidence";

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "close.run",
  feature: "multiCurrency",
  handler: async ({ request, authz }) => {
    const parsed = historicalTranslationSourceParams.safeParse({
      sourceLineId: new URL(request.url).searchParams.get("sourceLineId"),
    });
    if (!parsed.success) return notFound("record");
    return NextResponse.json(
      await readHistoricalTranslationAuthoringContext({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        sourceLineId: parsed.data.sourceLineId,
      }),
    );
  },
});

export const POST = defineRoute({
  permission: "close.run",
  feature: "multiCurrency",
  body: historicalTranslationProposalBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) =>
    NextResponse.json(
      await proposeHistoricalTranslationContribution({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        ...body,
      }),
      { status: 201 },
    ),
});
