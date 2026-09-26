import { apiErrorResponse } from '@/lib/api/error-response'
import { LeaseError } from "@openbooks/engine/src/revenue/leases.ts";
import { NextResponse } from "next/server";
import { parseJsonBody } from "@/lib/api/json";
import { guardFeaturePermission } from "@/lib/feature-gates";
import { createLeaseAgreement } from "@openbooks/engine/src/revenue/leases.ts";
import { leaseSchema } from "./_schema";
export const runtime = "nodejs";
export async function POST(req: Request) {
  const gate = await guardFeaturePermission("assets.manage", "fixedAssets");
  if (gate instanceof NextResponse) return gate;
  const body = await parseJsonBody(req, leaseSchema);
  if (!body.ok) return body.response;
  try {
    return NextResponse.json(
      await createLeaseAgreement(gate.user.orgId, gate.user.id, body.data),
    );
  } catch (e) {
    if (e instanceof LeaseError) {
      return apiErrorResponse(e, { safeStatus: 422 })
    }
    return apiErrorResponse(e);
  }
}
