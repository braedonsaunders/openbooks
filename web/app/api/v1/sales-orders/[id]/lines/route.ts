import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { v1ReplaceOrderLines } from "../../../../../../lib/api/v1-orders";

export const runtime = "nodejs";

async function handleV1PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return v1ReplaceOrderLines(request, "sales-orders", id);
}

export const PATCH = defineRoute({
  public: "token",
  handler: ({ request, params }) => handleV1PATCH(request, { params: Promise.resolve(params as never) } as never),
});
