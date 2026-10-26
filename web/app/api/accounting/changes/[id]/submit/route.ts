import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import {
  submitBomRevision,
  submitFinancialChange,
} from "@openbooks/engine/flows/financial-changes-adapter";
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
      if (gate.domain === "manufacturing" && gate.operation === "bom_revision_activation") {
        await submitBomRevision(gate.auth.user.orgId, gate.auth.user.id, id);
        return NextResponse.json({ submitted: true });
      }
      await submitFinancialChange(gate.auth.user.orgId, id, gate.auth.user.id);
      return NextResponse.json({ submitted: true });
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});
