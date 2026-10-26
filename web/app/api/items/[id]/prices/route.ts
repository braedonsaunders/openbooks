import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import {
  deleteSchedule,
  getSchedules,
  patchSchedule,
  postSchedule,
  priceScheduleBody,
} from "../../../_pricing/schedule-store";

export const runtime = "nodejs";

const itemParams = z.object({ id: z.string() });

function actorOf(gate: {
  user: { orgId: string; id: string };
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}) {
  return {
    orgId: gate.user.orgId,
    actorId: gate.user.id,
    allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
  };
}

const ITEM_SCHEDULE_FEATURE = {
  none: "Item price schedules are catalog data governed by items.manage; no feature key gates them.",
} as const;

export const GET = defineRoute({
  permission: "items.read",
  feature: ITEM_SCHEDULE_FEATURE,
  params: itemParams,
  handler: async ({ authz: gate, params: { id } }) => {
    const data = await getSchedules(actorOf(gate), { kind: "item", id });
    if (!data) return notFound("record");
    return NextResponse.json(data);
  },
});

export const POST = defineRoute({
  permission: "items.manage",
  feature: ITEM_SCHEDULE_FEATURE,
  params: itemParams,
  body: priceScheduleBody,
  handler: async ({ request, authz: gate, params: { id }, body }) => {
    return postSchedule(request, actorOf(gate), { kind: "item", id }, body);
  },
});

export const PATCH = defineRoute({
  permission: "items.manage",
  feature: ITEM_SCHEDULE_FEATURE,
  params: itemParams,
  handler: async ({ request, authz: gate, params: { id } }) => {
    return patchSchedule(request, actorOf(gate), { kind: "item", id });
  },
});

export const DELETE = defineRoute({
  permission: "items.manage",
  feature: ITEM_SCHEDULE_FEATURE,
  params: itemParams,
  handler: async ({ request, authz: gate, params: { id } }) => {
    return deleteSchedule(request, actorOf(gate), { kind: "item", id });
  },
});
