import { applyAssetGroupValuation } from "@openbooks/engine/src/assets/group-valuations.ts";
import {
  applyLossOfControl,
  applyLossOfControlReversal,
} from "@openbooks/engine/src/consolidation/loss-of-control.ts";
import { NextResponse } from "next/server";
import { applyAssetChange } from "@openbooks/engine/src/assets/asset-changes.ts";
import { applyLeaseChange } from "@openbooks/engine/src/revenue/lease-changes.ts";
import { applyRevenueModification } from "@openbooks/engine/src/revenue/contract-modifications.ts";
import {
  applyTaxAssetBasis,
  applyTaxAssetBasisReversal,
} from "@openbooks/engine/src/tax-returns/asset-basis-workpaper.ts";
import { authorizeChange } from "../../_authorization";
import {
  applyTaxMatchingGenerationRepair,
  applyTaxMatchingReplay,
} from "@openbooks/engine/src/tax-returns/consolidated-matching-replay.ts";
export const runtime = "nodejs";
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params,
    gate = await authorizeChange(id);
  if (gate instanceof NextResponse) return gate;
  try {
    if (gate.domain === "consolidation")
      return NextResponse.json(
        await (
          gate.operation === "reversal"
            ? applyLossOfControlReversal
            : applyLossOfControl
        )(gate.auth.user.orgId, id, gate.auth.user.id),
      );
    if (gate.domain === "asset")
      return NextResponse.json(
        await (
          gate.operation === "group_valuation"
            ? applyAssetGroupValuation
            : gate.operation === "tax_basis"
              ? applyTaxAssetBasis
              : gate.operation === "tax_basis_reversal"
                ? applyTaxAssetBasisReversal
                : gate.operation === "tax_matching_replay"
                  ? applyTaxMatchingReplay
                  : gate.operation === "tax_matching_generation_repair"
                    ? applyTaxMatchingGenerationRepair
                    : applyAssetChange
        )(gate.auth.user.orgId, id, gate.auth.user.id),
      );
    if (gate.domain === "revenue")
      return NextResponse.json(
        await applyRevenueModification(
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
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "change could not be applied" },
      { status: 422 },
    );
  }
}
