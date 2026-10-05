import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  disconnectChannel,
  pauseChannel,
  resumeChannel,
  retryChannel,
} from "@openbooks/engine/src/commerce/channels.ts";
import { CommerceError } from "@openbooks/engine/src/commerce/errors.ts";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

const lifecycleBodySchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("pause"), reason: z.string().trim().min(1) }),
  z.strictObject({ action: z.literal("resume"), reason: z.string().trim().min(1) }),
  z.strictObject({ action: z.literal("disconnect"), reason: z.string().trim().min(1) }),
  z.strictObject({ action: z.literal("retry"), reason: z.string().trim().min(1) }),
]);

export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  body: lifecycleBodySchema,
  handler: async ({ authz: gate, params, body }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    try {
      const channel =
        body.action === "pause"
          ? await pauseChannel(gate.user.orgId, gate.user.id, id, body.reason)
          : body.action === "resume"
            ? await resumeChannel(gate.user.orgId, gate.user.id, id, body.reason)
            : body.action === "disconnect"
              ? await disconnectChannel(gate.user.orgId, gate.user.id, id, body.reason)
              : await retryChannel(gate.user.orgId, gate.user.id, id, body.reason);
      return NextResponse.json({ channel });
    } catch (error) {
      if (error instanceof CommerceError && error.code === "channel_not_found") return notFound("channel");
      throw error;
    }
  },
});
