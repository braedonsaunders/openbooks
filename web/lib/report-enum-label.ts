/** The slice of a next-intl translator scoped to the `reports` namespace that enum labels need. */
export type ReportEnumTranslator = {
  (key: string): string;
  has(key: string): boolean;
};

/**
 * Display label of a report enum value. The same stored value can mean
 * different things in different sources (a CRM activity "note" is not a
 * convertible note), so a source column's own label under
 * `catalog.columnValues.<entity>.<column>.<value>` wins over the shared
 * `catalog.enumValues.<value>`. Returns null when the catalog has neither,
 * leaving the caller's humanized fallback.
 */
export function reportEnumLabel(
  t: ReportEnumTranslator,
  value: string,
  scope?: { entity: string; column: string },
): string | null {
  if (scope) {
    const scoped = `catalog.columnValues.${scope.entity}.${scope.column}.${value}`;
    if (t.has(scoped)) return t(scoped);
  }
  const shared = `catalog.enumValues.${value}`;
  return t.has(shared) ? t(shared) : null;
}
