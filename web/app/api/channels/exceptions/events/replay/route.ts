import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { replayChannelEventExceptions } from "@openbooks/engine/src/commerce/exceptions.ts";

export const runtime = "nodejs";

const replayBodySchema = z.strictObject({
  channelId: z.string().uuid().nullish(),
  code: z.string().max(60).nullish(),
});

/**
 * Fix-all-similar for the event queue: replay every parked refund,
 * cancellation and fulfilment, or every one parked under one cause, after
 * the operator fixed it.
 */
export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  body: replayBodySchema,
  handler: async ({ authz: gate, body }) => {
    const outcome = await replayChannelEventExceptions(
      gate.user.orgId,
      gate.user.id,
      body.channelId ?? null,
      body.code ?? null,
    );
    return NextResponse.json(outcome);
  },
});
