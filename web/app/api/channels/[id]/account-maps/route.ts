import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CHANNEL_ACCOUNT_ROLES,
  CommerceError,
  listAccountMaps,
  proposeShopifyAccountMaps,
  upsertAccountMap,
} from "@openbooks/engine/commerce";
import { isUuid } from "@/lib/list-params";
import { channelAccountsRefusal, guardChannelScope } from "@/lib/channel-scope";

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
    const outOfScope = await guardChannelScope(gate, id);
    if (outOfScope) return outOfScope;
    // An unknown channel reads as an empty map list: the channel GET above
    // already answers 404, so this list never oracles existence. Proposals
    // exist only for Shopify channels; other kinds read as no proposals.
    const [maps, proposals] = await Promise.all([
      listAccountMaps(gate.user.orgId, id),
      proposeShopifyAccountMaps(gate.user.orgId, id).catch((error: unknown) => {
        if (error instanceof CommerceError && error.code === "channel_not_found") return [];
        throw error;
      }),
    ]);
    return NextResponse.json({ maps, proposals });
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
    const outOfScope = await guardChannelScope(gate, id);
    if (outOfScope) return outOfScope;
    const accountRefused = await channelAccountsRefusal(gate, [body.accountId]);
    if (accountRefused) return accountRefused;
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
