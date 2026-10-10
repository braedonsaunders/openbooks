import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import {
  activateQuote,
  quoteCashPreview,
} from "@openbooks/engine/billing/quote-to-cash";

export const runtime = "nodejs";

const params = z.object({ id: z.string() });

const activateBody = z.object({
  startOn: z.string().nullish(),
});

/**
 * Activate a signed quote into billed subscriptions. GET previews the
 * consequence (subscriptions, first bill dates, revenue contract) before
 * committing; POST creates everything in one idempotent transaction.
 * Previewing rides the quote grant; activating mints billed subscriptions,
 * so it keeps the receivables book's authority.
 */
export const GET = defineRoute({
  permission: "estimates.read",
  feature: "quoteToCash",
  params,
  handler: async ({ authz, params }) => {
    try {
      return NextResponse.json(await quoteCashPreview(authz.user.orgId, params.id));
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "ar.create",
  feature: "quoteToCash",
  params,
  body: activateBody,
  handler: async ({ authz, params, body }) => {
    try {
      return NextResponse.json(
        await activateQuote(authz.user.orgId, authz.user.id, params.id, {
          startOn: body.startOn,
        }),
      );
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});
