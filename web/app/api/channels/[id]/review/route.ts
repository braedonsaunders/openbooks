import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import {
  acceptShopifyReview,
  CHANNEL_ACCOUNT_ROLES,
  CommerceError,
  shopifyReview,
} from "@openbooks/engine/commerce";
import { isUuid } from "@/lib/list-params";
import { channelAccountsRefusal, guardChannelScope } from "@/lib/channel-scope";

export const runtime = "nodejs";

const acceptBodySchema = z.strictObject({
  accountMaps: z.array(
    z.strictObject({
      role: z.enum(CHANNEL_ACCOUNT_ROLES),
      key: z.string().max(120).optional(),
      accountId: z.string().uuid(),
    }),
  ),
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "effectiveFrom must be YYYY-MM-DD")
    .optional(),
});

function notFoundWhenMissing(error: unknown) {
  if (error instanceof CommerceError && error.code === "channel_not_found") return notFound("channel");
  throw error;
}

/** The connect review: match counts, locations and proposed posting accounts. */
export const GET = defineRoute({
  permission: "channels.read",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    const outOfScope = await guardChannelScope(gate, id);
    if (outOfScope) return outOfScope;
    try {
      return NextResponse.json(await shopifyReview(gate.user.orgId, id));
    } catch (error) {
      return notFoundWhenMissing(error);
    }
  },
});

/** Accept the review: store posting accounts and start syncing. */
export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  body: acceptBodySchema,
  handler: async ({ authz: gate, params, body }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    const outOfScope = await guardChannelScope(gate, id);
    if (outOfScope) return outOfScope;
    const accountRefused = await channelAccountsRefusal(gate, body.accountMaps.map((map) => map.accountId));
    if (accountRefused) return accountRefused;
    try {
      const accepted = await acceptShopifyReview(gate.user.orgId, gate.user.id, id, {
        accountMaps: body.accountMaps,
        effectiveFrom: body.effectiveFrom,
      });
      return NextResponse.json({ ...accepted, review: await shopifyReview(gate.user.orgId, id) });
    } catch (error) {
      return notFoundWhenMissing(error);
    }
  },
});
