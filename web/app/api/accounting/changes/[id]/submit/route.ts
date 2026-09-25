import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from "next/server";
import { submitFinancialChange } from "@openbooks/engine/src/flows/financial-changes-adapter.ts";
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
    await submitFinancialChange(gate.auth.user.orgId, id, gate.auth.user.id);
    return NextResponse.json({ submitted: true });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
