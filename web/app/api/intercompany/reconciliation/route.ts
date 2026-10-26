import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { intercompanyReconciliation } from "@openbooks/engine/intercompany";
import { businessToday } from "@openbooks/engine/platform/business-date/module";

export const runtime = "nodejs";

/** Intercompany balances by pair and currency as of a date (default today), from the ledger. */
export const GET = defineRoute({
  permission: "intercompany.read",
  feature: "multiSubsidiary",
  handler: async ({ request, authz }) => {
    const asOfDate =
      new URL(request.url).searchParams.get("asOf") ?? (await businessToday(authz.user.orgId));
    return NextResponse.json({
      asOfDate,
      rows: await intercompanyReconciliation(authz.user.orgId, authz.allowedSubsidiaryIds, {
        asOfDate,
      }),
    });
  },
});
