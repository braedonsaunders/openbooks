import { apiErrorResponse } from "@/lib/api/error-response";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { confirmOpeningBalance } from "@openbooks/engine/banking/banking";
import { isUuid } from "../../../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";
const POSTBodySchema1 = z.object({
  openingBalance: z.string().min(1),
  reason: z.string().min(5).max(500),
});

export const runtime = "nodejs";

/** Confirm the opening position of an account's first reconciliation from a balance-less statement. */
export const POST = defineRoute({
  permission: "banking.reconcile",
  feature: "banking",
  body: POSTBodySchema1,
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate;
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");

    const body = routeBody as { openingBalance?: string; reason?: string };
    if (
      typeof body.openingBalance !== "string" ||
      body.openingBalance.trim() === "" ||
      typeof body.reason !== "string" ||
      body.reason.trim().length < 5 ||
      body.reason.trim().length > 500
    ) {
      return NextResponse.json(
        { error: "openingBalance is required with a reason between 5 and 500 characters" },
        { status: 400 },
      );
    }
    try {
      const totals = await confirmOpeningBalance(
        id,
        { openingBalance: body.openingBalance, reason: body.reason },
        { orgId: user.orgId, userId: user.id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
      );
      return NextResponse.json({ ok: true, totals });
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});
