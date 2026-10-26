import { apiErrorResponse } from "@/lib/api/error-response";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { correctStatementBalances, deleteStatementImport } from "@openbooks/engine/banking/banking";
import { isUuid } from "../../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";
const PATCHBodySchema1 = z
  .object({
    openingBalance: z.string().trim().min(1).nullable().optional(),
    closingBalance: z.string().trim().min(1).nullable().optional(),
  })
  .refine((body) => body.openingBalance !== undefined || body.closingBalance !== undefined, {
    message: "balances need at least one of openingBalance or closingBalance",
  });

export const runtime = "nodejs";

/** Set an imported statement's opening/closing balances before any match. Only an
 * unmatched import outside signed-off history can move — the engine refuses matched
 * and signed-off-history statements with named remedies. */
export const PATCH = defineRoute({
  permission: "banking.reconcile",
  feature: "banking",
  body: PATCHBodySchema1,
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate;
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");

    const body = routeBody as { openingBalance?: string | null; closingBalance?: string | null };
    try {
      const result = await correctStatementBalances(
        id,
        {
          ...(body.openingBalance !== undefined ? { openingBalance: body.openingBalance } : {}),
          ...(body.closingBalance !== undefined ? { closingBalance: body.closingBalance } : {}),
        },
        {
          orgId: user.orgId,
          userId: user.id,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        },
      );
      return NextResponse.json({ ok: true, ...result });
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});

/** Delete a whole statement import with every line it brought in. Only an
 * untouched import can go — the engine refuses matched, excluded,
 * signed-off-history and duplicate-flagged imports with named remedies. */
export const DELETE = defineRoute({
  permission: "banking.reconcile",
  feature: "banking",
  handler: async ({ authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate;
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");

    try {
      const result = await deleteStatementImport(id, {
        orgId: user.orgId,
        userId: user.id,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      });
      return NextResponse.json({ ok: true, deletedLines: result.deletedLines });
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});
