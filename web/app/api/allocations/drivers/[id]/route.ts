import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../../lib/api/json";
import { guardAllocations } from "../../../../../lib/allocations-gate";
import { isUuid } from "../../../../../lib/list-params";
import {
  DRIVER_SOURCE_KINDS,
  DriverAdminError,
  deleteDriver,
  getDriver,
  updateDriver,
} from "../../../../../../engine/src/allocations/driver-admin.ts";

export const runtime = "nodejs";

const driverPatchSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  dimension: z.string().optional(),
  sourceKind: z.enum(DRIVER_SOURCE_KINDS).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
  expectedUpdatedAt: z.string().optional(),
});

function toResponse(error: unknown): NextResponse {
  if (error instanceof DriverAdminError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await guardAllocations("allocations.read");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const driver = await getDriver(gate.user.orgId, id);
  if (!driver) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ driver });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const gate = await guardAllocations("allocations.manage");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsedBody = await parseJsonBody(req, driverPatchSchema);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const driver = await updateDriver(gate.user.orgId, gate.user.id, id, parsedBody.data);
    return NextResponse.json({ driver });
  } catch (error) {
    return toResponse(error);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const gate = await guardAllocations("allocations.manage");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    await deleteDriver(gate.user.orgId, gate.user.id, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toResponse(error);
  }
}
