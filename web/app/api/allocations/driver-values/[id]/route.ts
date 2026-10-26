import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { isUuid } from "@/lib/list-params";
import {
  DriverAdminError,
  deleteDriverValue,
  updateDriverValue,
} from "@openbooks/engine/allocations/driver-admin";

export const runtime = "nodejs";

const valuePatchSchema = z.object({
  effectiveTo: z.string().nullable().optional(),
  value: z.string().optional(),
  note: z.string().nullable().optional(),
  expectedUpdatedAt: z.string().optional(),
});

async function toResponse(error: unknown): Promise<NextResponse> {
  if (error instanceof DriverAdminError) {
    return apiErrorResponse(error);
  }
  throw error;
}

/** End-date a value or correct it; the start date is immutable. */
export const PATCH = defineRoute({
  permission: "allocations.manage",
  feature: "allocations",
  scope: "unrestricted",
  params: z.object({ id: z.string().refine((value) => isUuid(value)) }),
  invalidParamsNotFound: "record",
  body: valuePatchSchema,
  opaque: {
    effectiveTo: "The update service validates an optional end date against the stored value.",
    value: "The update service accepts value-only corrections for an existing driver value.",
    note: "Notes may be cleared independently from a value correction.",
    expectedUpdatedAt: "The update service uses an optional revision token for concurrency checks.",
  },
  handler: async ({ authz: gate, params, body }) => {
    const { id } = params;
    try {
      const value = await updateDriverValue(gate.user.orgId, gate.user.id, id, body);
      return NextResponse.json({ value });
    } catch (error) {
      return toResponse(error);
    }
  },
});

export const DELETE = defineRoute({
  permission: "allocations.manage",
  feature: "allocations",
  scope: "unrestricted",
  params: z.object({ id: z.string().refine((value) => isUuid(value)) }),
  invalidParamsNotFound: "record",
  handler: async ({ authz: gate, params }) => {
    const { id } = params;
    try {
      await deleteDriverValue(gate.user.orgId, gate.user.id, id);
      return NextResponse.json({ ok: true });
    } catch (error) {
      return toResponse(error);
    }
  },
});
