import { apiErrorResponse } from '@/lib/api/error-response'
import { LeaseError } from "@openbooks/engine/src/revenue/leases.ts";
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
    if (e instanceof LeaseError) {
      return apiErrorResponse(e, { safeStatus: 422 })
    }
    return apiErrorResponse(e);
  }
}
