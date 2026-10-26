import { NextResponse } from "next/server";
import { creditItemsForParty, paymentPartyScope } from "@openbooks/engine/payments/payment-queries";
import { paymentErrorResponse } from "../lib";
import { guardPermission, guardSubsidiaryScope } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { notFound } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";

export const runtime = "nodejs";

/**
 * Posted, still-open credit-memo lines a receipt can apply: the mirror of
 * open-items, which lists only the debit items a payment extinguishes.
 * Credits carry the opposite sign and are consumed from the from_line side,
 * so they need their own reader — without it a posted credit memo is
 * invisible to every receipt flow.
 */
export const GET = defineRoute({
  authorize: async ({ request }) => {
    const side = new URL(request.url).searchParams.get("side");
    if (side !== "ap" && side !== "ar") {
      return NextResponse.json({ error: "side must be ap or ar" }, { status: 400 });
    }
    return guardPermission(side === "ap" ? "ap.pay" : "ar.pay");
  },
  feature: {
    none: "Credit application source lines are available under the side-specific payment permission.",
  },
  handler: async ({ request, authz: gate }) => {
    const url = new URL(request.url);
    const partyId = url.searchParams.get("partyId") ?? "";
    const side = url.searchParams.get("side");
    if (side !== "ap" && side !== "ar") {
      return NextResponse.json({ error: "side must be ap or ar" }, { status: 400 });
    }
    if (!isUuid(partyId))
      return NextResponse.json({ error: "partyId is required" }, { status: 400 });
    // The party is the record boundary; null-subsidiary parties are org-wide
    // (mirrors the party lists and the open-items reader).
    const party = await paymentPartyScope(gate.user.orgId, partyId);
    if (!party) return notFound("record");
    const scopeDenied = guardSubsidiaryScope(gate, party.subsidiaryId, { orgWideNull: true });
    if (scopeDenied) return scopeDenied;

    try {
      const items = await creditItemsForParty(
        partyId,
        side,
        gate.user.orgId,
        gate.allowedSubsidiaryIds,
      );
      return NextResponse.json({ items });
    } catch (e) {
      return paymentErrorResponse(e);
    }
  },
});
