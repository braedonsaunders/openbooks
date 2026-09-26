import { apiErrorResponse } from '@/lib/api/error-response'
import { LeaseError } from "@openbooks/engine/src/revenue/leases.ts";
import { parseJsonBody } from "@/lib/api/json";
import { leaseChangeSchema } from "../../_schema";
import { NextResponse } from "next/server";
import { guardFeaturePermission } from "@/lib/feature-gates";
import { isUuid } from "@/lib/list-params";
import { proposeLeaseChange } from "@openbooks/engine/src/revenue/lease-changes.ts";
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
  const body = await parseJsonBody(req, leaseChangeSchema);
  if (!body.ok) return body.response;
  try {
    return NextResponse.json(
      await proposeLeaseChange(gate.user.orgId, id, gate.user.id, body.data),
    );
  } catch (e) {
    if (e instanceof LeaseError) {
      return apiErrorResponse(e, { safeStatus: 422 })
    }
    return apiErrorResponse(e);
  }
}
