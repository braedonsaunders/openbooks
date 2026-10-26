import { NextResponse } from "next/server";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { notFound } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";
import { guardSubsidiaryScope } from "@/lib/authz";
import { loadReturnableSources, loadReturnPartyScope } from "@/lib/returns";

export const GET = defineRoute({
  permission: "orders.fulfill",
  feature: "returnAuthorizations",
  handler: async ({ request, authz }) => {
    const query = new URL(request.url).searchParams;
    const partyId = uuidString().safeParse(query.get("partyId"));
    const subsidiaryId = uuidString().safeParse(query.get("subsidiaryId"));
    if (!partyId.success || !subsidiaryId.success) return notFound("return_source");
    const itemId = query.get("itemId");
    const stockLocationId = query.get("stockLocationId");
    if (
      (itemId && !uuidString().safeParse(itemId).success) ||
      (stockLocationId && !uuidString().safeParse(stockLocationId).success)
    )
      return notFound("return_source");
    const party = await loadReturnPartyScope(authz.user.orgId, partyId.data);
    if (!party || guardSubsidiaryScope(authz, party.subsidiaryId, { orgWideNull: true }))
      return notFound("return_source");
    const page = await loadReturnableSources({
      orgId: authz.user.orgId,
      partyId: partyId.data,
      subsidiaryId: subsidiaryId.data,
      itemId: itemId ?? undefined,
      stockLocationId: stockLocationId ?? undefined,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    });
    if (!page) return notFound("return_source");
    return NextResponse.json(page);
  },
});
