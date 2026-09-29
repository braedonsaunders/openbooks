import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../lib/api/json";
import { guardAllocations } from "../../../../lib/allocations-gate";
import { guardUnrestrictedScope } from "../../../../lib/authz";
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
  dimension: z.string().regex(/^(department|location|class|project|subsidiary|extra:.+)$/),
  sourceKind: z.enum(DRIVER_SOURCE_KINDS),
  // Source-specific configuration is an opaque JSON value validated by the
  // selected driver adapter in the allocation engine.
  config: z.record(z.string(), z.json()).optional(),
  isActive: z.boolean().optional(),
}).strict();

async function toResponse(error: unknown): Promise<NextResponse> {
  if (error instanceof DriverAdminError) {
    return apiErrorResponse(error);
  }
  throw error;
}

/**
 * Driver registry (A8). Reads need `allocations.read`; writes need
 * `allocations.manage`. Everything 404s while the `allocations` feature
 * switch is off.
 */
async function legacyGET(req: Request, ctx: { params: Promise<unknown> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;

  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  if (includeInactive) {
    const manage = await guardAllocations("allocations.manage");
    if (manage instanceof NextResponse) return manage;
  }
  try {
    const drivers = await listDrivers(gate.user.orgId, { includeInactive, allowedSubsidiaryIds: gate.allowedSubsidiaryIds });
    return NextResponse.json({ drivers });
  } catch (error) {
    return toResponse(error);
  }
}

async function legacyPOST(req: Request, ctx: { params: Promise<unknown> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;

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

export const GET = defineRoute({
  permission: "allocations.read", feature: "allocations",

  handler: ({ request, params, authz }) => legacyGET(request, { params: Promise.resolve(params) }, authz),
});

export const POST = defineRoute({
  permission: "allocations.manage", feature: "allocations",

  handler: ({ request, params, authz }) => legacyPOST(request, { params: Promise.resolve(params) }, authz),
});
