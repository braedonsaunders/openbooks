import { lockManufacturingRoutingAuthority } from "@openbooks/engine/src/manufacturing/authority.ts";
import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { createRouting, getRouting, type RoutingInput } from "@openbooks/engine/src/manufacturing/routings.ts";
import { defineRoute } from "@/lib/api/route";
import { created } from "@/lib/api/responses";
import { idempotentManufacturingCreate } from "../_idempotent";
import { manufacturingTransaction } from "../_transaction";

const Body = z.object({
  producedItemId: z.string().uuid(), code: z.string().trim().min(1), name: z.string().trim().min(1),
  effectiveFrom: z.string(), effectiveTo: z.string().nullable().optional(),
  defaultIssueLocationId: z.string().uuid().nullable().optional(), defaultReceiptLocationId: z.string().uuid().nullable().optional(),
  overheadBasis: z.enum(["labor_hours", "machine_hours", "units"]),
});
const Params = z.object({}).strict();

export const POST = defineRoute({
  permission: "manufacturing.manage", feature: "manufacturing", params: Params, body: Body, scope: "unrestricted",
  handler: async ({ request, authz, body }) => manufacturingTransaction(authz.user.orgId, async () => {
    const input = body as RoutingInput;
    const match = { ...input };
    const row = await idempotentManufacturingCreate({
      orgId: authz.user.orgId, actorId: authz.user.id, request, table: "mfg_routings", match,
      create: (id, requestId, savedMatch) => createRouting(db, authz.user.orgId, authz.user.id, input, { id, requestId, match: savedMatch }),
      load: async () => { const id=request.headers.get("Idempotency-Key")!.trim(); await lockManufacturingRoutingAuthority(db,authz.user.orgId,authz.user.id,id); return getRouting(db,authz.user.orgId,id); },
    });
    return created(row);
  }),
});
