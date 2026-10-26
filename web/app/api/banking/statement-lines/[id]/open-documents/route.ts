import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { notFound } from "@/lib/api/responses";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { isUuid } from "../../../../../../lib/list-params";
import { listOpenDocumentCandidates } from "../../../../../../lib/banking-match-candidates";

export const runtime = "nodejs";

/**
 * Open invoices (money in) or bills (money out) an unmatched bank line could
 * settle, ranked with reasons: ?reconciliationId=<session>. Disclosing open
 * items additionally requires ar.pay or ap.pay for the line's direction.
 */
export const GET = defineRoute({
  permission: "banking.reconcile",
  feature: "banking",
  handler: async ({ request, authz, params }) => {
    const { id } = params as { id: string };
    const reconciliationId = new URL(request.url).searchParams.get("reconciliationId") ?? "";
    if (!isUuid(id)) return notFound("record");
    if (!isUuid(reconciliationId)) {
      return NextResponse.json(
        { error: "reconciliationId is required", field: "reconciliationId" },
        { status: 400 },
      );
    }
    try {
      const candidates = await listOpenDocumentCandidates(
        authz.user.orgId,
        authz.user.id,
        { statementLineId: id, reconciliationId },
        authz.allowedSubsidiaryIds,
      );
      return NextResponse.json(candidates);
    } catch (error) {
      if (error instanceof ScopeNotFoundError) return notFound("record");
      return apiErrorResponse(error);
    }
  },
});
