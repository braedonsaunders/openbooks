import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { intercompanyWorkspace } from "@openbooks/engine/intercompany";

export const runtime = "nodejs";

/** The pairing workspace: unpaired, mismatched and paired intercompany documents. */
export const GET = defineRoute({
  permission: "intercompany.read",
  feature: "intercompanyTransactions",
  handler: async ({ request, authz }) => {
    const subsidiaryId = new URL(request.url).searchParams.get("sub");
    return NextResponse.json(
      await intercompanyWorkspace(authz.user.orgId, authz.allowedSubsidiaryIds, { subsidiaryId }),
    );
  },
});
