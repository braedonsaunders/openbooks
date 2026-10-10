import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { deleteRoutingOperation, getRouting, updateRoutingOperation, type RoutingOperationInput } from "@openbooks/engine/src/manufacturing/routings.ts";
import { getWorkCenter } from "@openbooks/engine/src/manufacturing/work-centers.ts";
import { guardSubsidiaryScope, type Authz } from "@/lib/authz";
import { guardRoutingSubsidiaryScope } from "../../../../_scope";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { manufacturingTransaction } from "../../../../_transaction";

const Params = z.object({ id: z.string().uuid(), opId: z.string().uuid() });
const Patch = z.object({
  sequence: z.number().int().positive().optional(), name: z.string().trim().min(1).optional(), workCenterId: z.string().uuid().optional(),
  setupMinutes: z.string().optional(), runMinutesPerUnit: z.string().optional(), laborTimeSource: z.enum(["operation", "approved_time"]).optional(), laborMinutesPerUnit: z.string().nullable().optional(),
  backflushAt: z.enum(["none", "start", "finish"]).optional(), qualityGate: z.enum(["none", "measure"]).optional(),
}).refine((value) => Object.keys(value).length > 0);
const Empty = z.object({}).strict();

type ScopedRouting =
  | { response: Response }
  | { routing: NonNullable<Awaited<ReturnType<typeof getRouting>>> };

async function loadScoped(authz: Authz, id: string): Promise<ScopedRouting> {
  const routing = await getRouting(db, authz.user.orgId, id);
  if (!routing) return { response: notFound("routing") };
  const denied = guardRoutingSubsidiaryScope(authz, routing);
  return denied ? { response: denied } : { routing };
}

export const PATCH = defineRoute({
  permission: "manufacturing.manage", feature: "manufacturing", params: Params, body: Patch,
  handler: async ({ authz, params, body }) => manufacturingTransaction(authz.user.orgId, async () => {
    const scoped = await loadScoped(authz, params.id);
    if ("response" in scoped) return scoped.response;
    if (body.workCenterId) {
      const center = await getWorkCenter(db, authz.user.orgId, body.workCenterId);
      if (!center) return notFound("work center");
      const centerDenied = guardSubsidiaryScope(authz, center.subsidiaryId as string | null);
      if (centerDenied) return centerDenied;
    }
    return Response.json(await updateRoutingOperation(db, authz.user.orgId, authz.user.id, params.id, params.opId, body as Partial<RoutingOperationInput>));
  }),
});

export const DELETE = defineRoute({
  permission: "manufacturing.manage", feature: "manufacturing", params: Params, body: Empty,
  handler: async ({ authz, params }) => manufacturingTransaction(authz.user.orgId, async () => {
    const scoped = await loadScoped(authz, params.id);
    if ("response" in scoped) return scoped.response;
    await deleteRoutingOperation(db, authz.user.orgId, authz.user.id, params.id, params.opId);
    return Response.json({ deleted: true });
  }),
});
