import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import { findPosReceiptByNumber } from "@openbooks/engine/pos";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/** GET /api/pos/receipts?number= — find a cash sale receipt by its number, for a refund. */
export const GET = defineRoute({
  permission: "pos.sell",
  feature: "posRegister",
  handler: async ({ authz, request }) => {
    const number = new URL(request.url).searchParams.get("number") ?? "";
    const id = await findPosReceiptByNumber(
      db,
      authz.user.orgId,
      number,
      authz.allowedSubsidiaryIds ?? null,
    );
    if (!id) return notFound("record");
    return NextResponse.json({ documentId: id });
  },
});
