import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { v1ConvertOrder } from "../../../../../../lib/api/v1-orders";

export const runtime = "nodejs";

async function handleV1POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return v1ConvertOrder(request, "sales-orders", id);
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request, params }) => handleV1POST(request, { params: Promise.resolve(params as never) } as never),
});
