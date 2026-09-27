import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../lib/api/json";
import { defineRoute } from "../../../../lib/api/route";
import {
  DriverAdminError,
  createDriverValue,
  listDriverValues,
} from "../../../../../engine/src/allocations/driver-admin.ts";

export const runtime = "nodejs";

const valueBodySchema = z.object({
  driverId: z.string(),
  dimensionValueId: z.string(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable().optional(),
  value: z.string(),
  note: z.string().nullable().optional(),
});

async function toResponse(error: unknown): Promise<NextResponse> {
  if (error instanceof DriverAdminError) {
    return apiErrorResponse(error);
  }
  throw error;
}

/**
 * Manual driver values (A8): the effective-dated grid behind the manual
 * drawer. Reads need `allocations.read`; writes need `allocations.manage`.
 */
export const GET = defineRoute({
  permission: "allocations.read",
  feature: "allocations",
  scope: "unrestricted",
  handler: async ({ request: req, authz: gate }) => {
  const params = new URL(req.url).searchParams;
  const driverId = params.get("driverId") ?? "";
  const onDate = params.get("onDate") ?? undefined;
  try {
    const values = await listDriverValues(gate.user.orgId, driverId, { onDate });
    return NextResponse.json({ values });
  } catch (error) {
    return toResponse(error);
  }
  },
});

export const POST = defineRoute({
  permission: "allocations.manage",
  feature: "allocations",
  scope: "unrestricted",
  handler: async ({ request: req, authz: gate }) => {
  const parsedBody = await parseJsonBody(req, valueBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const data = parsedBody.data;
  try {
    const value = await createDriverValue(gate.user.orgId, gate.user.id, data.driverId, {
      dimensionValueId: data.dimensionValueId,
      effectiveFrom: data.effectiveFrom,
      effectiveTo: data.effectiveTo,
      value: data.value,
      note: data.note,
    });
    return NextResponse.json({ value }, { status: 201 });
  } catch (error) {
    return toResponse(error);
  }
  },
});
