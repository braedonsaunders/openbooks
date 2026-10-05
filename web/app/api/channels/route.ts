import { defineRoute } from "@/lib/api/route";
import { created } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createChannel, listChannels } from "@openbooks/engine/src/commerce/channels.ts";

export const runtime = "nodejs";

const createBodySchema = z.strictObject({
  kind: z.string().trim().min(1),
  name: z.string().trim().min(1),
  subsidiaryId: z.string().uuid().nullish(),
  currency: z.string().trim().min(3).max(3),
  externalAccount: z.string().trim().min(1),
  secrets: z.record(z.string(), z.unknown()).nullish(),
  webhookSecret: z.string().trim().min(1).nullish(),
  settings: z.record(z.string(), z.unknown()).nullish(),
});

export const GET = defineRoute({
  permission: "channels.read",
  feature: "salesChannels",
  handler: async ({ authz: gate }) => {
    const channels = await listChannels(gate.user.orgId);
    return NextResponse.json({ channels });
  },
});

export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  body: createBodySchema,
  handler: async ({ authz: gate, body }) => {
    const { channel, webhookSecret } = await createChannel(gate.user.orgId, gate.user.id, {
      kind: body.kind,
      name: body.name,
      subsidiaryId: body.subsidiaryId ?? null,
      currency: body.currency,
      externalAccount: body.externalAccount,
      secrets: body.secrets ?? null,
      webhookSecret: body.webhookSecret ?? null,
      settings: body.settings ?? {},
    });
    return created({ channel, webhookSecret });
  },
});
