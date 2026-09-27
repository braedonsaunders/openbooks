import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { resRequests } from "@openbooks/schema";
import { createResourceRequest } from "@openbooks/engine/src/resourcing/requests.ts";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { created } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";
import { findUnownedCustomReferences, loadFieldDefs, unknownCustomFieldKey, validateCustomValues } from "@/lib/custom-fields";
import { idempotentResourcingCreate } from "../_idempotent";

const Common = {
  projectId: z.string().uuid(),
  firstWeek: z.string(),
  lastWeek: z.string(),
  hoursPerWeek: z.string(),
  isBillable: z.boolean().optional(),
  billItemId: z.string().uuid().nullable().optional(),
  reason: z.string().nullable().optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
};
const Body = z.union([
  z.object({ ...Common, employeePartyId: z.string().uuid() }).strict(),
  z.object({ ...Common, jobTitle: z.string().trim().min(1) }).strict(),
]);
const Params = z.object({}).strict();

export const POST = defineRoute({
  permission: "resourcing.manage",
  feature: "resourceRequests",
  params: Params,
  body: Body,
  handler: async ({ request, authz, body }) => withOrgTransaction(authz.user.orgId, async () => {
    const definitions = await loadFieldDefs("res_requests");
    const unknownKey = unknownCustomFieldKey(definitions, body.custom ?? {});
    if (unknownKey) {
      return Response.json({
        error: `unknown custom field: ${unknownKey}`,
        field: "custom",
        fieldErrors: { [unknownKey]: [`Unknown custom field: ${unknownKey}`] },
      }, { status: 422 });
    }
    const validatedCustom = validateCustomValues(definitions, body.custom ?? {});
    if (!validatedCustom.ok) {
      return Response.json({
        error: "invalid_custom_fields",
        field: "custom",
        fieldErrors: Object.fromEntries(Object.entries(validatedCustom.errors).map(([key, message]) => [key, [message]])),
      }, { status: 422 });
    }
    const unowned = await findUnownedCustomReferences(authz.user.orgId, definitions, body.custom ?? {});
    if (unowned.length > 0) {
      return Response.json({
        error: "unknown_custom_reference",
        field: "custom",
        fieldErrors: Object.fromEntries(unowned.map((definition) => [
          definition.key,
          [`${definition.label} references a record that is not available in this organization`],
        ])),
      }, { status: 422 });
    }
    const custom = validatedCustom.cleaned;
    const match = { ...body, custom };
    const row = await idempotentResourcingCreate({
      orgId: authz.user.orgId,
      request,
      table: "res_requests",
      match,
      create: (id, requestId, savedMatch) => createResourceRequest({
        ...body,
        custom,
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      }, { id, requestId, match: savedMatch }),
      load: async () => (await db.select().from(resRequests).where(and(
        eq(resRequests.orgId, authz.user.orgId),
        eq(resRequests.id, request.headers.get("Idempotency-Key")!.trim()),
      )).limit(1))[0] ?? null,
    });
    return created(row);
  }),
});
