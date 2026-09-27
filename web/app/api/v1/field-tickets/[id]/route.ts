import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { v1GetRecord } from "../../../../../lib/api/v1-records";

export const runtime = "nodejs";

/** GET /api/v1/field-tickets/:id — one field-ticket document. */
async function handleV1GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return v1GetRecord(request, "field-tickets", id, "api/v1/field-tickets/:id");
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request, params }) => handleV1GET(request, { params: Promise.resolve(params as never) } as never),
});
