import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../lib/api/json";
import { guardAllocations } from "../../../../lib/allocations-gate";
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

function toResponse(error: unknown): NextResponse {
  if (error instanceof DriverAdminError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

/**
 * Manual driver values (A8): the effective-dated grid behind the manual
 * drawer. Reads need `allocations.read`; writes need `allocations.manage`.
 */
export async function GET(req: Request) {
  const gate = await guardAllocations("allocations.read");
  if (gate instanceof NextResponse) return gate;
  const params = new URL(req.url).searchParams;
  const driverId = params.get("driverId") ?? "";
  const onDate = params.get("onDate") ?? undefined;
  try {
    const values = await listDriverValues(gate.user.orgId, driverId, { onDate });
    return NextResponse.json({ values });
  } catch (error) {
    return toResponse(error);
  }
}

export async function POST(req: Request) {
  const gate = await guardAllocations("allocations.manage");
  if (gate instanceof NextResponse) return gate;
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
}
