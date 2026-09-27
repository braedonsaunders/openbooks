import { defineRoute } from "@/lib/api/route";
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
async function handleV1GET(
  request: Request,
  { params }: { params: Promise<{ typeKey: string; id: string }> },
): Promise<NextResponse> {
  const { typeKey, id } = await params;
  return v1GetAliasedRecord(request, typeKey, id);
}

async function handleV1PATCH(
  request: Request,
  { params }: { params: Promise<{ typeKey: string; id: string }> },
): Promise<NextResponse> {
  const { typeKey, id } = await params;
  return v1UpdateAliasedRecord(request, typeKey, id);
}

async function handleV1DELETE(
  request: Request,
  { params }: { params: Promise<{ typeKey: string; id: string }> },
): Promise<NextResponse> {
  const { typeKey, id } = await params;
  return v1DeleteAliasedRecord(request, typeKey, id);
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request, params }) => handleV1GET(request, { params: Promise.resolve(params as never) } as never),
});

export const PATCH = defineRoute({
  public: "token",
  handler: ({ request, params }) => handleV1PATCH(request, { params: Promise.resolve(params as never) } as never),
});

export const DELETE = defineRoute({
  public: "token",
  handler: ({ request, params }) => handleV1DELETE(request, { params: Promise.resolve(params as never) } as never),
});
