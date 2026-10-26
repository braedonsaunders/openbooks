import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { withOrgTransaction } from "@openbooks/engine/platform/database";
import { validateStoredTaxId } from "@openbooks/engine/tax";
import { VatValidationError } from "@openbooks/engine/connectors";

export const runtime = "nodejs";

/**
 * Validate one stored customer tax ID against its authority now. A confirmed
 * verdict persists with the consultation reference; an authority outage
 * keeps the row unverified and answers 422 naming the retry — the drawer
 * shows the outage instead of a verdict nobody confirmed.
 */
export const POST = defineRoute({
  permission: "parties.manage",
  feature: "crossBorderTax",
  params: z.object({ id: uuidString() }),
  handler: async ({ authz: routeAuthz, params }) => {
    const gate = routeAuthz;
    try {
      const outcome = await withOrgTransaction(gate.user.orgId, async () => {
        try {
          return {
            kind: "validated" as const,
            result: await validateStoredTaxId(gate.user.orgId, params.id, gate.user.id),
          };
        } catch (error) {
          if (error instanceof VatValidationError)
            return { kind: "authority-unavailable" as const };
          throw error;
        }
      });
      if (outcome.kind === "authority-unavailable") {
        return NextResponse.json(
          {
            error:
              "the tax authority could not confirm this number; check the number and retry the validation",
          },
          { status: 422 },
        );
      }
      return NextResponse.json({ ok: true, ...outcome.result });
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 });
    }
  },
});
