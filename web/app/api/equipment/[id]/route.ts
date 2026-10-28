import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { NextResponse } from "next/server";
import { loadEquipment } from "../_lib";
import { isUuid } from "../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";
import {
  requestBodySchema,
  updateEquipmentUnit,
  deleteEquipmentUnit,
} from "../../../../lib/equipment-actions";

export const GET = defineRoute({
  permission: "assets.read",
  feature: "equipment",
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
    const { id } = params;
    const data = isUuid(id)
      ? await loadEquipment(id, gate.user.orgId, gate.allowedSubsidiaryIds)
      : null;
    if (!data) return notFound("record");
    return NextResponse.json(data);
  },
});

export const PATCH = defineRoute({
  permission: "assets.manage",
  feature: "equipment",
  params: z.object({ id: z.string().refine(isUuid) }),
  invalidParamsNotFound: "record",
  body: requestBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ authz, params: { id }, body }) => updateEquipmentUnit(authz, id, body),
});

export const DELETE = defineRoute({
  permission: "assets.manage",
  feature: "equipment",
  params: z.object({ id: z.string() }),
  handler: async ({ authz, params }) => deleteEquipmentUnit(authz, params),
});
