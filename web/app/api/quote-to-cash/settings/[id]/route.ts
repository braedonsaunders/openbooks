import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import {
  clearQuoteToCashSettings,
  saveQuoteToCashSettings,
} from "@openbooks/engine/billing/quote-to-cash";

export const runtime = "nodejs";

const params = z.object({ id: z.string() });

const settingsBody = z.object({
  maxDiscountPercent: z.string(),
  autoActivateOnSign: z.boolean(),
  defaultBillingTiming: z.enum(["advance", "arrears"]),
  defaultStartRule: z.enum(["quote_date", "first_of_next_month", "custom"]),
  signatureExpiryDays: z.number(),
  orderFormTemplateId: z.string().nullish(),
});

/**
 * Edit and reset the quote-to-cash policy row (the Setup drawer's PATCH
 * and DELETE land here; creates POST the collection). Every write runs
 * the same validated singleton upsert.
 */
export const PATCH = defineRoute({
  permission: "ar.create",
  feature: "quoteToCash",
  params,
  body: settingsBody,
  handler: async ({ authz, body }) => {
    try {
      return NextResponse.json({
        settings: await saveQuoteToCashSettings(authz.user.orgId, authz.user.id, {
          maxDiscountPercent: body.maxDiscountPercent,
          autoActivateOnSign: body.autoActivateOnSign,
          defaultBillingTiming: body.defaultBillingTiming,
          defaultStartRule: body.defaultStartRule,
          signatureExpiryDays: body.signatureExpiryDays,
          orderFormTemplateId: body.orderFormTemplateId,
        }),
      });
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});

export const DELETE = defineRoute({
  permission: "ar.create",
  feature: "quoteToCash",
  params,
  handler: async ({ authz }) => {
    try {
      return NextResponse.json(await clearQuoteToCashSettings(authz.user.orgId, authz.user.id));
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});
