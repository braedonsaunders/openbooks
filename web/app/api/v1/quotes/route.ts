import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { v1CreateOrder, v1ListOrders } from "../../../../lib/api/v1-orders";

export const runtime = "nodejs";

async function handleV1GET(request: Request): Promise<NextResponse> {
  return v1ListOrders(request, "quotes");
}

async function handleV1POST(request: Request): Promise<NextResponse> {
  return v1CreateOrder(request, "quotes");
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1GET(request),
});

export const POST = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1POST(request),
});
