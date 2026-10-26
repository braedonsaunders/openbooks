import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AutopayError, markExpiryOutreachSent } from "@openbooks/engine/payments/autopay";
import { defineRoute } from "@/lib/api/route";
import { isUuid } from "@/lib/list-params";
import { businessToday, isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { guardPaymentMethodScope } from "@/lib/autopay-scope";

export const runtime = "nodejs";

const outreachBody = z.object({
  sentOn: z
    .string()
    .refine(isIsoCalendarDate, "must be a valid calendar date in YYYY-MM-DD format")
    .optional(),
});

/**
 * Record pre-expiry outreach as sent for one stored card. The row leaves the
 * expiring-cards queue; a card updater refresh that moves the expiry clears
 * the stamp, so the new date notifies on its own.
 */
export const POST = defineRoute({
  permission: "payment_methods.manage",
  feature: "autopay",
  body: outreachBody,
  opaque: {
    sentOn: "an omitted date records the organization's business date",
  },
  handler: async ({ authz, body, params: routeParams }) => {
    const { id } = (routeParams ?? {}) as { id?: string };
    if (!id || !isUuid(id))
      return NextResponse.json({ error: "method id is required" }, { status: 400 });
    const outOfScope = await guardPaymentMethodScope(authz, id);
    if (outOfScope) return outOfScope;
    try {
      const sentOn = body.sentOn ?? (await businessToday(authz.user.orgId));
      await markExpiryOutreachSent(
        authz.user.orgId,
        [id],
        sentOn,
        authz.allowedSubsidiaryIds,
        authz.user.id,
      );
      return NextResponse.json({ ok: true });
    } catch (e) {
      if (e instanceof AutopayError) return apiErrorResponse(e, { safeStatus: 422 });
      throw e;
    }
  },
});
