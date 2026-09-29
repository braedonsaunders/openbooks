import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { submitFinancialChange } from "@openbooks/engine/src/flows/financial-changes-adapter.ts";
import { authorizeChange } from "../../_authorization";
export const runtime = "nodejs";
export const POST = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, params }) => {
    const { id } = await params,
      gate = await authorizeChange(id);
    if (gate instanceof NextResponse) return gate;
    try {
      await submitFinancialChange(gate.auth.user.orgId, id, gate.auth.user.id);
      return NextResponse.json({ submitted: true });
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});
