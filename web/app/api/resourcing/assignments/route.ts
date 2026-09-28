import { z } from "zod";
import { upsertAssignment } from "@openbooks/engine/src/resourcing/assignments.ts";
import { defineRoute } from "@/lib/api/route";
import { findUnownedCustomReferences, loadFieldDefs, unknownCustomFieldKey, validateCustomValues } from "@/lib/custom-fields";

const Common = {
  projectId: z.string().uuid(),
  weekStart: z.string(),
  plannedHours: z.string(),
  isBillable: z.boolean().optional(),
  billItemId: z.string().uuid().nullable().optional(),
  projectTaskId: z.string().uuid().nullable().optional(),
  booking: z.enum(["soft", "hard"]).optional(),
  source: z.enum(["manual", "request", "pipeline"]).optional(),
  requestId: z.string().uuid().nullable().optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
};
const Body = z.union([
  z.object({ ...Common, employeePartyId: z.string().uuid() }).strict(),
  z.object({ ...Common, jobTitle: z.string().trim().min(1) }).strict(),
]);

export const POST = defineRoute({
  permission: "resourcing.manage",
  feature: "resourcing",
  body: Body,
  handler: async ({ authz, body }) => {
    const definitions = await loadFieldDefs("res_assignments");
    // A supplied key with no definition would be stripped silently below, so
    // refuse it by name first. Only the supplied bag is examined: stored keys
    // whose definitions were later removed are never re-examined here, and an
    // omitted custom bag still preserves the stored one in the writer.
    if (body.custom !== undefined) {
      const unknownKey = unknownCustomFieldKey(definitions, body.custom);
      if (unknownKey) {
        return Response.json(
          {
            error: `unknown custom field: ${unknownKey}`,
            remedy: "remove the key or define it in Admin → Custom Fields",
          },
          { status: 422 },
        );
      }
    }
    const custom = validateCustomValues(definitions, body.custom);
    if (!custom.ok) {
      return Response.json(
        { error: "invalid_custom_fields", fields: custom.errors },
        { status: 422 },
      );
    }
    const unownedReferences = await findUnownedCustomReferences(
      authz.user.orgId,
      definitions,
      custom.cleaned,
    );
    if (unownedReferences.length > 0) {
      return Response.json({
        error: "invalid_custom_fields",
        fields: Object.fromEntries(unownedReferences.map((field) => [
          field.key,
          `${field.label} must reference a record in this organization`,
        ])),
      }, { status: 422 });
    }
    const result = await upsertAssignment({
      ...body,
      custom: custom.cleaned,
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    });
    return Response.json(result);
  },
});
