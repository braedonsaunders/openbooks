import { NextResponse } from "next/server";
import { z } from "zod";
import { proposeAssetReversal } from "@openbooks/engine/src/assets/asset-change-reversals.ts";
import { proposeTaxAssetBasisReversal } from "@openbooks/engine/src/tax-returns/asset-basis-workpaper.ts";
import { proposeTaxMatchingReplayReversal } from "@openbooks/engine/src/tax-returns/consolidated-matching-replay.ts";
import { isIsoCalendarDate } from "@openbooks/engine/src/platform/business-date.ts";
import { parseJsonBody } from "@/lib/api/json";
import { authorizeChange } from "../../_authorization";
export const runtime = "nodejs";
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params,
    gate = await authorizeChange(id);
  if (gate instanceof NextResponse) return gate;
  if (gate.domain !== "asset")
    return NextResponse.json(
      { error: "select an asset disposal, transfer or tax basis workpaper" },
      { status: 422 },
    );
  const body = await parseJsonBody(
    req,
    z
      .object({
        effectiveOn:
          gate.operation === "tax_basis"
            || gate.operation === "tax_matching_replay"
            || gate.operation === "tax_matching_generation_repair"
            ? z.never().optional()
            : z.string().refine(isIsoCalendarDate),
        reason: z.string().trim().min(8).max(1000),
        idempotencyKey: z.string().min(1).max(120),
      })
      .strict(),
    { status: 422 },
  );
  if (!body.ok) return body.response;
  try {
    if (gate.operation === "tax_matching_replay" || gate.operation === "tax_matching_generation_repair")
      return await proposeTaxMatchingReplayReversal();
    if (gate.operation === "tax_basis")
      return NextResponse.json({
        changeId: await proposeTaxAssetBasisReversal(
          gate.auth.user.orgId,
          id,
          gate.auth.user.id,
          {
            reason: body.data.reason,
            idempotencyKey: body.data.idempotencyKey,
          },
        ),
      });
    if (!body.data.effectiveOn)
      return NextResponse.json(
        { error: "select a reversal date" },
        { status: 422 },
      );
    return NextResponse.json({
      changeId: await proposeAssetReversal(
        gate.auth.user.orgId,
        id,
        gate.auth.user.id,
        { ...body.data, effectiveOn: body.data.effectiveOn },
      ),
    });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error ? e.message : "reversal could not be proposed",
      },
      { status: 422 },
    );
  }
}
