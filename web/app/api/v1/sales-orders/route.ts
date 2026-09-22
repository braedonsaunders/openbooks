import { NextResponse } from "next/server";
import { v1CreateOrder, v1ListOrders } from "../../../../lib/api/v1-orders";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<NextResponse> {
  return v1ListOrders(request, "sales-orders");
}

export async function POST(request: Request): Promise<NextResponse> {
  return v1CreateOrder(request, "sales-orders");
}
