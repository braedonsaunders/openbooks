import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../../lib/api/json";
import { defineRoute } from "../../../../../lib/api/route";
import { isUuid } from "../../../../../lib/list-params";
import {
  DriverAdminError,
  deleteDriverValue,
  updateDriverValue,
} from "../../../../../../engine/src/allocations/driver-admin.ts";
import { notFound } from "@/lib/api/responses";


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
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params }) => {
  const { id } = params;
  if (!isUuid(id)) return notFound("record");
  const parsedBody = await parseJsonBody(req, valuePatchSchema);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const value = await updateDriverValue(gate.user.orgId, gate.user.id, id, parsedBody.data);
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
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
  const { id } = params;
  if (!isUuid(id)) return notFound("record");
  try {
    await deleteDriverValue(gate.user.orgId, gate.user.id, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toResponse(error);
  }
  },
});
