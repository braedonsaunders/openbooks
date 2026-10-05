import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { replayChannelEventExceptions } from "@openbooks/engine/commerce";
import { guardUnrestrictedScope } from "@/lib/authz";
import { guardChannelScope } from "@/lib/channel-scope";

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
    // One channel answers to that channel's subsidiary; replaying every
    // channel spans subsidiaries outside a restricted caller's scope.
    const scopeDenied = body.channelId ? await guardChannelScope(gate, body.channelId) : guardUnrestrictedScope(gate);
    if (scopeDenied) return scopeDenied;
    const outcome = await replayChannelEventExceptions(
      gate.user.orgId,
      gate.user.id,
      body.channelId ?? null,
      body.code ?? null,
    );
    return NextResponse.json(outcome);
  },
});
