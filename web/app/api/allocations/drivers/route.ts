import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { z } from "zod";
import { guardAllocations, gateCan, missingPermission } from "@/lib/allocations-gate";
import {
  DRIVER_SOURCE_KINDS,
  DriverAdminError,
  createDriver,
  listDrivers,
} from "@openbooks/engine/allocations/driver-admin";

export const runtime = "nodejs";

const driverBodySchema = z
  .object({
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
  })
  .strict();

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
async function legacyGET(
  req: Request,
  ctx: { params: Promise<unknown> },
  injectedGate?: Authz | null,
) {
  const gate = injectedGate as Authz;

  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  try {
    const drivers = await listDrivers(gate.user.orgId, {
      includeInactive,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
    return NextResponse.json({ drivers });
  } catch (error) {
    return toResponse(error);
  }
}

async function legacyPOST(body: z.output<typeof driverBodySchema>, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;

  try {
    const driver = await createDriver(gate.user.orgId, gate.user.id, {
      key: body.key,
      name: body.name,
      description: body.description,
      unit: body.unit,
      dimension: body.dimension,
      sourceKind: body.sourceKind,
      config: body.config,
      isActive: body.isActive,
    });
    return NextResponse.json({ driver }, { status: 201 });
  } catch (error) {
    return toResponse(error);
  }
}

export const GET = defineRoute({
  authorize: async ({ request }) => {
    const gate = await guardAllocations("allocations.read");
    if (gate instanceof NextResponse) return gate;
    if (
      new URL(request.url).searchParams.get("includeInactive") === "1" &&
      !gateCan(gate, "allocations.manage")
    ) {
      return missingPermission("allocations.manage");
    }
    return gate;
  },
  feature: "allocations",
  handler: ({ request, params, authz }) =>
    legacyGET(request, { params: Promise.resolve(params) }, authz),
});

export const POST = defineRoute({
  permission: "allocations.manage",
  feature: "allocations",
  scope: "unrestricted",
  body: driverBodySchema,
  handler: ({ authz, body }) => legacyPOST(body, authz),
});
