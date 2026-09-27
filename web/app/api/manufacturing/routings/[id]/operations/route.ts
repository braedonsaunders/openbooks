import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { createRoutingOperation, getRouting, type RoutingOperationInput } from "@openbooks/engine/src/manufacturing/routings.ts";
import { getWorkCenter } from "@openbooks/engine/src/manufacturing/work-centers.ts";
import { guardRoutingSubsidiaryScope } from "../../../_scope";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { created, notFound } from "@/lib/api/responses";
import { idempotentManufacturingCreate } from "../../../_idempotent";
import { manufacturingTransaction } from "../../../_transaction";

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({
  sequence: z.number().int().positive(), name: z.string().trim().min(1), workCenterId: z.string().uuid(),
  setupMinutes: z.string(), runMinutesPerUnit: z.string(), laborMinutesPerUnit: z.string().nullable().optional(),
  backflushAt: z.enum(["none", "start", "finish"]).optional(), qualityGate: z.enum(["none", "measure"]).optional(),
});

export const POST = defineRoute({
  permission: "manufacturing.manage", feature: "manufacturing", params: Params, body: Body,
  handler: async ({ request, authz, params, body }) => manufacturingTransaction(authz.user.orgId, async () => {
    const routing = await getRouting(db, authz.user.orgId, params.id);
    if (!routing) return notFound("routing");
    const denied = guardRoutingSubsidiaryScope(authz, routing);
    if (denied) return denied;
    const input = body as RoutingOperationInput;
    const center = await getWorkCenter(db, authz.user.orgId, input.workCenterId);
    if (!center) return notFound("work center");
    const centerDenied = guardSubsidiaryScope(authz, center.subsidiaryId as string | null);
    if (centerDenied) return centerDenied;
    const match = { routingId: params.id, ...input };
    const row = await idempotentManufacturingCreate({
      orgId: authz.user.orgId, request, table: "mfg_routing_operations", match,
      create: (id, requestId, savedMatch) => createRoutingOperation(db, authz.user.orgId, authz.user.id, params.id, input, { id, requestId, match: savedMatch }),
      load: async () => {
        const current = await getRouting(db, authz.user.orgId, params.id);
        return (current?.operations as Record<string, unknown>[] | undefined)?.find((operation) => operation.id === request.headers.get("Idempotency-Key")!.trim()) ?? null;
      },
    });
    return created(row);
  }),
});
