import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { listOwnBankAccounts } from "@openbooks/engine/src/hrm/self-service/bank-changes.ts";
import { meErrorResponse } from "../_lib";

/**
 * The worker's own bank details, masked for self-service display. Sealed
 * account numbers are never selected — the last four is the only account
 * evidence that leaves storage. Active rows first, then pending ones
 * awaiting HR; retired history stays out.
 */
export const GET = defineRoute({
  permission: "hrm.self.read",
  feature: "hrm",
  handler: async ({ request: _req, authz: gate }) => {
    try {
      const accounts = await listOwnBankAccounts({ orgId: gate.user.orgId, actorId: gate.user.id });
      return NextResponse.json({ accounts });
    } catch (e) {
      return meErrorResponse(e);
    }
  },
});
