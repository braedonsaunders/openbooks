import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/list-params";
import {
  DRIVER_SOURCE_KINDS,
  DriverAdminError,
  deleteDriver,
  getDriver,
  updateDriver,
} from "@openbooks/engine/allocations/driver-admin";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const driverPatchSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    unit: z.string().nullable().optional(),
    dimension: z
      .string()
      .regex(/^(department|location|class|project|subsidiary|extra:.+)$/)
      .optional(),
    sourceKind: z.enum(DRIVER_SOURCE_KINDS).optional(),
    // Source-specific configuration is an opaque JSON value validated by the
    // selected driver adapter in the allocation engine.
    config: z.record(z.string(), z.json()).optional(),
    isActive: z.boolean().optional(),
    expectedUpdatedAt: z.string().min(1),
  })
  .strict();

async function toResponse(error: unknown): Promise<NextResponse> {
  if (error instanceof DriverAdminError) {
    return apiErrorResponse(error);
  }
  throw error;
}

type Ctx = { params: Promise<{ id: string }> };

async function legacyGET(_req: Request, { params }: Ctx, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;

  const { id } = await params;
  if (!isUuid(id)) return notFound("record");
  const driver = await getDriver(gate.user.orgId, id, undefined, gate.allowedSubsidiaryIds);
  if (!driver) return notFound("record");
  return NextResponse.json({ driver });
}

async function legacyPATCH(
  { params }: Ctx,
  body: z.output<typeof driverPatchSchema>,
  injectedGate?: Authz | null,
) {
  const gate = injectedGate as Authz;
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");
  try {
    const driver = await updateDriver(gate.user.orgId, gate.user.id, id, body);
    return NextResponse.json({ driver });
  } catch (error) {
    return toResponse(error);
  }
}

async function legacyDELETE(_req: Request, { params }: Ctx, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");
  try {
    await deleteDriver(gate.user.orgId, gate.user.id, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toResponse(error);
  }
}

export const GET = defineRoute({
  permission: "allocations.read",
  feature: "allocations",
  params: z.object({ id: z.string() }),
  handler: ({ request, params, authz }) =>
    legacyGET(request, { params: Promise.resolve(params) }, authz),
});

export const PATCH = defineRoute({
  permission: "allocations.manage",
  feature: "allocations",
  scope: "unrestricted",
  params: z.object({ id: z.string().refine((value) => isUuid(value)) }),
  invalidParamsNotFound: "record",
  body: driverPatchSchema,
  handler: ({ params, authz, body }) =>
    legacyPATCH({ params: Promise.resolve(params) }, body, authz),
});

export const DELETE = defineRoute({
  permission: "allocations.manage",
  feature: "allocations",
  scope: "unrestricted",
  params: z.object({ id: z.string() }),
  handler: ({ request, params, authz }) =>
    legacyDELETE(request, { params: Promise.resolve(params) }, authz),
});
