import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { db, withOrgTransaction } from "@openbooks/engine/platform/database";
import { savePartyTaxId } from "@openbooks/engine/tax";
import { listPartyTaxIds } from "@openbooks/engine/tax/party-tax-ids-read";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

const POSTBodySchema = z.object({
  partyId: uuidString(),
  scheme: z.enum(["vies", "hmrc", "abn", "gst"]),
  value: z.string().min(1).max(40),
});

/**
 * Customer tax IDs: list the validated numbers on a customer record, and
 * record a new number for validation. Recording normalizes the number and
 * reuses the standing row when the number is already on file. Writes hold
 * the crossBorderTax feature lock.
 */
export const GET = defineRoute({
  permission: "parties.read",
  feature: "crossBorderTax",
  handler: async ({ authz: routeAuthz, request }) => {
    const gate = routeAuthz;
    const partyId = new URL(request.url).searchParams.get("partyId");
    if (!partyId || !isUuid(partyId)) {
      return NextResponse.json({ error: "partyId (uuid) is required" }, { status: 400 });
    }
    try {
      const rows = await listPartyTaxIds(db, gate.user.orgId, partyId);
      return NextResponse.json({ taxIds: rows });
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 });
    }
  },
});

export const POST = defineRoute({
  permission: "parties.manage",
  feature: "crossBorderTax",
  body: POSTBodySchema,
  handler: async ({ authz: routeAuthz, body: routeBody }) => {
    const gate = routeAuthz;
    const { partyId, scheme, value } = routeBody as {
      partyId: string;
      scheme: "vies" | "hmrc" | "abn" | "gst";
      value: string;
    };
    try {
      const saved = await withOrgTransaction(gate.user.orgId, () =>
        savePartyTaxId(db, gate.user.orgId, { partyId, scheme, value }, gate.user.id),
      );
      return NextResponse.json({ ok: true, ...saved });
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 });
    }
  },
});
