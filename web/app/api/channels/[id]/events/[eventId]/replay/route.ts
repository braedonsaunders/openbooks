import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { z } from "zod";
import { CommerceError, replayEvent } from "@openbooks/engine/commerce";
import { isUuid } from "@/lib/list-params";
import { guardChannelScope } from "@/lib/channel-scope";

export const runtime = "nodejs";

const replayBodySchema = z.strictObject({
  reason: z.string().trim().min(1),
});

export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string(), eventId: z.string() }),
  body: replayBodySchema,
  handler: async ({ authz: gate, params, body }) => {
    const { id, eventId } = await params;
    if (!isUuid(id) || !isUuid(eventId)) return notFound("event");
    const outOfScope = await guardChannelScope(gate, id);
    if (outOfScope) return outOfScope;
    try {
      const event = await replayEvent(gate.user.orgId, gate.user.id, eventId, body.reason, id);
      return NextResponse.json({ event });
    } catch (error) {
      // Another channel's event and a missing id answer alike.
      if (error instanceof CommerceError && error.code === "inbound_event_not_found") {
        return notFound("event");
      }
      throw error;
    }
  },
});
