import { lockManufacturingRoutingAuthority } from "@openbooks/engine/manufacturing/authority";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import {
  createRouting,
  getRouting,
  type RoutingInput,
} from "@openbooks/engine/manufacturing/routings";
import { defineRoute } from "@/lib/api/route";
import { created } from "@/lib/api/responses";
import { idempotentManufacturingCreate } from "../_idempotent";
import { manufacturingTransaction } from "../_transaction";

const Body = z.object({
  producedItemId: uuidString(),
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable().optional(),
  defaultIssueLocationId: uuidString().nullable().optional(),
  defaultReceiptLocationId: uuidString().nullable().optional(),
  overheadBasis: z.enum(["labor_hours", "machine_hours", "units"]),
});
const Params = z.object({}).strict();

export const POST = defineRoute({
  permission: "manufacturing.manage",
  feature: "manufacturing",
  params: Params,
  body: Body,
  scope: "unrestricted",
  handler: async ({ request, authz, body }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      const input = body as RoutingInput;
      const match = { ...input };
      const row = await idempotentManufacturingCreate({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        request,
        table: "mfg_routings",
        match,
        create: (id, requestId, savedMatch) =>
          createRouting(db, authz.user.orgId, authz.user.id, input, {
            id,
            requestId,
            match: savedMatch,
          }),
        load: async () => {
          const id = request.headers.get("Idempotency-Key")!.trim();
          await lockManufacturingRoutingAuthority(db, authz.user.orgId, authz.user.id, id);
          return getRouting(db, authz.user.orgId, id);
        },
      });
      return created(row);
    }),
});
