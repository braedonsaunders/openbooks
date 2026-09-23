import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../lib/api/json";
import { guardAllocations } from "../../../../lib/allocations-gate";
import { guardUnrestrictedScope } from "../../../../lib/authz";
// NOTE (fleet worktree): @openbooks/* resolves to the MAIN checkout through
// the shared node_modules symlink, so worktree engine code is imported via
// relative paths (the route-test precedent). Identical after cherry-pick.
import {
  DRIVER_SOURCE_KINDS,
  DriverAdminError,
  createDriver,
  listDrivers,
} from "../../../../../engine/src/allocations/driver-admin.ts";

export const runtime = "nodejs";

const driverBodySchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  dimension: z.string(),
  sourceKind: z.enum(DRIVER_SOURCE_KINDS),
  config: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
});

function toResponse(error: unknown): NextResponse {
  if (error instanceof DriverAdminError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

/**
 * Driver registry (A8). Reads need `allocations.read`; writes need
 * `allocations.manage`. Everything 404s while the `allocations` feature
 * switch is off.
 */
export async function GET(req: Request) {
  const gate = await guardAllocations("allocations.read");
  if (gate instanceof NextResponse) return gate;
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  if (includeInactive) {
    const manage = await guardAllocations("allocations.manage");
    if (manage instanceof NextResponse) return manage;
  }
  try {
    const drivers = await listDrivers(gate.user.orgId, { includeInactive });
    return NextResponse.json({ drivers });
  } catch (error) {
    return toResponse(error);
  }
}

export async function POST(req: Request) {
  const gate = await guardAllocations("allocations.manage");
  if (gate instanceof NextResponse) return gate;
  const scopeDenied = guardUnrestrictedScope(gate)
  if (scopeDenied) return scopeDenied
  const parsedBody = await parseJsonBody(req, driverBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const driver = await createDriver(gate.user.orgId, gate.user.id, {
      key: parsedBody.data.key,
      name: parsedBody.data.name,
      description: parsedBody.data.description,
      unit: parsedBody.data.unit,
      dimension: parsedBody.data.dimension,
      sourceKind: parsedBody.data.sourceKind,
      config: parsedBody.data.config,
      isActive: parsedBody.data.isActive,
    });
    return NextResponse.json({ driver }, { status: 201 });
  } catch (error) {
    return toResponse(error);
  }
}
