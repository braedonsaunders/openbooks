import { apiErrorResponse } from "@/lib/api/error-response";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { unmatchStatementImport } from "@openbooks/engine/banking/banking";
import { isUuid } from "../../../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/** Unmatch every group touching an import's lines so its delete can proceed. Any
 * group already inside a signed-off session refuses the whole verb — the engine
 * names that session's cutoff. */
export const POST = defineRoute({
  permission: "banking.reconcile",
  feature: "banking",
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate;
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");

    try {
      const result = await unmatchStatementImport(id, {
        orgId: user.orgId,
        userId: user.id,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});
