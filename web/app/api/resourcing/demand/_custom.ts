import {
  findUnownedCustomReferences,
  loadFieldDefs,
  unknownCustomFieldKey,
  validateCustomValues,
} from "@/lib/custom-fields";

export async function validateDemandCustomValues(
  orgId: string,
  supplied: Record<string, unknown> | undefined,
  existing: Record<string, unknown> = {},
): Promise<{ cleaned: Record<string, unknown> } | Response> {
  const definitions = await loadFieldDefs("res_demand_lines");
  const provided = supplied ?? {};
  const unknownKey = unknownCustomFieldKey(definitions, provided);
  if (unknownKey) {
    return Response.json({ error: `unknown custom field: ${unknownKey}` }, { status: 422 });
  }
  const validated = validateCustomValues(definitions, { ...existing, ...provided });
  if (!validated.ok) {
    return Response.json({
      error: "invalid_custom_fields",
      errors: validated.errors,
    }, { status: 422 });
  }
  const unowned = await findUnownedCustomReferences(orgId, definitions, provided);
  if (unowned.length > 0) {
    const errors = Object.fromEntries(unowned.map((definition) => [
      definition.key,
      `${definition.label} must reference a record in this organization`,
    ]));
    return Response.json({ error: "unknown_custom_reference", errors }, { status: 422 });
  }
  const declaredKeys = new Set(definitions.map((definition) => definition.key));
  const retained = Object.fromEntries(
    Object.entries(existing).filter(([key]) => !declaredKeys.has(key)),
  );
  return { cleaned: { ...retained, ...validated.cleaned } };
}
