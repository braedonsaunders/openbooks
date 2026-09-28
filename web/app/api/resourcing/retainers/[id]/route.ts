import { z } from "zod";
import { loadRetainerForUpdate, updateRetainerDraft } from "@openbooks/engine/src/resourcing/retainers.ts";
import { ResourcingRefusal } from "@openbooks/engine/src/resourcing/errors.ts";
import { withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { defineRoute } from "@/lib/api/route";
import { unprocessable } from "@/lib/api/responses";
import { findUnownedCustomReferences, loadFieldDefs, unknownCustomFieldKey, validateCustomValues } from "@/lib/custom-fields";

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({
  projectId: z.string().uuid().optional(),
  customerPartyId: z.string().uuid().optional(),
  kind: z.enum(["hours", "fees"]).optional(),
  currency: z.string().length(3).transform((value) => value.toUpperCase()).optional(),
  totalAmount: z.string().optional(),
  totalHours: z.string().nullable().optional(),
  unitRate: z.string().nullable().optional(),
  startsOn: z.string().optional(),
  endsOn: z.string().optional(),
  retainerItemId: z.string().uuid().optional(),
  custom: z.record(z.string(), z.json()).optional(),
}).strict().refine((value) => Object.keys(value).length > 0 && Object.values(value).some((field) => field !== undefined),
  "Supply at least one retainer field to update.");

export const PATCH = defineRoute({
  permission: "retainers.manage",
  feature: "retainerBilling",
  params: Params,
  body: Body,
  handler: async ({ authz, params: { id }, body }) => withOrgTransaction(authz.user.orgId, async () => {
    const input = {
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      retainerId: id,
    };
    const current = await loadRetainerForUpdate(input);
    if (current.state !== "draft") {
      throw new ResourcingRefusal(409, "retainer_not_editable", `a ${current.state} retainer cannot be edited`, "edit a draft retainer before invoicing it", "retainerId");
    }
    if (current.invoiceDocumentId !== null) {
      throw new ResourcingRefusal(409, "retainer_invoice_linked", "a retainer with a linked invoice cannot be edited", "delete the draft invoice before changing retainer terms", "retainerId");
    }
    const defs = await loadFieldDefs("res_retainers");
    const existingCustom = isRecord(current.custom) ? current.custom : {};
    const suppliedCustom = body.custom ?? {};
    const unknownKey = unknownCustomFieldKey(defs, suppliedCustom);
    if (unknownKey !== null) {
      return unprocessable("invalid_custom_fields", {
        field: "custom",
        fieldErrors: { [unknownKey]: [`unknown custom field: ${unknownKey}`] },
      });
    }
    const validation = validateCustomValues(defs, { ...existingCustom, ...suppliedCustom });
    if (!validation.ok) {
      return unprocessable("invalid_custom_fields", {
        field: "custom",
        fieldErrors: Object.fromEntries(Object.entries(validation.errors).map(([key, message]) => [key, [message]])),
      });
    }
    const unowned = await findUnownedCustomReferences(authz.user.orgId, defs, suppliedCustom);
    if (unowned.length > 0) return unprocessable("unknown_custom_reference", { field: "custom" });

    const declared = new Set(defs.map((definition) => definition.key));
    const removedDefinitionValues = Object.fromEntries(
      Object.entries(existingCustom).filter(([key]) => !declared.has(key)),
    );
    const custom = { ...removedDefinitionValues, ...validation.cleaned };
    const updated = await updateRetainerDraft({ ...input, ...body, custom });
    return Response.json(updated);
  }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
