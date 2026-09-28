import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { resRetainers } from "@openbooks/schema";
import { createRetainer } from "@openbooks/engine/src/resourcing/retainers.ts";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { created, unprocessable } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";
import { idempotentResourcingCreate } from "../_idempotent";
import { findUnownedCustomReferences, loadFieldDefs, unknownCustomFieldKey, validateCustomValues } from "@/lib/custom-fields";

const Body = z.object({
  projectId: z.string().uuid(),
  customerPartyId: z.string().uuid(),
  kind: z.enum(["hours", "fees"]),
  currency: z.string().length(3).transform((value) => value.toUpperCase()).optional(),
  totalAmount: z.string().optional(),
  totalHours: z.string().optional(),
  unitRate: z.string().optional(),
  startsOn: z.string(),
  endsOn: z.string(),
  retainerItemId: z.string().uuid(),
  custom: z.record(z.string(), z.unknown()).optional(),
}).strict();
const Params = z.object({}).strict();

export const POST = defineRoute({
  permission: "retainers.manage",
  feature: "retainerBilling",
  params: Params,
  body: Body,
  handler: async ({ request, authz, body: routeBody }) => {
    const defs = await loadFieldDefs("res_retainers");
    const unknownKey = unknownCustomFieldKey(defs, routeBody.custom ?? {});
    if (unknownKey !== null) {
      return unprocessable("invalid_custom_fields", {
        field: "custom",
        fieldErrors: { [unknownKey]: [`unknown custom field: ${unknownKey}`] },
      });
    }
    const validated = validateCustomValues(defs, routeBody.custom ?? {});
    if (!validated.ok) {
      return unprocessable("invalid_custom_fields", {
        field: "custom",
        fieldErrors: Object.fromEntries(Object.entries(validated.errors).map(([key, message]) => [key, [message]])),
      });
    }
    const unowned = await findUnownedCustomReferences(authz.user.orgId, defs, routeBody.custom ?? {});
    if (unowned.length > 0) return unprocessable("unknown_custom_reference", { field: "custom" });
    const body = { ...routeBody, custom: validated.cleaned };
    return withOrgTransaction(authz.user.orgId, async () => {
      const match = { ...body };
      const row = await idempotentResourcingCreate({
        orgId: authz.user.orgId,
        request,
        table: "res_retainers",
        match,
        create: (id, requestId, savedMatch) => createRetainer({
          ...body,
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        }, { id, requestId, match: savedMatch }),
        load: async () => (await db.select().from(resRetainers).where(and(
          eq(resRetainers.orgId, authz.user.orgId),
          eq(resRetainers.id, request.headers.get("Idempotency-Key")!.trim()),
        )).limit(1))[0] ?? null,
      });
      return created(row);
    });
  },
});
