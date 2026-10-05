import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { z } from "zod";
import { CHANNEL_ACCOUNT_ROLES } from "@openbooks/engine/src/commerce/contracts.ts";
import { listAccountMaps, upsertAccountMap } from "@openbooks/engine/src/commerce/account-maps.ts";
import { CommerceError } from "@openbooks/engine/src/commerce/errors.ts";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

const upsertBodySchema = z.strictObject({
  role: z.enum(CHANNEL_ACCOUNT_ROLES),
  key: z.string().max(120).optional(),
  accountId: z.string().uuid(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "effectiveFrom must be YYYY-MM-DD"),
});

export const GET = defineRoute({
  permission: "channels.read",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    // An unknown channel reads as an empty map list: the channel GET above
    // already answers 404, so this list never oracles existence.
    const maps = await listAccountMaps(gate.user.orgId, id);
    return NextResponse.json({ maps });
  },
});

export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  body: upsertBodySchema,
  handler: async ({ authz: gate, params, body }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    try {
      const map = await upsertAccountMap(gate.user.orgId, gate.user.id, {
        channelId: id,
        role: body.role,
        key: body.key ?? "",
        accountId: body.accountId,
        effectiveFrom: body.effectiveFrom,
      });
      return NextResponse.json({ map });
    } catch (error) {
      if (error instanceof CommerceError && error.code === "channel_not_found") return notFound("channel");
      throw error;
    }
  },
});
