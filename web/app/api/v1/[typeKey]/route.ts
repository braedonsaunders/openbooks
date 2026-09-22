import { NextResponse } from "next/server";
import {
  v1CreateAliasedRecord,
  v1ListAliasedRecords,
} from "../../../../lib/api/v1-records";

export const runtime = "nodejs";

/**
 * GET /api/v1/{typeKey} — first-class alias of GET /api/v1/records/{typeKey}.
 * Static folders (commands, close, payments, …) win over this catch-all.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ typeKey: string }> },
): Promise<NextResponse> {
  const { typeKey } = await params;
  return v1ListAliasedRecords(request, typeKey);
}

/** POST /api/v1/{typeKey} — first-class alias of POST /api/v1/records/{typeKey}. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ typeKey: string }> },
): Promise<NextResponse> {
  const { typeKey } = await params;
  return v1CreateAliasedRecord(request, typeKey);
}
