import { NextResponse } from "next/server";
import {
  v1DeleteAliasedRecord,
  v1GetAliasedRecord,
  v1UpdateAliasedRecord,
} from "../../../../../lib/api/v1-records";

export const runtime = "nodejs";

/**
 * GET /api/v1/{typeKey}/{id} — first-class alias of GET /api/v1/records/{typeKey}/{id}.
 * Dedicated item routes (payments/{id}, journals/{id}/post) win over this catch-all.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ typeKey: string; id: string }> },
): Promise<NextResponse> {
  const { typeKey, id } = await params;
  return v1GetAliasedRecord(request, typeKey, id);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ typeKey: string; id: string }> },
): Promise<NextResponse> {
  const { typeKey, id } = await params;
  return v1UpdateAliasedRecord(request, typeKey, id);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ typeKey: string; id: string }> },
): Promise<NextResponse> {
  const { typeKey, id } = await params;
  return v1DeleteAliasedRecord(request, typeKey, id);
}
