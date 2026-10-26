import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date";
import { isUuid } from "@openbooks/engine/platform/identifiers";
import { vendorTrustSummary } from "@openbooks/engine/payables/ap-capture-service";

export const runtime = "nodejs";

/**
 * A vendor's earned capture trust ("Trusted: 3 clean bills in a row"),
 * derived from its capture history on every read. Vendor surfaces show it
 * beside the record; a vendor outside the caller's scope answers 404.
 */
export const GET = defineRoute({
  permission: "ap.read",
  feature: {
    none: "AP capture is governed by its document-capture configuration, not a feature switch.",
  },
  params: z.object({ vendorId: z.string() }),
  handler: async ({ authz, params: { vendorId } }) => {
    if (!isUuid(vendorId)) return notFound("record");
    const summary = await vendorTrustSummary(
      db,
      authz.user.orgId,
      vendorId,
      authz.allowedSubsidiaryIds,
      await businessToday(authz.user.orgId),
    );
    if (!summary) return notFound("record");
    return NextResponse.json(summary);
  },
});
