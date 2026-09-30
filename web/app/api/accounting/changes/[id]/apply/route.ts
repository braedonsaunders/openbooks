import { applyNetInvestmentAssessment,applyNetInvestmentReversal } from '@openbooks/engine/consolidation'
import { applyDropShipAssessment } from '@openbooks/engine/inventory'
import { applyExpectedBreakage } from '@openbooks/engine/revenue'
import { applyProvisionAssessment } from "@openbooks/engine/provisions";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { applyAssetGroupValuation } from "@openbooks/engine/src/assets/group-valuations.ts";
import {
  applyLossOfControl,
  applyLossOfControlReversal,
} from "@openbooks/engine/src/consolidation/loss-of-control.ts";
import { NextResponse } from "next/server";
import { applyAssetChange } from "@openbooks/engine/src/assets/asset-changes.ts";
import { applyLeaseChange } from "@openbooks/engine/src/revenue/lease-changes.ts";
import { applyRevenueModification } from "@openbooks/engine/src/revenue/contract-modifications.ts";
import { authorizeChange } from "../../_authorization";
export const runtime = "nodejs";
export const POST = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, params }) => {
    const { id } = await params,
      gate = await authorizeChange(id, "apply");
    if (gate instanceof NextResponse) return gate;
    try {
      if (gate.domain === "sales") return NextResponse.json(await applyDropShipAssessment(gate.auth.user.orgId,id,gate.auth.user.id));
      if (gate.domain === "provision")
        return NextResponse.json(await applyProvisionAssessment(gate.auth.user.orgId, id, gate.auth.user.id));
      if (gate.domain === "consolidation")
        return NextResponse.json(
          await (
            gate.operation === "net_investment_oci_reversal" ? applyNetInvestmentReversal : gate.operation === "net_investment_oci" ? applyNetInvestmentAssessment : gate.operation === "reversal"
              ? applyLossOfControlReversal
              : applyLossOfControl
          )(gate.auth.user.orgId, id, gate.auth.user.id),
        );
      if (gate.domain === "asset")
        return NextResponse.json(
          await (
            gate.operation === "group_valuation"
              ? applyAssetGroupValuation
              : applyAssetChange
          )(gate.auth.user.orgId, id, gate.auth.user.id),
        );
      if (gate.domain === "revenue")
        return NextResponse.json(
          await (gate.operation==='expected_breakage_estimate' ? applyExpectedBreakage : applyRevenueModification)(
            gate.auth.user.orgId,
            id,
            gate.auth.user.id,
          ),
        );
      if (gate.domain !== "lease")
        return NextResponse.json(
          { error: "no matching lifecycle action" },
          { status: 422 },
        );
      return NextResponse.json(
        await applyLeaseChange(gate.auth.user.orgId, id, gate.auth.user.id),
      );
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});
