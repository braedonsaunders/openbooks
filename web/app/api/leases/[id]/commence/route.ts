import { NextResponse } from "next/server";
import { guardFeaturePermission } from "@/lib/feature-gates";
import { isUuid } from "@/lib/list-params";
import { commenceLease } from "@openbooks/engine/src/revenue/leases.ts";
export const runtime = "nodejs";
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardFeaturePermission("assets.manage", "fixedAssets");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id))
    return NextResponse.json({ error: "invalid lease" }, { status: 422 });

  try {
    return NextResponse.json(
      await commenceLease(gate.user.orgId, id, gate.user.id),
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "lease action failed" },
      { status: 422 },
    );
  }
}
