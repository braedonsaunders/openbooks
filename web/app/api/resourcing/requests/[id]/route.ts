import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { projects, resRequests } from "@openbooks/schema";
import { updateResourceRequestDraft } from "@openbooks/engine/src/resourcing/requests.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { defineRoute } from "@/lib/api/route";
import { findUnownedCustomReferences, loadFieldDefs, unknownCustomFieldKey, validateCustomValues } from "@/lib/custom-fields";

const Params = z.object({ id: z.string().uuid() }).strict();
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

export const PATCH = defineRoute({
  permission: "resourcing.manage",
  feature: "resourceRequests",
  params: Params,
  body: Body,
  handler: async ({ authz, params, body }) => {
    let custom: Record<string, unknown> | undefined;
    if (body.custom !== undefined) {
      const subsidiaryScope = authz.allowedSubsidiaryIds === null
        ? undefined
        : inArray(projects.subsidiaryId, [...authz.allowedSubsidiaryIds]);
      const existing = (await db.select({ custom: resRequests.custom }).from(resRequests).innerJoin(projects, and(
        eq(projects.orgId, resRequests.orgId),
        eq(projects.id, resRequests.projectId),
      )).where(and(
        eq(resRequests.orgId, authz.user.orgId),
        eq(resRequests.id, params.id),
        subsidiaryScope,
      )).limit(1))[0];
      const existingCustom = (existing?.custom ?? {}) as Record<string, unknown>;
      const definitions = await loadFieldDefs("res_requests");
      const unknownKey = unknownCustomFieldKey(definitions, body.custom);
      if (unknownKey) {
        return Response.json({
          error: `unknown custom field: ${unknownKey}`,
          field: "custom",
          fieldErrors: { [unknownKey]: [`Unknown custom field: ${unknownKey}`] },
        }, { status: 422 });
      }
      const validatedCustom = validateCustomValues(definitions, { ...existingCustom, ...body.custom });
      if (!validatedCustom.ok) {
        return Response.json({
          error: "invalid_custom_fields",
          field: "custom",
          fieldErrors: Object.fromEntries(Object.entries(validatedCustom.errors).map(([key, message]) => [key, [message]])),
        }, { status: 422 });
      }
      const unowned = await findUnownedCustomReferences(authz.user.orgId, definitions, body.custom);
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
      const mergedCustom: Record<string, unknown> = { ...existingCustom };
      for (const definition of definitions) delete mergedCustom[definition.key];
      Object.assign(mergedCustom, validatedCustom.cleaned);
      custom = mergedCustom;
    }
    return Response.json(await updateResourceRequestDraft({
      ...body,
      ...(custom === undefined ? {} : { custom }),
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      requestId: params.id,
    }));
  },
});
