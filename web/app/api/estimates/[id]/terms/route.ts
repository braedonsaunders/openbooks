import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import {
  deleteQuoteTerm,
  quoteCashPreview,
  saveQuoteTerm,
} from "@openbooks/engine/billing/quote-to-cash";

export const runtime = "nodejs";

const params = z.object({ id: z.string() });

const rampStep = z.object({
  startsAfterMonths: z.number(),
  unitPrice: z.string(),
  quantity: z.string(),
  escalatorPercent: z.string().nullish(),
});

const termBody = z.object({
  termId: z.string().nullish(),
  quoteLineId: z.string(),
  planId: z.string(),
  planVersionId: z.string().nullish(),
  termMonths: z.number(),
  startRule: z.enum(["quote_date", "first_of_next_month", "custom"]).nullish(),
  billingTiming: z.enum(["advance", "arrears"]).nullish(),
  cotermSubscriptionId: z.string().nullish(),
  steps: z.array(rampStep),
});

/**
 * Quote subscription terms: the drawer's Subscription section reads the
 * valued preview and writes terms through here. Reads ride ar.read;
 * writes ride ar.create (the same duty as editing the quote), always
 * behind the quoteToCash leaf gate — the registry resolves its
 * orders + subscriptionBilling parents.
 */
export const GET = defineRoute({
  permission: "ar.read",
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
  body: termBody,
  handler: async ({ authz, params, body }) => {
    try {
      return NextResponse.json(
        await saveQuoteTerm(authz.user.orgId, authz.user.id, params.id, {
          termId: body.termId,
          quoteLineId: body.quoteLineId,
          planId: body.planId,
          planVersionId: body.planVersionId,
          termMonths: body.termMonths,
          startRule: body.startRule,
          billingTiming: body.billingTiming,
          cotermSubscriptionId: body.cotermSubscriptionId,
          steps: body.steps.map((s) => ({
            startsAfterMonths: s.startsAfterMonths,
            unitPrice: s.unitPrice,
            quantity: s.quantity,
            escalatorPercent: s.escalatorPercent,
          })),
        }),
      );
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});

export const DELETE = defineRoute({
  permission: "ar.create",
  feature: "quoteToCash",
  params,
  handler: async ({ request, authz, params }) => {
    try {
      const termId = new URL(request.url).searchParams.get("termId");
      if (!termId) return NextResponse.json({ error: "termId is required" }, { status: 400 });
      return NextResponse.json(await deleteQuoteTerm(authz.user.orgId, authz.user.id, params.id, termId));
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});
