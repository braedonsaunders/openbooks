import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { replayChannelExceptions } from "@openbooks/engine/commerce";
import { guardUnrestrictedScope } from "@/lib/authz";
import { guardChannelScope } from "@/lib/channel-scope";

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
    // One channel answers to that channel's subsidiary; replaying every
    // channel spans subsidiaries outside a restricted caller's scope.
    const scopeDenied = body.channelId ? await guardChannelScope(gate, body.channelId) : guardUnrestrictedScope(gate);
    if (scopeDenied) return scopeDenied;
    const outcome = await replayChannelExceptions(
      gate.user.orgId,
      gate.user.id,
      body.channelId ?? null,
      body.code ?? null,
    );
    return NextResponse.json(outcome);
  },
});
