import { NextResponse } from "next/server";
import { applyLeaseChange } from "@openbooks/engine/src/revenue/lease-changes.ts";
import { applyRevenueModification } from "@openbooks/engine/src/revenue/contract-modifications.ts";
import { authorizeChange } from "../../_authorization";
export const runtime = "nodejs";
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params,
    gate = await authorizeChange(id);
  if (gate instanceof NextResponse) return gate;
  try {
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
