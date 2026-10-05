import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { appBaseUrl } from "@openbooks/engine/flows";
import {
  CommerceError,
  SHOPIFY_OAUTH_COOKIE,
  shopifyReview,
  startShopifyConnect,
} from "@openbooks/engine/commerce";

export const runtime = "nodejs";

const connectBodySchema = z.strictObject({
  shop: z.string().trim().min(1),
  mode: z.enum(["oauth", "token"]),
  accessToken: z.string().trim().min(1).nullish(),
  webhookSecret: z.string().trim().min(1).nullish(),
  pushCatalog: z.boolean().optional(),
});

/**
 * Begin connecting a Shopify store. Token connect verifies, subscribes,
 * imports and returns the review synchronously; OAuth connect returns the
 * install URL plus a session-bound nonce cookie for the callback.
 */
export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  body: connectBodySchema,
  handler: async ({ authz: gate, body }) => {
    try {
      const started = await startShopifyConnect(gate.user.orgId, gate.user.id, {
        shop: body.shop,
        mode: body.mode,
        accessToken: body.accessToken ?? undefined,
        webhookSecret: body.webhookSecret ?? undefined,
        pushCatalog: body.pushCatalog,
        webOrigin: appBaseUrl(),
      });
      if (started.mode === "token") {
        const review = await shopifyReview(gate.user.orgId, started.channelId);
        return NextResponse.json({ ...started, review });
      }
      const response = NextResponse.json(started);
      if (started.oauthNonce) {
        response.cookies.set(SHOPIFY_OAUTH_COOKIE, started.oauthNonce, {
          httpOnly: true,
          sameSite: "lax",
          secure: new URL(appBaseUrl()).protocol === "https:",
          maxAge: 10 * 60,
          path: "/api/channels/shopify/oauth",
        });
        response.headers.set("Cache-Control", "no-store");
      }
      return response;
    } catch (error) {
      if (error instanceof CommerceError && error.code === "channel_not_found") return notFound("channel");
      throw error;
    }
  },
});
