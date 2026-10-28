import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "@/lib/list-params";
import { FieldTimeError } from "@openbooks/engine/hrm/field-time/errors";
import {
  assertProjectGeofenceShape,
  deleteProjectGeofence,
  listProjectGeofences,
  saveProjectGeofence,
} from "@openbooks/engine/hrm/field-time/geofences";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

function bad(error: string, status = 422) {
  return NextResponse.json({ error }, { status });
}

/** Record-level scope denials answer exactly like not-found (a uniform 404). */
function hidden() {
  return notFound("record");
}

const pointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const SHAPE_NEEDS = "A geofence needs the project and circle or polygon shape";
const UNKNOWN_PROJECT = "Unknown project — pick it from the list";
const DELETE_NEEDS = "Delete needs the geofence id";

const geofenceSchema = z.object({
  action: z.literal("save").optional(),
  id: z
    .string()
    .refine((v) => isUuid(v), "Unknown geofence — reload and retry")
    .optional(),
  projectId: z.string({ error: SHAPE_NEEDS }).refine((v) => isUuid(v), UNKNOWN_PROJECT),
  kind: z.enum(["circle", "polygon"], { error: SHAPE_NEEDS }),
  center: pointSchema.nullable().optional(),
  radiusM: z.number().int().min(10).max(100000).nullable().optional(),
  polygon: z.array(pointSchema).min(3).max(64).nullable().optional(),
  isActive: z.boolean().optional(),
});

/**
 * Save or retire. Delete names itself; a save carries the shape. The
 * circle/polygon completeness checks stay in the handler so each one
 * names the missing part rather than failing the whole union.
 */
const geofenceBody = z.union([
  z.object({
    action: z.literal("delete"),
    id: z.string({ error: DELETE_NEEDS }).refine((v) => isUuid(v), DELETE_NEEDS),
  }),
  geofenceSchema,
]);

/** GET → active geofences (?projectId=), visible only under the caller's subsidiaries. */
async function legacyGET(req: Request, gate: Authz) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const rows = await listProjectGeofences(gate.user.orgId, projectId, gate.allowedSubsidiaryIds);
  return NextResponse.json({ geofences: rows });
}

/** POST → declare a geofence. PUT/PATCH with id edits; DELETE with id retires. */
async function legacyPOST(body: z.output<typeof geofenceBody>, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  const { user } = gate;

  try {
    if (body.action === "delete") {
      const outcome = await deleteProjectGeofence({
        orgId: user.orgId,
        id: body.id,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      });
      if (outcome === "ok") return NextResponse.json({ ok: true });
      if (outcome === "hidden") return hidden();
      return bad("The geofence is unknown in this organization — reload and retry");
    }
    const fence = body;
    assertProjectGeofenceShape(fence);
    const outcome = await saveProjectGeofence({
      orgId: user.orgId,
      actorUserId: user.id,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      fence,
    });
    if (typeof outcome === "string") {
      if (outcome === "hidden") return hidden();
      if (outcome === "project-unknown") return bad(UNKNOWN_PROJECT);
      return bad("The geofence is unknown in this organization — reload and retry");
    }
    return NextResponse.json({ id: outcome.id });
  } catch (error) {
    if (error instanceof FieldTimeError) return bad(error.message);
    throw error;
  }
}

export const GET = defineRoute({
  permission: "time.manage",
  feature: "fieldTime",

  handler: ({ request, authz }) => legacyGET(request, authz),
});

export const POST = defineRoute({
  permission: "time.manage",
  feature: "fieldTime",
  body: geofenceBody,
  invalidBodyStatus: 422,
  handler: ({ body, authz }) => legacyPOST(body, authz),
});
