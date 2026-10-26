import { NextResponse } from "next/server";
import {
  isActivePaymentSubsidiary,
  openItemsForParty,
  paymentPartyScope,
} from "@openbooks/engine/payments/payment-queries";
import { guardPermission, guardSubsidiaryScope } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { paymentErrorResponse } from "../lib";
import { notFound } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";

export const runtime = "nodejs";

/** Open AP or AR items for a party, with applied-to-date and open balances. */
export const GET = defineRoute({
  authorize: async ({ request }) => {
    const side = new URL(request.url).searchParams.get("side");
    if (side !== "ap" && side !== "ar")
      return NextResponse.json({ error: "side must be ap or ar" }, { status: 400 });
    return guardPermission(side === "ap" ? "ap.pay" : "ar.pay");
  },
  feature: { none: "Open items require the payment permission matching their AP or AR side." },
  handler: async ({ request, authz: gate }) => {
    const url = new URL(request.url);
    const partyId = url.searchParams.get("partyId") ?? "";
    const side = url.searchParams.get("side");
    const subsidiaryId = url.searchParams.get("subsidiaryId");
    if (side !== "ap" && side !== "ar") {
      return NextResponse.json({ error: "side must be ap or ar" }, { status: 400 });
    }
    if (!isUuid(partyId))
      return NextResponse.json({ error: "partyId is required" }, { status: 400 });
    // The party is the record boundary; null-subsidiary parties are org-wide
    // (mirrors the party lists).
    const party = await paymentPartyScope(gate.user.orgId, partyId);
    if (!party) return notFound("record");
    const scopeDenied = guardSubsidiaryScope(gate, party.subsidiaryId, { orgWideNull: true });
    if (scopeDenied) return scopeDenied;
    if (subsidiaryId) {
      if (!isUuid(subsidiaryId)) return notFound("record");
      const entityDenied = guardSubsidiaryScope(gate, subsidiaryId);
      if (entityDenied) return entityDenied;
      if (!(await isActivePaymentSubsidiary(gate.user.orgId, subsidiaryId)))
        return notFound("record");
    }

    try {
      const items = await openItemsForParty(
        partyId,
        side,
        gate.user.orgId,
        subsidiaryId ? new Set([subsidiaryId]) : gate.allowedSubsidiaryIds,
      );
      return NextResponse.json({ items });
    } catch (e) {
      return paymentErrorResponse(e);
    }
  },
});
