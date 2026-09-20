import { parseJsonBody } from "@/lib/api/json";
import { leasePostSchema } from "../../_schema";
import { NextResponse } from "next/server";
import { guardFeaturePermission } from "@/lib/feature-gates";
import { isUuid } from "@/lib/list-params";
import { postDueLeaseSchedules } from "@openbooks/engine/src/revenue/leases.ts";
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
  const body = await parseJsonBody(req, leasePostSchema);
  if (!body.ok) return body.response;
  try {
    return NextResponse.json(
      await postDueLeaseSchedules(
        gate.user.orgId,
        body.data.asOfDate,
        gate.user.id,
        { leaseId: id },
      ),
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "lease action failed" },
      { status: 422 },
    );
  }
}
