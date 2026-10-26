import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import { fromUnits } from "@openbooks/engine/money";
import { listStoredValueCustomerCredits } from "@openbooks/engine/stored-value";
import { isUuid } from "@/lib/list-params";
import { notFound } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";

export const runtime = "nodejs";

/**
 * GET /api/stored-value/customer-credits?partyId= — the customer's
 * available store credit per account (id, masked code, currency, exact
 * decimal balance). Feeds the receipt tender picker; redemption itself
 * happens through the payment draft, which re-verifies everything.
 */
export const GET = defineRoute({
  permission: "stored_value.read",
  feature: "storedValue",
  handler: async ({ request, authz }) => {
    const url = new URL(request.url);
    const partyId = url.searchParams.get("partyId") ?? "";
    if (!isUuid(partyId))
      return NextResponse.json({ error: "partyId is required" }, { status: 400 });
    const credits = await listStoredValueCustomerCredits(db, {
      orgId: authz.user.orgId,
      partyId,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    });
    if (!credits) return notFound("record");
    return NextResponse.json({
      credits: credits.map(({ balanceMinor, ...credit }) => ({
        ...credit,
        balance: fromUnits(BigInt(balanceMinor)),
      })),
    });
  },
});
