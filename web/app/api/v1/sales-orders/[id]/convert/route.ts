import { NextResponse } from "next/server";
import { v1ConvertOrder } from "../../../../../../lib/api/v1-orders";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return v1ConvertOrder(request, "sales-orders", id);
}
