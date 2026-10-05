import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { replayChannelExceptions } from "@openbooks/engine/src/commerce/exceptions.ts";

export const runtime = "nodejs";

const replayBodySchema = z.strictObject({
  channelId: z.string().uuid().nullish(),
  code: z.string().max(60).nullish(),
});

/**
 * Fix-all-similar: replay every parked order, or every order parked under
 * one cause, after the operator fixed it. Per-order posts land now;
 * summary-mode orders rejoin their batch at cut-off.
 */
export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  body: replayBodySchema,
  handler: async ({ authz: gate, body }) => {
    const outcome = await replayChannelExceptions(
      gate.user.orgId,
      gate.user.id,
      body.channelId ?? null,
      body.code ?? null,
    );
    return NextResponse.json(outcome);
  },
});
