import {
  customFieldVisible,
  redactHiddenCustomValues,
  type CustomFieldViewer,
} from "@openbooks/engine/records/custom-fields";

export interface CustomFieldAccessDefinition {
  key: string;
  config: { allowedRoles?: unknown } | null | undefined;
}

export function redactRecordCustomValues<T extends Record<string, unknown>>(
  row: T,
  definitions: readonly CustomFieldAccessDefinition[],
  viewer: CustomFieldViewer,
): T {
  if (!("custom" in row)) return row;
  return {
    ...row,
    custom: redactHiddenCustomValues(
      definitions,
      viewer,
      row.custom as Record<string, unknown> | null,
    ),
  };
}

export function filterVisibleCustomFields<T extends { name: string; custom?: boolean }>(
  fields: readonly T[],
  definitions: readonly CustomFieldAccessDefinition[],
  viewer: CustomFieldViewer,
): T[] {
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
  return fields.filter((field) => {
    if (!field.custom || !field.name.startsWith("cf_")) return true;
    const definition = byKey.get(field.name.slice(3));
    return definition !== undefined && customFieldVisible(definition, viewer);
  });
}
