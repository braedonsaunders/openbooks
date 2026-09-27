import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { v1GetOrder } from "../../../../../lib/api/v1-orders";

export const runtime = "nodejs";

async function handleV1GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return v1GetOrder(request, "purchase-orders", id);
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request, params }) => handleV1GET(request, { params: Promise.resolve(params as never) } as never),
});
