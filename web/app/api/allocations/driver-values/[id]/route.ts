import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../../lib/api/json";
import { guardAllocations } from "../../../../../lib/allocations-gate";
import { isUuid } from "../../../../../lib/list-params";
import {
  DriverAdminError,
  deleteDriverValue,
  updateDriverValue,
} from "../../../../../../engine/src/allocations/driver-admin.ts";

export const runtime = "nodejs";

const valuePatchSchema = z.object({
  effectiveTo: z.string().nullable().optional(),
  value: z.string().optional(),
  note: z.string().nullable().optional(),
  expectedUpdatedAt: z.string().optional(),
});

function toResponse(error: unknown): NextResponse {
  if (error instanceof DriverAdminError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

type Ctx = { params: Promise<{ id: string }> };

/** End-date a value or correct it; the start date is immutable. */
export async function PATCH(req: Request, { params }: Ctx) {
  const gate = await guardAllocations("allocations.manage");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsedBody = await parseJsonBody(req, valuePatchSchema);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const value = await updateDriverValue(gate.user.orgId, gate.user.id, id, parsedBody.data);
    return NextResponse.json({ value });
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
    await deleteDriverValue(gate.user.orgId, gate.user.id, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toResponse(error);
  }
}
