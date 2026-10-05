import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import {
  getQuoteToCashSettings,
  saveQuoteToCashSettings,
} from "@openbooks/engine/billing/quote-to-cash";
import { db, withOrgContext } from "@openbooks/engine/platform/database";

export const runtime = "nodejs";

const settingsBody = z.object({
  maxDiscountPercent: z.string(),
  autoActivateOnSign: z.boolean(),
  defaultBillingTiming: z.enum(["advance", "arrears"]),
  defaultStartRule: z.enum(["quote_date", "first_of_next_month", "custom"]),
  signatureExpiryDays: z.number(),
  orderFormTemplateId: z.string().nullish(),
});

/**
 * The quote-to-cash policy row Setup edits (mutationPath of the
 * quote-to-cash-policy setup entity). GET reads the row or the working
 * defaults; POST upserts the singleton after validating every field.
 */
export const GET = defineRoute({
  permission: "ar.read",
  feature: "quoteToCash",
  handler: async ({ authz }) => {
    try {
      const settings = await withOrgContext(authz.user.orgId, () =>
        getQuoteToCashSettings(authz.user.orgId, db),
      );
      return NextResponse.json({ settings });
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "ar.create",
  feature: "quoteToCash",
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
