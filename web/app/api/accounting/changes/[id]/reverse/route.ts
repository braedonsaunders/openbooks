import { NextResponse } from "next/server";
import { z } from "zod";
import { proposeAssetReversal } from "@openbooks/engine/src/assets/asset-change-reversals.ts";
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
      { error: "select an asset disposal or transfer" },
      { status: 422 },
    );
  const body = await parseJsonBody(
    req,
    z.object({
      effectiveOn: z.string().refine(isIsoCalendarDate),
      reason: z.string().trim().min(8).max(1000),
      idempotencyKey: z.string().min(1).max(120),
    }),
    { status: 422 },
  );
  if (!body.ok) return body.response;
  try {
    return NextResponse.json({
      changeId: await proposeAssetReversal(
        gate.auth.user.orgId,
        id,
        gate.auth.user.id,
        body.data,
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
