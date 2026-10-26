import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/database";
import { fromUnits } from "@openbooks/engine/money";
import { readStoredValueTenderLookup } from "@openbooks/engine/stored-value";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/** Resolve a gift card / store credit code to its account and live balance for tender entry. */
export const GET = defineRoute({
  permission: "stored_value.read",
  feature: "storedValue",
  handler: async ({ request, authz: gate }) => {
    const code = new URL(request.url).searchParams.get("code")?.trim() ?? "";
    if (!code) return NextResponse.json({ error: "code_required" }, { status: 422 });
    const account = await readStoredValueTenderLookup(db, {
      orgId: gate.user.orgId,
      code,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
    if (!account) return notFound("record");
    return NextResponse.json({
      accountId: account.id,
      balance: fromUnits(BigInt(account.balanceMinor)),
      currency: account.currency,
      status: account.status,
      last4: account.last4,
    });
  },
});
